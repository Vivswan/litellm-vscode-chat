import * as l10n from "@vscode/l10n";
import type OpenAI from "openai";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import type { UnservedEndpointEvidence } from "../../shared/errorClassification";
import { classificationOf, errorMessageText } from "../../shared/logger";
import { displayUrl } from "../../shared/util/displayUrl";
import { collapseWhitespace } from "../../shared/util/errorText";
import { isRecord } from "../../shared/util/json";
import { normalizeCostPerToken, normalizePositiveNumber } from "../../shared/util/numbers";
import { MODEL_INFO_PATH, MODELS_PATH, modelInfoUrl, modelsUrl } from "../transport/clients";
import { mapSdkError, RequestError, timeoutRequestError } from "../transport/errorMapping";
import { collapseTokenConstraints, reportedLimits } from "./modelCatalog";
import { reasoningEffortLevelsFromFlags } from "./modelConfiguration";
import type {
	LiteLLMArchitecture,
	LiteLLMModelInfoItem,
	LiteLLMModelItem,
	LiteLLMProvider,
	RawModelItem,
} from "./schemas";
import { providerEntrySchema, rawModelInfoItemSchema, rawModelItemSchema, supportsTools } from "./schemas";

/**
 * The retry budget for discovery GETs: idempotent, so retrying is safe; chat
 * completions never retry. auth.ts reuses this for the OAuth token exchange.
 */
export const DISCOVERY_MAX_RETRIES = 2;

/** Accept an entry shaped like a models-listing item; /v1/models items omit `providers`. */
export function isLiteLLMModelItem(value: unknown): value is RawModelItem {
	return rawModelItemSchema.safeParse(value).success;
}

/**
 * Parse a /v1/model/info entry, which needs at least one usable model
 * identifier. Malformed fields degrade to undefined rather than dropping the
 * entry.
 */
export function parseModelInfoItem(value: unknown): LiteLLMModelInfoItem | undefined {
	const parsed = rawModelInfoItemSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function isProviderEntry(value: unknown): value is LiteLLMProvider {
	return providerEntrySchema.safeParse(value).success;
}

/** The four long-context cost fields discovery synthesizes onto a provider. */
type LongContextCosts = Pick<
	LiteLLMProvider,
	| "long_context_input_cost_per_token"
	| "long_context_output_cost_per_token"
	| "long_context_cache_read_input_token_cost"
	| "long_context_cache_creation_input_token_cost"
>;

/** The LiteLLM base cost key behind each synthesized field; tiered wire keys suffix these with _above_<N>k_tokens. */
const LONG_CONTEXT_FIELDS = {
	long_context_input_cost_per_token: "input_cost_per_token",
	long_context_output_cost_per_token: "output_cost_per_token",
	long_context_cache_read_input_token_cost: "cache_read_input_token_cost",
	long_context_cache_creation_input_token_cost: "cache_creation_input_token_cost",
} as const satisfies Record<keyof LongContextCosts, string>;

const TIERED_COST_KEY = new RegExp(`^(${Object.values(LONG_CONTEXT_FIELDS).join("|")})_above_(\\d+)k_tokens$`);

/** The 8 per-token cost fields discovery authors onto every provider entry. */
type ServerCosts = Pick<
	LiteLLMProvider,
	| "input_cost_per_token"
	| "output_cost_per_token"
	| "cache_read_input_token_cost"
	| "cache_creation_input_token_cost"
	| keyof LongContextCosts
>;

/** Every ServerCosts field explicitly absent, so spreading it still overrides look-alike pass-through keys. */
const NO_SERVER_COSTS: ServerCosts = {
	input_cost_per_token: undefined,
	output_cost_per_token: undefined,
	cache_read_input_token_cost: undefined,
	cache_creation_input_token_cost: undefined,
	long_context_input_cost_per_token: undefined,
	long_context_output_cost_per_token: undefined,
	long_context_cache_read_input_token_cost: undefined,
	long_context_cache_creation_input_token_cost: undefined,
};

/**
 * The one reading of a server report's cost fields, shared by both mapping
 * sites (/v1/models provider entries and /v1/model/info entries). LiteLLM
 * stamps input/output_cost_per_token: 0 onto entries that declare no pricing
 * at all, so a raw ZERO PAIR maps every cost field to undefined right here at
 * ingest: downstream, a present server cost means declared by construction,
 * and no consumer re-detects the stamp. A user-written 0/0 capability record
 * still prices as genuinely free - records never pass through this mapping.
 * Models genuinely priced 0/0 by the server lose their $0 display under this
 * rule; behind LiteLLM that shape is indistinguishable from the stamp, and
 * unknown-as-free is the worse failure. All fields come back explicitly
 * (undefined when absent) so spreading the result always overrides look-alike
 * keys on lenient pass-through entries.
 */
function serverCostsOf(entry: unknown): ServerCosts {
	const record = isRecord(entry) ? entry : {};
	const input = normalizeCostPerToken(record.input_cost_per_token);
	const output = normalizeCostPerToken(record.output_cost_per_token);
	if (input === 0 && output === 0) {
		return NO_SERVER_COSTS;
	}
	return {
		input_cost_per_token: input,
		output_cost_per_token: output,
		cache_read_input_token_cost: normalizeCostPerToken(record.cache_read_input_token_cost),
		cache_creation_input_token_cost: normalizeCostPerToken(record.cache_creation_input_token_cost),
		...longContextCosts(entry),
	};
}

/**
 * Read a model's long-context tier costs from LiteLLM's threshold-suffixed
 * keys, e.g. input_cost_per_token_above_200k_tokens. VS Code's pricing
 * metadata has exactly one long-context tier, so when a model declares more
 * than one threshold the lowest wins (the first boundary a growing prompt
 * crosses) and only fields declared at that threshold are reported. Only keys
 * holding a usable cost participate in the selection, so a tier declared
 * entirely in malformed values cannot mask a well-formed higher one. All four
 * fields come back explicitly (undefined when absent) so spreading the result
 * always overrides look-alike keys on lenient pass-through entries.
 */
function longContextCosts(entry: unknown): LongContextCosts {
	const tiered: { threshold: number; baseKey: string; cost: number }[] = [];
	if (isRecord(entry)) {
		for (const [key, value] of Object.entries(entry)) {
			const match = TIERED_COST_KEY.exec(key);
			const cost = match ? normalizeCostPerToken(value) : undefined;
			if (match?.[1] !== undefined && match[2] !== undefined && cost !== undefined) {
				tiered.push({ threshold: Number(match[2]), baseKey: match[1], cost });
			}
		}
	}
	const lowest = tiered.reduce((min, t) => Math.min(min, t.threshold), Number.POSITIVE_INFINITY);
	const costAt = (baseKey: string) => tiered.find((t) => t.threshold === lowest && t.baseKey === baseKey)?.cost;
	return {
		long_context_input_cost_per_token: costAt(LONG_CONTEXT_FIELDS.long_context_input_cost_per_token),
		long_context_output_cost_per_token: costAt(LONG_CONTEXT_FIELDS.long_context_output_cost_per_token),
		long_context_cache_read_input_token_cost: costAt(LONG_CONTEXT_FIELDS.long_context_cache_read_input_token_cost),
		long_context_cache_creation_input_token_cost: costAt(
			LONG_CONTEXT_FIELDS.long_context_cache_creation_input_token_cost
		),
	};
}

/** Exported so tests can drive the same /v1/models normalization path production uses. */
export function normalizeModelItem(raw: RawModelItem, log: FetchModelsRequest["log"]): LiteLLMModelItem {
	const providers: LiteLLMProvider[] = [];
	for (const entry of raw.providers ?? []) {
		if (isProviderEntry(entry)) {
			// Pass-through entries keep their raw keys, but every field another
			// stage trusts is authored after the spread: the internal
			// `output_limit_source` marker is cleared so a wire entry cannot forge
			// it, the four token limits are narrowed to positive numbers (numeric
			// strings and null degrade to undefined, so downstream reads take the
			// fields as-is), the 8 costs are authored under the zero-pair rule, and
			// the long-context tier costs are synthesized.
			providers.push({
				...entry,
				output_limit_source: undefined,
				reasoning_effort_levels: reasoningEffortLevelsFromFlags(entry),
				context_length: normalizePositiveNumber(entry.context_length),
				max_tokens: normalizePositiveNumber(entry.max_tokens),
				max_input_tokens: normalizePositiveNumber(entry.max_input_tokens),
				max_output_tokens: normalizePositiveNumber(entry.max_output_tokens),
				...serverCostsOf(entry),
			});
		} else {
			log("Skipping malformed provider entry", { modelId: raw.id, entry: truncateForLog(entry) });
		}
	}
	const [first, ...rest] = providers;
	return {
		id: raw.id,
		shape: first === undefined ? { kind: "bare" } : { kind: "group", providers: [first, ...rest] },
		// The architecture field is read on the same trust basis as the rest of the
		// entry: shape-checked only where registration actually consumes it.
		architecture: raw.architecture as LiteLLMArchitecture | undefined,
	};
}

function truncateForLog(value: unknown): string {
	try {
		return JSON.stringify(value)?.slice(0, 300) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * One /v1/model/info entry after mapping. A dedicated shape (rather than
 * LiteLLMModelItem) so deployment merging can rely on exactly one provider per
 * entry at the type level.
 */
export interface MappedModelInfo {
	id: string;
	provider: LiteLLMProvider;
	inputModalities: readonly string[];
}

/** A non-empty group of mapped entries sharing one model id. */
export type ModelDeployments = readonly [MappedModelInfo, ...MappedModelInfo[]];

/** Exported so tests can build deployment entries through the same parse-and-map path production uses. */
export function mapModelInfoEntry(item: LiteLLMModelInfoItem): MappedModelInfo {
	const toolSupport = item.model_info?.supports_function_calling ?? item.model_info?.supports_tool_choice ?? true;
	const providerName = item.model_info?.litellm_provider ?? "litellm";
	const maxInputTokens = normalizePositiveNumber(item.model_info?.max_input_tokens);
	const maxOutputTokens =
		normalizePositiveNumber(item.model_info?.max_output_tokens) ?? normalizePositiveNumber(item.model_info?.max_tokens);
	const maxTokens =
		normalizePositiveNumber(item.model_info?.max_tokens) ?? normalizePositiveNumber(item.model_info?.max_output_tokens);

	const provider: LiteLLMProvider = {
		provider: providerName,
		status: "ok",
		supports_tools: toolSupport,
		context_length: maxInputTokens ?? maxTokens,
		max_tokens: maxTokens,
		max_input_tokens: maxInputTokens,
		max_output_tokens: maxOutputTokens,
		supports_prompt_caching: item.model_info?.supports_prompt_caching ?? null,
		supports_response_schema: item.model_info?.supports_response_schema ?? null,
		supports_reasoning: item.model_info?.supports_reasoning ?? null,
		supports_pdf_input: item.model_info?.supports_pdf_input ?? null,
		supported_openai_params: item.model_info?.supported_openai_params ?? null,
		reasoning_effort_levels: reasoningEffortLevelsFromFlags(item.model_info) ?? null,
		...serverCostsOf(item.model_info),
	};

	const inputModalities: string[] = [];
	if (item.model_info?.supports_vision === true) {
		inputModalities.push("image");
	}
	if (item.model_info?.supports_pdf_input === true) {
		inputModalities.push("pdf");
	}
	if (item.model_info?.supports_audio_input === true) {
		inputModalities.push("audio");
	}

	return { id: item.modelId, provider, inputModalities };
}

function toModelItem(mapped: MappedModelInfo): LiteLLMModelItem {
	return {
		id: mapped.id,
		shape: { kind: "deployment", provider: mapped.provider },
		architecture: mapped.inputModalities.length > 0 ? { input_modalities: [...mapped.inputModalities] } : undefined,
	};
}

/** Three-valued AND: false if any deployment says no, true only if all say yes, unknown otherwise. */
function everyDeploymentSupports(values: readonly (boolean | null | undefined)[]): boolean | null {
	if (values.some((value) => value === false)) {
		return false;
	}
	return values.every((value) => value === true) ? true : null;
}

/** The params every deployment lists; unknown (null) as soon as one deployment does not list them. */
function intersectSupportedParams(values: readonly (string[] | null | undefined)[]): string[] | null {
	const [first, ...rest] = values;
	if (!Array.isArray(first) || rest.some((list) => !Array.isArray(list))) {
		return null;
	}
	return first.filter((param) => rest.every((list) => Array.isArray(list) && list.includes(param)));
}

/** The cost every deployment advertises identically; unknown (null) as soon as one differs or omits it. */
function agreedCost(values: readonly (number | null | undefined)[]): number | null {
	const [first, ...rest] = values;
	return typeof first === "number" && rest.every((value) => value === first) ? first : null;
}

/**
 * Collapse the deployments of one load-balanced model_name into a single entry
 * advertising the conservative intersection of their capabilities. LiteLLM
 * reports one /v1/model/info entry per deployment, so without this a
 * load-balanced model would register duplicate ids and overwrite its own routes.
 *
 * Token limits collapse through collapseTokenConstraints, and a field is stored
 * ONLY when some deployment reported it: a floor-filled number stored as if
 * reported would occupy the capability walk's server level and block catalog
 * backfill. The input limit is stored whenever ANY limit was reported, because
 * re-deriving it from the collapsed pair can overstate it. outputLimitSource
 * records whether the stored output limit counts as server-declared, so a
 * floor-filled contributor cannot launder its guess into a declared limit.
 *
 * Capability flags hold only when every deployment advertises them; modalities
 * and the param lists intersect. Pricing carries over only when every
 * deployment advertises the identical per-field cost - routing decides which
 * deployment serves a request, so advertising either differing number would lie.
 * Two deployments that both carried LiteLLM's 0/0 no-pricing stamp cannot
 * false-agree into declared-free here: serverCostsOf already mapped each
 * stamped pair to undefined at ingest, and agreedCost reads undefined as no
 * declaration. Non-constraint metadata follows the first deployment, so a
 * merged model's family is its first deployment's litellm_provider.
 */
export function mergeModelDeployments(deployments: ModelDeployments): MappedModelInfo {
	const [first, ...rest] = deployments;
	if (rest.length === 0) {
		return first;
	}
	const providers: [LiteLLMProvider, ...LiteLLMProvider[]] = [
		first.provider,
		...rest.map((deployment) => deployment.provider),
	];
	const collapsed = collapseTokenConstraints(providers);
	const reported = reportedLimits(providers);
	const provider: LiteLLMProvider = {
		provider: first.provider.provider,
		status: first.provider.status,
		supports_tools: providers.every(supportsTools),
		context_length: reported.context ? collapsed.contextLength : undefined,
		max_tokens: reported.output ? collapsed.maxOutputTokens : undefined,
		max_input_tokens: reported.any ? collapsed.maxInputTokens : undefined,
		max_output_tokens: reported.output ? collapsed.maxOutputTokens : undefined,
		output_limit_source: collapsed.outputLimitSource,
		supports_prompt_caching: everyDeploymentSupports(providers.map((p) => p.supports_prompt_caching)),
		supports_response_schema: everyDeploymentSupports(providers.map((p) => p.supports_response_schema)),
		supports_reasoning: everyDeploymentSupports(providers.map((p) => p.supports_reasoning)),
		supports_pdf_input: everyDeploymentSupports(providers.map((p) => p.supports_pdf_input)),
		supported_openai_params: intersectSupportedParams(providers.map((p) => p.supported_openai_params)),
		reasoning_effort_levels: intersectSupportedParams(providers.map((p) => p.reasoning_effort_levels)),
		input_cost_per_token: agreedCost(providers.map((p) => p.input_cost_per_token)),
		output_cost_per_token: agreedCost(providers.map((p) => p.output_cost_per_token)),
		cache_read_input_token_cost: agreedCost(providers.map((p) => p.cache_read_input_token_cost)),
		cache_creation_input_token_cost: agreedCost(providers.map((p) => p.cache_creation_input_token_cost)),
		long_context_input_cost_per_token: agreedCost(providers.map((p) => p.long_context_input_cost_per_token)),
		long_context_output_cost_per_token: agreedCost(providers.map((p) => p.long_context_output_cost_per_token)),
		long_context_cache_read_input_token_cost: agreedCost(
			providers.map((p) => p.long_context_cache_read_input_token_cost)
		),
		long_context_cache_creation_input_token_cost: agreedCost(
			providers.map((p) => p.long_context_cache_creation_input_token_cost)
		),
	};
	const inputModalities = first.inputModalities.filter((modality) =>
		rest.every((deployment) => deployment.inputModalities.includes(modality))
	);
	return { id: first.id, provider, inputModalities };
}

export interface FetchModelsResult {
	models: LiteLLMModelItem[];
	/**
	 * The sorted union of model_info keys observed across the /model/info
	 * items, present ONLY when that listing succeeded (absent on the /models
	 * fallback and on failure): downstream advisory hints must be able to tell
	 * "the server reports these fields" from "nothing was observed". Collected
	 * from the RAW entries, before parsing and the blocked/non-chat filters,
	 * and capped at OBSERVED_MODEL_INFO_KEYS_MAX after the sort.
	 */
	observedModelInfoKeys?: readonly string[];
	/**
	 * Present when the model-info probe failed like an unserved endpoint (timed
	 * out, or answered 404/405) while the /models fallback succeeded in the same
	 * pass, and the entry did NOT declare the failure expected: the server works
	 * without LiteLLM's model-info endpoint, so declaring
	 * expectedFailures: ["modelInfo"] fits better than raising the timeout.
	 * Advisory only - the pass succeeded and the models serve either way.
	 */
	modelInfoUnsupported?: UnservedEndpointEvidence;
}

/**
 * Per endpoint: an expected endpoint gets exactly one attempt, and the
 * nonfatal /model/info fallback log carries the "(expected)" classification.
 * Only a /models failure aborts discovery, expected or not.
 */
export interface ExpectedDiscoveryFailures {
	readonly modelInfo: boolean;
	readonly modelListing: boolean;
}

export interface FetchModelsRequest {
	/** Transport for this server, from clients.ts; static auth and headers live there. */
	client: OpenAI;
	baseUrl: string;
	/**
	 * The entry's apiVersion override the client was built with, so the logged
	 * endpoint URLs match the client's real API root; "" and undefined follow
	 * apiRootOf's rules. Required so a caller cannot build the client on an
	 * overridden root and silently log the auto one.
	 */
	apiVersion: string | undefined;
	/** Pre-validated by settings.getDiscoveryTimeout(); used as-is. */
	discoveryTimeout: number;
	/** Failure categories the server's entry declares expected; see ExpectedDiscoveryFailures. */
	expected?: ExpectedDiscoveryFailures;
	/**
	 * The declared entry's label, when the server has one, so the
	 * endpoint-unserved hints can name the entry the declaration belongs on.
	 * Empty means "no nameable entry" like undefined does. Never used for
	 * matching here.
	 */
	entryLabel?: string | undefined;
	/** Per-request headers resolved by the caller, e.g. a freshly exchanged OAuth bearer token. */
	headers?: Record<string, string>;
	log: (message: string, data?: unknown) => void;
}

function extractDataArray(parsed: unknown): unknown[] {
	return isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
}

/**
 * The English classification both unparseable-payload sites record instead
 * of their (localized, snippet-embedding) messages; the /v1/models fallback
 * rethrow keys on it rather than matching message text.
 */
const UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION = "RequestError(http, unparseable models response body)";

/** Cap on the parser reason quoted in the user-facing detail line; the full error stays on the cause. */
const UNPARSEABLE_REASON_MAX_LENGTH = 100;

/**
 * The one constructor for both unparseable-payload sites, so their
 * classification, display message, and English mirror cannot drift apart.
 * V8's SyntaxError message quotes a snippet of the unparseable payload
 * (response-derived), so the classification keeps it off public surfaces
 * while the user-facing detail line keeps the diagnostic value.
 */
function unparseableModelsResponse(endpointUrl: string, reason: string, cause: unknown): RequestError {
	// The reason quotes the payload verbatim, newlines included; collapsing
	// keeps the detail one physical line under the headline.
	const detail = `Unparseable response from ${displayUrl(endpointUrl)}: ${collapseWhitespace(reason).slice(
		0,
		UNPARSEABLE_REASON_MAX_LENGTH
	)}`;
	return new RequestError(
		`${l10n.t(
			"The server replied, but not with a model list - this address may not be a LiteLLM proxy. Check the base URL: the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2; LiteLLM's default port is 4000."
		)}\n${detail}`,
		"http",
		{
			cause,
			logClassification: UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION,
			englishMessage: `The server replied, but not with a model list - this address may not be a LiteLLM proxy. Check the base URL: the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2; LiteLLM's default port is 4000.\n${detail}`,
		}
	);
}

/**
 * The SDK only parses JSON when the response advertises a JSON content type;
 * anything else arrives as a string. Servers that return JSON with a missing
 * or wrong content-type header still work, so a string payload gets one
 * JSON.parse attempt here.
 */
function coerceJsonPayload(value: unknown, endpointUrl: string): unknown {
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		throw unparseableModelsResponse(endpointUrl, errorMessageText(error), error);
	}
}

/** How the model-info probe's failure looked, for the /models leg's same-pass verdict. */
type EndpointFailureEvidence = { kind: "timeout" } | { kind: "status"; status: 404 | 405 };

/**
 * Only a timeout or an HTTP 404/405 proves an endpoint is unserved. Anything
 * else - auth, network, 5xx, unparseable payloads - proves nothing and yields
 * undefined.
 */
function unservedEvidenceOf(mapped: Error): EndpointFailureEvidence | undefined {
	if (!(mapped instanceof RequestError)) {
		return undefined;
	}
	if (mapped.kind === "timeout") {
		return { kind: "timeout" };
	}
	if (mapped.kind === "http" && (mapped.status === 404 || mapped.status === 405)) {
		return { kind: "status", status: mapped.status };
	}
	return undefined;
}

/** One evidence rendering for the English detail lines: "timed out after 30000ms" / "answered HTTP 404". */
function evidenceText(evidence: EndpointFailureEvidence, timeoutMs: number): string {
	return evidence.kind === "timeout" ? `timed out after ${timeoutMs}ms` : `answered HTTP ${evidence.status}`;
}

/** The RequestError kind/status pair an evidence shape maps back onto, so refined errors keep their transport taxonomy. */
function evidenceKind(evidence: EndpointFailureEvidence): {
	kind: "timeout" | "http";
	status?: number;
	token: string;
} {
	return evidence.kind === "timeout"
		? { kind: "timeout", token: "timeout" }
		: { kind: "http", status: evidence.status, token: `http, status ${evidence.status}` };
}

/** What the model-info probe did this pass, as the /models leg's refinement context. */
interface ModelInfoProbeOutcome {
	/** The probe got an HTTP response it could read (even one that fell back for lacking usable models). */
	answered: boolean;
	/** How the probe failed, when it failed like an unserved endpoint. */
	evidence: EndpointFailureEvidence | undefined;
}

/** The refinement context both endpoint-unserved constructors read. */
interface ModelsFailureContext {
	modelInfo: ModelInfoProbeOutcome;
	expected: ExpectedDiscoveryFailures | undefined;
	entryLabel: string | undefined;
	baseUrl: string;
	apiVersion: string | undefined;
	timeoutMs: number;
}

/**
 * The models listing failed like an unserved endpoint while model-info
 * answered (or was itself declared expected), so the server is alive and the
 * right move is declaring the listing, not retrying it. Names the entry when
 * the server has one; carries the unsupportedEndpoint classification so the
 * dashboard can offer the declaration as an action.
 */
function modelListingUnservedError(mapped: Error, evidence: EndpointFailureEvidence, ctx: ModelsFailureContext) {
	const { kind, status, token } = evidenceKind(evidence);
	// See FetchModelsRequest.entryLabel: empty means no nameable entry.
	const namedEntry = ctx.entryLabel !== undefined && ctx.entryLabel.length > 0 ? ctx.entryLabel : undefined;
	const headline =
		namedEntry !== undefined
			? l10n.t(
					'The models listing failed, but this server answers. If it never serves the models listing, declare that on the "{0}" entry: "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".',
					namedEntry
				)
			: l10n.t(
					'The models listing failed, but this server answers. If it never serves the models listing, add an entry for it in the "{0}" setting declaring "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".',
					`${CONFIG_SECTION}.servers`
				);
	const englishHeadline =
		namedEntry !== undefined
			? `The models listing failed, but this server answers. If it never serves the models listing, declare that on the "${namedEntry}" entry: "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".`
			: `The models listing failed, but this server answers. If it never serves the models listing, add an entry for it in the "${CONFIG_SECTION}.servers" setting declaring "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".`;
	const detail = `GET ${displayUrl(modelsUrl(ctx.baseUrl, ctx.apiVersion))} ${evidenceText(evidence, ctx.timeoutMs)}; model info ${
		ctx.modelInfo.answered ? "answered" : "is declared an expected failure"
	}`;
	return new RequestError(`${headline}\n${detail}`, kind, {
		...(status !== undefined ? { status } : {}),
		cause: mapped,
		unsupportedEndpoint: "modelListing",
		logClassification: `RequestError(${token}, discovery, models listing unserved)`,
		englishMessage: `${englishHeadline}\n${detail}`,
	});
}

/**
 * Both discovery endpoints failed like unserved endpoints in one pass, so no
 * per-endpoint declaration can help: this address does not serve an
 * OpenAI-compatible API. Replaces the raise-the-timeout advice a bare timeout
 * would carry - a bigger timeout only makes each refresh slower when the
 * endpoint never answers.
 */
function noEndpointServedError(
	mapped: Error,
	evidence: EndpointFailureEvidence,
	infoEvidence: EndpointFailureEvidence,
	ctx: ModelsFailureContext
) {
	const { kind: errorKind, status, token } = evidenceKind(evidence);
	const baseUrl = displayUrl(ctx.baseUrl);
	// The caller guarantees both evidences share a kind, so the headline must
	// match the detail line right below it, which names what each GET did.
	const headline =
		evidence.kind === "timeout"
			? l10n.t(
					"Neither discovery endpoint answered at {0} - this address does not look like a LiteLLM or OpenAI-compatible API. Check the base URL and port (a LiteLLM proxy defaults to 4000), or put a LiteLLM proxy in front of this server.",
					baseUrl
				)
			: l10n.t(
					"This server does not serve either discovery endpoint at {0} - this address does not look like a LiteLLM or OpenAI-compatible API. Check the base URL and port (a LiteLLM proxy defaults to 4000), or put a LiteLLM proxy in front of this server.",
					baseUrl
				);
	const englishHeadline =
		evidence.kind === "timeout"
			? `Neither discovery endpoint answered at ${baseUrl} - this address does not look like a LiteLLM or OpenAI-compatible API. Check the base URL and port (a LiteLLM proxy defaults to 4000), or put a LiteLLM proxy in front of this server.`
			: `This server does not serve either discovery endpoint at ${baseUrl} - this address does not look like a LiteLLM or OpenAI-compatible API. Check the base URL and port (a LiteLLM proxy defaults to 4000), or put a LiteLLM proxy in front of this server.`;
	const detail = `GET ${MODEL_INFO_PATH} ${evidenceText(infoEvidence, ctx.timeoutMs)}; GET ${MODELS_PATH} ${evidenceText(
		evidence,
		ctx.timeoutMs
	)}`;
	return new RequestError(`${headline}\n${detail}`, errorKind, {
		...(status !== undefined ? { status } : {}),
		cause: mapped,
		setupHint: "check-base-url",
		logClassification: `RequestError(${token}, discovery, no endpoint served)`,
		englishMessage: `${englishHeadline}\n${detail}`,
	});
}

/**
 * The same-pass verdict over a failed models listing: the declaration hint when
 * model-info answered (or is declared expected), the not-OpenAI-compatible
 * verdict when model-info failed the SAME unserved way - mixed evidence does
 * not prove the address serves nothing. A models 404 keeps mapSdkError's
 * discovery 404 message even then, because docs/troubleshooting.md quotes that
 * headline verbatim. Everything else passes through unchanged.
 */
function refineModelsListingFailure(mapped: Error, ctx: ModelsFailureContext): Error {
	const evidence = unservedEvidenceOf(mapped);
	if (evidence === undefined || ctx.expected?.modelListing === true) {
		return mapped;
	}
	if (ctx.modelInfo.answered || ctx.expected?.modelInfo === true) {
		return modelListingUnservedError(mapped, evidence, ctx);
	}
	const infoEvidence = ctx.modelInfo.evidence;
	if (
		infoEvidence !== undefined &&
		infoEvidence.kind === evidence.kind &&
		!(evidence.kind === "status" && evidence.status === 404)
	) {
		return noEndpointServedError(mapped, evidence, infoEvidence, ctx);
	}
	return mapped;
}

/**
 * The SDK's retry backoff sleep does not observe the abort signal, so a
 * server sending a large Retry-After could stall a retried call well past
 * the discovery timeout. Racing the call against its signal restores the
 * hard bound.
 */
function boundedBySignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	// The call may lose the race; its eventual rejection must not surface as unhandled.
	promise.catch(() => {});
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("The operation was aborted"));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			}
		);
	});
}

interface NarrowedModelInfoData {
	models: LiteLLMModelItem[];
	/**
	 * Entries recognized as either payload shape, counted before the blocked
	 * filter. The /v1/models fallback keys on this instead of `models.length`:
	 * a payload whose recognized entries were all blocked must yield an empty
	 * list, not a fallback that re-lists the blocked models.
	 */
	usableEntryCount: number;
	/** See FetchModelsResult.observedModelInfoKeys; sorted and capped here. */
	observedModelInfoKeys: readonly string[];
}

/** Defensive bounds on the observed-key union: sort first, then truncate, and drop (never clip) an oversized key so truncation cannot alias two keys. */
const OBSERVED_MODEL_INFO_KEYS_MAX = 512;
const OBSERVED_MODEL_INFO_KEY_MAX_LENGTH = 128;

/**
 * Modes that provably serve a non-chat endpoint, so they must not register.
 * Deliberately not the inverse (an allow-list of chat modes): an absent or
 * unrecognized mode keeps registering, never losing a model to a vocabulary
 * this extension has not learned yet.
 */
const NON_CHAT_MODES: readonly string[] = [
	"embedding",
	"image_generation",
	"audio_speech",
	"audio_transcription",
	"rerank",
	"moderation",
	// Text-completion models serve /completions, not chat: they are the
	// inline-completions feature's targets and must not appear in the chat
	// picker as models that cannot chat.
	"completion",
];

/**
 * Narrow a /v1/model/info payload element-wise: unrecognized entries are
 * skipped with a log line instead of aborting the whole registration. Blocked
 * (paused) deployments and provably non-chat modes are dropped, and deployments
 * sharing one model id merge in first-seen order.
 */
function narrowModelInfoData(data: unknown[], log: FetchModelsRequest["log"]): NarrowedModelInfoData {
	let usableEntryCount = 0;
	const observedKeys = new Set<string>();
	type Slot =
		| { kind: "deployments"; group: [MappedModelInfo, ...MappedModelInfo[]] }
		| { kind: "model"; model: LiteLLMModelItem };
	const slots: Slot[] = [];
	const deploymentsById = new Map<string, [MappedModelInfo, ...MappedModelInfo[]]>();
	for (const entry of data) {
		// Raw keys, before any parsing: the union covers every entry that carries
		// a model_info object on the wire, malformed and listing-shaped entries
		// included, because the keys were observed either way.
		if (isRecord(entry) && isRecord(entry.model_info)) {
			for (const key of Object.keys(entry.model_info)) {
				if (key.length <= OBSERVED_MODEL_INFO_KEY_MAX_LENGTH) {
					observedKeys.add(key);
				}
			}
		}
		const parsed = parseModelInfoItem(entry);
		if (parsed !== undefined) {
			usableEntryCount += 1;
			if (parsed.model_info?.blocked === true) {
				log("Skipping blocked model/info entry", { modelId: parsed.modelId });
				continue;
			}
			const mode = parsed.model_info?.mode;
			if (mode !== undefined && NON_CHAT_MODES.includes(mode)) {
				// Classification only: the logged mode is always one of the
				// NON_CHAT_MODES constants; the server-provided model id stays out
				// of the issue-report buffer.
				log("Skipping non-chat model/info entry", { mode });
				continue;
			}
			const mapped = mapModelInfoEntry(parsed);
			const group = deploymentsById.get(mapped.id);
			if (group) {
				group.push(mapped);
			} else {
				const newGroup: [MappedModelInfo, ...MappedModelInfo[]] = [mapped];
				deploymentsById.set(mapped.id, newGroup);
				slots.push({ kind: "deployments", group: newGroup });
			}
			continue;
		}
		if (isLiteLLMModelItem(entry)) {
			usableEntryCount += 1;
			slots.push({ kind: "model", model: normalizeModelItem(entry, log) });
			continue;
		}
		log("Skipping malformed model/info entry", { entry: truncateForLog(entry) });
	}
	const models = slots.map((slot) =>
		slot.kind === "deployments" ? toModelItem(mergeModelDeployments(slot.group)) : slot.model
	);
	// Sort-then-slice keeps truncation deterministic but drops the alphabetic
	// TAIL: an over-cap payload can make a really-reported key read as
	// unobserved, letting a spurious unknown-key hint through downstream. The
	// set never gains keys the server did not send.
	const observedModelInfoKeys = [...observedKeys].sort().slice(0, OBSERVED_MODEL_INFO_KEYS_MAX);
	return { models, usableEntryCount, observedModelInfoKeys };
}

export async function fetchModels(request: FetchModelsRequest): Promise<FetchModelsResult> {
	const { client, baseUrl, apiVersion, discoveryTimeout, expected, entryLabel, headers, log } = request;

	log("Fetching from:", modelInfoUrl(baseUrl, apiVersion));

	// What the model-info probe did, for the same-pass verdicts: the /models
	// success return and the /models failure refinement both read it.
	const modelInfo: ModelInfoProbeOutcome = { answered: false, evidence: undefined };
	const infoSignal = AbortSignal.timeout(discoveryTimeout);
	try {
		// The per-request timeout keeps the SDK's own 600 s default from
		// overriding ours; boundedBySignal makes the signal a hard whole-call
		// bound across retries. Retries are safe here (idempotent GET) and stay
		// off for an endpoint whose failure the entry declares expected.
		const parsedInfo: unknown = coerceJsonPayload(
			await boundedBySignal(
				client.get(MODEL_INFO_PATH, {
					signal: infoSignal,
					timeout: discoveryTimeout,
					maxRetries: expected?.modelInfo === true ? 0 : DISCOVERY_MAX_RETRIES,
					headers,
				}),
				infoSignal
			),
			modelInfoUrl(baseUrl, apiVersion)
		);
		// Answered means an HTTP response with a JSON-parseable body, even one
		// that falls back below for lacking usable models; an unparseable body
		// throws above and proves nothing about endpoint support.
		modelInfo.answered = true;
		if (isRecord(parsedInfo) && Array.isArray(parsedInfo.data)) {
			const data: unknown[] = parsedInfo.data;
			log("Parsed model/info response:", { modelCount: data.length });

			const { models, usableEntryCount, observedModelInfoKeys } = narrowModelInfoData(data, log);
			if (data.length > 0 && usableEntryCount === 0) {
				log("model/info returned data but no usable models; falling back", {
					dataLength: data.length,
					firstEntry: truncateForLog(data[0]),
				});
			} else {
				log("Successfully fetched models:", models.length);
				return { models, observedModelInfoKeys };
			}
		} else {
			log("model/info response has no data array; falling back", { payload: truncateForLog(parsedInfo) });
		}
	} catch (error) {
		// Response-derived text can echo credentials into the issue-report buffer,
		// so the log carries only the classification. This is discovery's one
		// expected-failure log seam, because a /model/info failure is nonfatal and
		// never reaches the provider boundary.
		const mapped = mapSdkError(error, { surface: "discovery", baseUrl, timeoutMs: discoveryTimeout });
		// The signal firing IS the timeout evidence even when the mapped error is
		// not classified as one (AbortSignal.timeout's TimeoutError maps to the
		// unhandled tail).
		modelInfo.evidence = infoSignal.aborted ? { kind: "timeout" } : unservedEvidenceOf(mapped);
		const expectedNote = expected?.modelInfo === true ? " (expected: modelInfo)" : "";
		// The `error` field prefers the classification: it names the failure shape
		// where the class name would not, and it is never message text.
		log(`model/info failed, falling back to ${modelsUrl(baseUrl, apiVersion)}${expectedNote}`, {
			error: classificationOf(mapped) ?? mapped.name,
			...(mapped instanceof RequestError
				? { kind: mapped.kind, ...(mapped.status !== undefined ? { status: mapped.status } : {}) }
				: {}),
		});
	}

	log("Fetching from:", modelsUrl(baseUrl, apiVersion));
	const timeoutSignal = AbortSignal.timeout(discoveryTimeout);
	const errorContext = { surface: "discovery" as const, baseUrl, timeoutMs: discoveryTimeout };
	const failureContext: ModelsFailureContext = {
		modelInfo,
		expected,
		entryLabel,
		baseUrl,
		apiVersion,
		timeoutMs: discoveryTimeout,
	};
	let parsed: unknown;
	try {
		parsed = coerceJsonPayload(
			await boundedBySignal(
				client.get(MODELS_PATH, {
					signal: timeoutSignal,
					timeout: discoveryTimeout,
					maxRetries: expected?.modelListing === true ? 0 : DISCOVERY_MAX_RETRIES,
					headers,
				}),
				timeoutSignal
			),
			modelsUrl(baseUrl, apiVersion)
		);
	} catch (error) {
		if (timeoutSignal.aborted) {
			throw refineModelsListingFailure(timeoutRequestError(errorContext, error), failureContext);
		}
		if (error instanceof RequestError && error.logClassification === UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION) {
			throw error;
		}
		if (error instanceof SyntaxError) {
			// The SDK's own response.json() on a malformed application/json body:
			// same leak shape as coerceJsonPayload, same classification.
			throw unparseableModelsResponse(modelsUrl(baseUrl, apiVersion), error.message, error);
		}
		throw refineModelsListingFailure(mapSdkError(error, errorContext), failureContext);
	}
	const data = extractDataArray(parsed);
	log("Parsed response:", { modelCount: data.length });

	const models: LiteLLMModelItem[] = [];
	for (const entry of data) {
		if (isLiteLLMModelItem(entry)) {
			models.push(normalizeModelItem(entry, log));
		} else {
			log("Skipping malformed models entry", { entry: truncateForLog(entry) });
		}
	}
	log("Successfully fetched models:", models.length);
	return {
		models,
		// See FetchModelsResult.modelInfoUnsupported: a declared-expected probe
		// failure is already handled and gets no hint.
		...(modelInfo.evidence !== undefined && expected?.modelInfo !== true
			? { modelInfoUnsupported: modelInfo.evidence.kind }
			: {}),
	};
}
