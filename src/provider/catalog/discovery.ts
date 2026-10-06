import * as l10n from "@vscode/l10n";
import type OpenAI from "openai";
import { APIConnectionError } from "openai";
import { consumedFieldsOfKind } from "../../shared/config/capabilityResolution";
import { CONFIG_SECTION } from "../../shared/config/settingSpec";
import type { UnservedEndpointEvidence } from "../../shared/errorClassification";
import type { NonChatMode, SkippedModeCounts } from "../../shared/serverEntry";
import { isNonChatMode } from "../../shared/serverEntry";
import { isRecord, recordFromKeys } from "../../shared/util/json";
import { normalizeCostPerToken, normalizePositiveNumber } from "../../shared/util/numbers";
import { MODEL_INFO_PATH, MODELS_PATH, modelInfoUrl, modelsUrl } from "../transport/clients";
import { mapSdkError, RequestError, timeoutRequestError } from "../transport/errorMapping";
import { retryIdempotent } from "../transport/retry";
import type { DiscoveryLog } from "./discoveryLog";
import { discoveryLineWriter, failureKindOf, parseWire } from "./discoveryLog";
import { collapseTokenLimits, deriveTokenConstraints, reportedReasoningLevels } from "./modelCatalog";
import { reasoningEffortLevelsFromFlags } from "./modelConfiguration";
import type {
	LiteLLMArchitecture,
	LiteLLMModelInfoItem,
	LiteLLMModelItem,
	LiteLLMProvider,
	LongContextCostField,
	PerTokenCosts,
	RawModelItem,
	TokenConstraints,
} from "./schemas";
import {
	dataEnvelopeSchema,
	isLongContextCostField,
	LONG_CONTEXT_COST_FIELDS,
	LONG_CONTEXT_COST_PREFIX,
	providerEntrySchema,
	rawModelInfoItemSchema,
	rawModelItemSchema,
	supportsTools,
} from "./schemas";

/**
 * The retry budget for discovery GETs: idempotent, so retrying is safe; chat completions never retry. auth.ts reuses
 * this for the OAuth token exchange.
 */
export const DISCOVERY_MAX_RETRIES = 2;

/** A models-listing item. */
export function isLiteLLMModelItem(value: unknown): value is RawModelItem {
	return rawModelItemSchema.safeParse(value).success;
}

/** Parse a /v1/model/info entry, which needs at least one usable model identifier. */
export function parseModelInfoItem(value: unknown): LiteLLMModelInfoItem | undefined {
	const parsed = rawModelInfoItemSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

const COST_FIELDS = consumedFieldsOfKind("cost");

/** The wire key a long-context field tiers; LiteLLM suffixes it with _above_<N>k_tokens per threshold. */
function tieredBaseKey(field: LongContextCostField): string {
	return field.slice(LONG_CONTEXT_COST_PREFIX.length);
}

const TIERED_COST_KEY = new RegExp(`^(${LONG_CONTEXT_COST_FIELDS.map(tieredBaseKey).join("|")})_above_(\\d+)k_tokens$`);

/**
 * The cost fields discovery authors onto every provider entry, each explicitly present so spreading the result
 * overrides look-alike pass-through keys.
 */
type ServerCosts = Readonly<Required<PerTokenCosts>>;

const NO_SERVER_COSTS: ServerCosts = recordFromKeys(COST_FIELDS, () => undefined);

/**
 * LiteLLM stamps input/output_cost_per_token: 0 onto entries that declare no pricing, so this ingest
 * mapping is where the stamp dies and a present server cost downstream means declared.
 *
 *   server 0/0 pair         -> every cost undefined; a genuinely free model loses its $0 display, because
 *                              behind LiteLLM the shapes are indistinguishable and unknown-as-free is worse
 *   user-written 0/0 record -> never passes through here, so it still prices as free
 */
function serverCostsOf(entry: unknown): ServerCosts {
	const record = isRecord(entry) ? entry : {};
	const input = normalizeCostPerToken(record.input_cost_per_token);
	const output = normalizeCostPerToken(record.output_cost_per_token);
	if (input === 0 && output === 0) {
		return NO_SERVER_COSTS;
	}
	const longContextCost = longContextCostsOf(record);
	return recordFromKeys(COST_FIELDS, (field) =>
		isLongContextCostField(field) ? longContextCost(field) : normalizeCostPerToken(record[field])
	);
}

/**
 * VS Code's pricing metadata has one long-context tier, so the lowest declared threshold wins (the first boundary a
 * growing prompt crosses). Only keys holding a usable cost enter the selection, so an all-malformed tier cannot mask a
 * well-formed higher one.
 */
function longContextCostsOf(record: Record<string, unknown>): (field: LongContextCostField) => number | undefined {
	const tiered: { threshold: number; baseKey: string; cost: number }[] = [];
	for (const [key, value] of Object.entries(record)) {
		const match = TIERED_COST_KEY.exec(key);
		const cost = match ? normalizeCostPerToken(value) : undefined;
		if (match?.[1] !== undefined && match[2] !== undefined && cost !== undefined) {
			tiered.push({ threshold: Number(match[2]), baseKey: match[1], cost });
		}
	}
	const lowest = tiered.reduce((min, t) => Math.min(min, t.threshold), Number.POSITIVE_INFINITY);
	return (field) => {
		const baseKey = tieredBaseKey(field);
		return tiered.find((t) => t.threshold === lowest && t.baseKey === baseKey)?.cost;
	};
}

/** Exported so tests can drive the same /v1/models normalization path production uses. */
export function normalizeModelItem(raw: RawModelItem, log: DiscoveryLog): LiteLLMModelItem {
	const providers: LiteLLMProvider[] = [];
	for (const [index, wire] of (raw.providers ?? []).entries()) {
		const provider = parseWire(providerEntrySchema, wire);
		if (provider.success) {
			// providerEntrySchema checks `provider` alone; the other LiteLLMProvider fields are wire pass-throughs read on
			// the same trust basis as the rest of the entry.
			const entry = wire as LiteLLMProvider;
			// Pass-through entries keep their raw keys.
			//   the four token limits       -> are narrowed to positive numbers (numeric strings parse, null and junk
			//                                  degrade to undefined, so downstream reads take the fields as-is)
			//   the costs                   -> are authored under the zero-pair rule
			//   the long-context tier costs -> are synthesized
			providers.push({
				...entry,
				reasoning_effort_levels: reasoningEffortLevelsFromFlags(entry),
				context_length: normalizePositiveNumber(entry.context_length),
				max_tokens: normalizePositiveNumber(entry.max_tokens),
				max_input_tokens: normalizePositiveNumber(entry.max_input_tokens),
				max_output_tokens: normalizePositiveNumber(entry.max_output_tokens),
				...serverCostsOf(entry),
			});
		} else {
			log("Skipping malformed provider entry", { index, rejection: provider.rejection });
		}
	}
	const [first, ...rest] = providers;
	return {
		id: raw.id,
		shape: first === undefined ? { kind: "bare" } : { kind: "group", providers: [first, ...rest] },
		// The architecture field is read on the same trust basis as the rest of the entry: shape-checked only where
		// registration actually consumes it.
		architecture: raw.architecture as LiteLLMArchitecture | undefined,
	};
}

export interface MappedModelInfo {
	id: string;
	provider: LiteLLMProvider;
	/** Derived once at ingest; the merge min-collapses these, so a merged record never re-derives from itself. */
	limits: TokenConstraints;
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

	return { id: item.modelId, provider, limits: deriveTokenConstraints(provider), inputModalities };
}

function toModelItem(mapped: MappedModelInfo): LiteLLMModelItem {
	return {
		id: mapped.id,
		shape: { kind: "deployment", provider: mapped.provider, limits: mapped.limits },
		architecture: mapped.inputModalities.length > 0 ? { input_modalities: [...mapped.inputModalities] } : undefined,
	};
}

function everyDeploymentSupports(values: readonly (boolean | null | undefined)[]): boolean | null {
	if (values.some((value) => value === false)) {
		return false;
	}
	return values.every((value) => value === true) ? true : null;
}

function intersectSupportedParams(values: readonly (string[] | null | undefined)[]): string[] | null {
	const [first, ...rest] = values;
	if (!Array.isArray(first) || rest.some((list) => !Array.isArray(list))) {
		return null;
	}
	return first.filter((param) => rest.every((list) => Array.isArray(list) && list.includes(param)));
}

function agreedCost(values: readonly (number | null | undefined)[]): number | null {
	const [first, ...rest] = values;
	return typeof first === "number" && rest.every((value) => value === first) ? first : null;
}

/**
 * LiteLLM reports one /v1/model/info entry per deployment of a load-balanced model_name; unmerged, the
 * model would register duplicate IDs and overwrite its own routes.
 *
 *   limits  -> the min-collapse of every deployment's own, carried beside the merged record (see ModelShape)
 *   pricing -> only when every deployment agrees; routing picks the serving deployment, so either differing number
 *              would lie
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
	const provider: LiteLLMProvider = {
		provider: first.provider.provider,
		status: first.provider.status,
		supports_tools: providers.every(supportsTools),
		supports_prompt_caching: everyDeploymentSupports(providers.map((p) => p.supports_prompt_caching)),
		supports_response_schema: everyDeploymentSupports(providers.map((p) => p.supports_response_schema)),
		supports_reasoning: everyDeploymentSupports(providers.map((p) => p.supports_reasoning)),
		supports_pdf_input: everyDeploymentSupports(providers.map((p) => p.supports_pdf_input)),
		supported_openai_params: intersectSupportedParams(providers.map((p) => p.supported_openai_params)),
		reasoning_effort_levels: reportedReasoningLevels(providers) ?? null,
		...recordFromKeys(COST_FIELDS, (field) => agreedCost(providers.map((p) => p[field]))),
	};
	const inputModalities = first.inputModalities.filter((modality) =>
		rest.every((deployment) => deployment.inputModalities.includes(modality))
	);
	return {
		id: first.id,
		provider,
		limits: collapseTokenLimits([first.limits, ...rest.map((deployment) => deployment.limits)]),
		inputModalities,
	};
}

export interface FetchModelsResult {
	models: LiteLLMModelItem[];
	/**
	 * The sorted union of model_info keys observed across the /model/info items, present ONLY when that listing
	 * succeeded (absent on the /models fallback and on failure): downstream advisory hints must be able to tell "the
	 * server reports these fields" from "nothing was observed". Collected from the RAW entries, before parsing and the
	 * blocked/non-chat filters, and capped at OBSERVED_MODEL_INFO_KEYS_MAX after the sort.
	 */
	observedModelInfoKeys?: readonly string[];
	/**
	 * How many usable /model/info entries were dropped per non-chat mode, present ONLY when that listing succeeded,
	 * like observedModelInfoKeys: the dashboard offers includeModes on this evidence, and an all-dropped server
	 * explains its empty picker with it. Counts exclude blocked deployments (judged first) and the modes the entry
	 * already includes.
	 */
	skippedModeCounts?: SkippedModeCounts;
	/** Advisory only - the pass succeeded and the models serve either way. */
	modelInfoUnsupported?: UnservedEndpointEvidence;
}

/**
 * Per endpoint: an expected endpoint gets exactly one attempt, and the nonfatal /model/info fallback log carries
 * `expected: true`. Only a /models failure aborts discovery, expected or not.
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
	 * The entry's apiVersion override the client was built with, so the endpoint URLs in discovery errors match the
	 * client's real API root; "" and undefined follow apiRootOf's rules. Required so a caller cannot build the client
	 * on an overridden root and silently report the auto one.
	 */
	apiVersion: string | undefined;
	/** Pre-validated by settings.getDiscoveryTimeout(); used as-is. */
	discoveryTimeout: number;
	expected?: ExpectedDiscoveryFailures;
	/** The non-chat modes the entry's discovery.includeModes admits to the chat catalog; see NON_CHAT_MODES. */
	includeModes?: readonly NonChatMode[];
	/**
	 * The declared entry's label, when the server has one, so the endpoint-unserved hints can name the entry the
	 * declaration belongs on.
	 *   Empty -> "no nameable entry" like undefined does
	 * Never used for matching here.
	 */
	entryLabel?: string | undefined;
	/** Per-request headers resolved by the caller, e.g. a freshly exchanged OAuth bearer token. */
	headers?: Record<string, string>;
	/** Receives only what discoveryLineWriter lets through. */
	log: (message: string, data?: unknown) => void;
}

/** The /v1/models fallback rethrow keys on it rather than matching message text. */
const UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION = "RequestError(http, unparseable models response body)";

/** V8 quotes the body around the failure in its message, and a body can spell a position, so only the name travels. */
function parseFailureText(error: unknown): string {
	return error instanceof SyntaxError ? "SyntaxError" : "parse error";
}

function unparseableModelsResponse(endpointUrl: string, cause: unknown): RequestError {
	const detail = `Unparseable response from ${endpointUrl}: ${parseFailureText(cause)}`;
	return new RequestError(
		`${l10n.t(
			"The server replied, but not with a model list - this address may not be a LiteLLM proxy. Check the base URL: the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2; LiteLLM's default port is 4000."
		)}\n${detail}`,
		"http",
		{
			cause,
			logClassification: UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION,
			englishMessage:
				"The server replied, but not with a model list - this address may not be a LiteLLM proxy. Check the base URL: " +
				"the extension appends /v1 unless the URL already ends in a version segment like /v1 or /v2; LiteLLM's " +
				`default port is 4000.\n${detail}`,
		}
	);
}

/** The content type is never consulted: servers mislabel JSON, so every non-empty body takes this one parse. */
function parseJsonBody(text: string, endpointUrl: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw unparseableModelsResponse(endpointUrl, error);
	}
}

/**
 * One discovery GET: the SDK runs without retries because its backoff sleep ignores the signal, so retryIdempotent
 * owns the retries and `signal` bounds the whole call, sleeps included. The per-request timeout keeps the SDK's own
 * 600 s default from overriding ours.
 */
async function getJson(
	client: OpenAI,
	path: string,
	endpointUrl: string,
	options: {
		readonly signal: AbortSignal;
		readonly timeoutMs: number;
		readonly maxRetries: number;
		readonly headers: FetchModelsRequest["headers"];
	}
): Promise<unknown> {
	return retryIdempotent(
		async () => {
			const response = await client
				.get(path, { signal: options.signal, timeout: options.timeoutMs, maxRetries: 0, headers: options.headers })
				.asResponse();
			let text: string;
			try {
				text = await response.text();
			} catch (readError) {
				if (options.signal.aborted) {
					throw readError;
				}
				// A socket death mid-body classifies like one before the headers.
				throw new APIConnectionError({ cause: readError instanceof Error ? readError : undefined });
			}
			// An empty body, a 204 or a bare 200, is an empty listing, not a parse failure.
			return text === "" ? null : parseJsonBody(text, endpointUrl);
		},
		{ maxRetries: options.maxRetries, signal: options.signal }
	);
}

/** How the model-info probe's failure looked, for the /models leg's same-pass verdict. */
type EndpointFailureEvidence = { kind: "timeout" } | { kind: "status"; status: 404 | 405 };

/** Anything else - auth, network, 5xx, unparseable payloads - proves nothing and yields undefined. */
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

function evidenceText(evidence: EndpointFailureEvidence, timeoutMs: number): string {
	return evidence.kind === "timeout" ? `timed out after ${timeoutMs}ms` : `answered HTTP ${evidence.status}`;
}

/**
 * The RequestError kind/status pair an evidence shape maps back onto, so refined errors keep their transport taxonomy.
 */
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
	evidence: EndpointFailureEvidence | undefined;
}

interface ModelsFailureContext {
	modelInfo: ModelInfoProbeOutcome;
	expected: ExpectedDiscoveryFailures | undefined;
	entryLabel: string | undefined;
	baseUrl: string;
	apiVersion: string | undefined;
	timeoutMs: number;
}

/**
 * The models listing failed like an unserved endpoint while model-info answered (or was itself declared expected).
 * Names the entry when the server has one; carries the unsupportedEndpoint classification so the dashboard can offer
 * the declaration as an action.
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
	const detail = `GET ${modelsUrl(ctx.baseUrl, ctx.apiVersion)} ${evidenceText(evidence, ctx.timeoutMs)}; model info ${
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
 * Both discovery endpoints failed like unserved endpoints in one pass. Replaces the raise-the-timeout advice a bare
 * timeout would carry.
 */
function noEndpointServedError(
	mapped: Error,
	evidence: EndpointFailureEvidence,
	infoEvidence: EndpointFailureEvidence,
	ctx: ModelsFailureContext
) {
	const { kind: errorKind, status, token } = evidenceKind(evidence);
	const { baseUrl } = ctx;
	// The caller guarantees both evidences share a kind, so the headline must match the detail line right below it,
	// which names what each GET did.
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
 * The same-pass verdict over a failed models listing: the declaration hint when model-info answered (or is declared
 * expected), the not-OpenAI-compatible verdict when model-info failed the SAME unserved way - mixed evidence does not
 * prove the address serves nothing.
 * A models 404 keeps mapSdkError's discovery 404 message even then.
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

interface NarrowedModelInfoData {
	models: LiteLLMModelItem[];
	/**
	 * Entries recognized as either payload shape, counted before the blocked filter. The /v1/models fallback keys on
	 * this instead of `models.length`: a payload whose recognized entries were all blocked must yield an empty list,
	 * not a fallback that re-lists the blocked models.
	 */
	usableEntryCount: number;
	/** See FetchModelsResult.observedModelInfoKeys; sorted and capped here. */
	observedModelInfoKeys: readonly string[];
	/** See FetchModelsResult.skippedModeCounts. */
	skippedModeCounts: SkippedModeCounts;
}

/** Sorted before truncation, and an oversized key is dropped, never clipped, so truncation cannot alias two keys. */
const OBSERVED_MODEL_INFO_KEYS_MAX = 512;
const OBSERVED_MODEL_INFO_KEY_MAX_LENGTH = 128;

/**
 * Narrow a /v1/model/info payload element-wise: unrecognized entries are skipped with a log line instead of aborting
 * the whole registration.
 *   Blocked (paused) deployments     -> are dropped
 *   deployments sharing one model id -> merge in first-seen order
 */
function narrowModelInfoData(
	data: unknown[],
	log: DiscoveryLog,
	includeModes: readonly NonChatMode[] = []
): NarrowedModelInfoData {
	let usableEntryCount = 0;
	const observedKeys = new Set<string>();
	const skippedModeCounts: { -readonly [M in NonChatMode]?: number } = {};
	// One mode verdict for both entry shapes: a listing-shaped entry may carry model_info too, and a verdict read off
	// the rich shape alone let such entries register uncounted, includeModes or not.
	const dropsByMode = (mode: unknown): boolean => {
		if (!isNonChatMode(mode)) {
			return false;
		}
		// Classification only: the logged mode is always one of the NON_CHAT_MODES constants; the server-provided model
		// id stays out of the issue-report buffer.
		if (includeModes.includes(mode)) {
			log("Registering included non-chat model/info entry", { mode });
			return false;
		}
		skippedModeCounts[mode] = (skippedModeCounts[mode] ?? 0) + 1;
		log("Skipping non-chat model/info entry", { mode });
		return true;
	};
	type Slot =
		| { kind: "deployments"; group: [MappedModelInfo, ...MappedModelInfo[]] }
		| { kind: "model"; model: LiteLLMModelItem };
	const slots: Slot[] = [];
	const deploymentsById = new Map<string, [MappedModelInfo, ...MappedModelInfo[]]>();
	for (const [index, entry] of data.entries()) {
		// Raw keys, before any parsing: the union covers every entry that carries a model_info object on the wire,
		// malformed and listing-shaped entries included, because the keys were observed either way.
		if (isRecord(entry) && isRecord(entry.model_info)) {
			for (const key of Object.keys(entry.model_info)) {
				if (key.length <= OBSERVED_MODEL_INFO_KEY_MAX_LENGTH) {
					observedKeys.add(key);
				}
			}
		}
		const info = parseWire(rawModelInfoItemSchema, entry);
		if (info.success) {
			const parsed = info.data;
			usableEntryCount += 1;
			if (parsed.model_info?.blocked === true) {
				log("Skipping blocked model/info entry", { index });
				continue;
			}
			if (dropsByMode(parsed.model_info?.mode)) {
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
		const listing = parseWire(rawModelItemSchema, entry);
		if (listing.success) {
			usableEntryCount += 1;
			// The same two judgments as the rich shape, in the same order: a paused deployment is blocked, never a
			// skipped mode and never admitted.
			const modelInfo = isRecord(listing.data.model_info) ? listing.data.model_info : undefined;
			if (modelInfo?.blocked === true) {
				log("Skipping blocked model/info entry", { index });
				continue;
			}
			if (dropsByMode(modelInfo?.mode)) {
				continue;
			}
			slots.push({ kind: "model", model: normalizeModelItem(listing.data, log) });
			continue;
		}
		log("Skipping malformed model/info entry", {
			index,
			modelInfo: info.rejection,
			listing: listing.rejection,
		});
	}
	const models = slots.map((slot) =>
		slot.kind === "deployments" ? toModelItem(mergeModelDeployments(slot.group)) : slot.model
	);
	// Sort-then-slice keeps truncation deterministic but drops the alphabetic TAIL: an over-cap payload can make a
	// really-reported key read as unobserved, letting a spurious unknown-key hint through downstream. The set never
	// gains keys the server did not send.
	const observedModelInfoKeys = [...observedKeys].sort().slice(0, OBSERVED_MODEL_INFO_KEYS_MAX);
	return { models, usableEntryCount, observedModelInfoKeys, skippedModeCounts };
}

export async function fetchModels(request: FetchModelsRequest): Promise<FetchModelsResult> {
	const { client, baseUrl, apiVersion, discoveryTimeout, expected, includeModes, entryLabel, headers } = request;
	const log = discoveryLineWriter(request.log);

	log("Fetching models", { endpoint: MODEL_INFO_PATH });

	// What the model-info probe did, for the same-pass verdicts: the /models success return and the /models failure
	// refinement both read it.
	const modelInfo: ModelInfoProbeOutcome = { answered: false, evidence: undefined };
	const infoSignal = AbortSignal.timeout(discoveryTimeout);
	try {
		// Retries stay off for an endpoint whose failure the entry declares expected.
		const parsedInfo: unknown = await getJson(client, MODEL_INFO_PATH, modelInfoUrl(baseUrl, apiVersion), {
			signal: infoSignal,
			timeoutMs: discoveryTimeout,
			maxRetries: expected?.modelInfo === true ? 0 : DISCOVERY_MAX_RETRIES,
			headers,
		});
		// An unparseable body throws above and proves nothing about endpoint support.
		modelInfo.answered = true;
		const infoEnvelope = parseWire(dataEnvelopeSchema, parsedInfo);
		if (infoEnvelope.success) {
			const data: unknown[] = infoEnvelope.data.data;
			log("Parsed model/info response", { modelCount: data.length });

			const { models, usableEntryCount, observedModelInfoKeys, skippedModeCounts } = narrowModelInfoData(
				data,
				log,
				includeModes
			);
			if (data.length > 0 && usableEntryCount === 0) {
				log("model/info returned data but no usable models; falling back", { dataLength: data.length });
			} else {
				log("Successfully fetched models", { modelCount: models.length });
				return { models, observedModelInfoKeys, skippedModeCounts };
			}
		} else {
			log("model/info response has no data array; falling back", { rejection: infoEnvelope.rejection });
		}
	} catch (error) {
		// Response-derived text can echo credentials into the issue-report buffer, so the log carries only the
		// classification. This is discovery's one expected-failure log seam, because a /model/info failure is nonfatal
		// and never reaches the provider boundary.
		const mapped = mapSdkError(error, { surface: "discovery", baseUrl, timeoutMs: discoveryTimeout });
		// The signal firing IS the timeout evidence even when the mapped error is not classified as one
		// (AbortSignal.timeout's TimeoutError maps to the unhandled tail).
		modelInfo.evidence = infoSignal.aborted ? { kind: "timeout" } : unservedEvidenceOf(mapped);
		log("model/info failed; falling back to the models listing", {
			expected: expected?.modelInfo === true,
			...failureKindOf(mapped),
		});
	}

	log("Fetching models", { endpoint: MODELS_PATH });
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
		parsed = await getJson(client, MODELS_PATH, modelsUrl(baseUrl, apiVersion), {
			signal: timeoutSignal,
			timeoutMs: discoveryTimeout,
			maxRetries: expected?.modelListing === true ? 0 : DISCOVERY_MAX_RETRIES,
			headers,
		});
	} catch (error) {
		if (timeoutSignal.aborted) {
			throw refineModelsListingFailure(timeoutRequestError(errorContext, error), failureContext);
		}
		if (error instanceof RequestError && error.logClassification === UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION) {
			throw error;
		}
		throw refineModelsListingFailure(mapSdkError(error, errorContext), failureContext);
	}
	const listingEnvelope = parseWire(dataEnvelopeSchema, parsed);
	const data = listingEnvelope.success ? listingEnvelope.data.data : [];
	log("Parsed models listing", { modelCount: data.length });

	const models: LiteLLMModelItem[] = [];
	for (const [index, entry] of data.entries()) {
		const item = parseWire(rawModelItemSchema, entry);
		if (item.success) {
			models.push(normalizeModelItem(item.data, log));
		} else {
			log("Skipping malformed models entry", { index, rejection: item.rejection });
		}
	}
	log("Successfully fetched models", { modelCount: models.length });
	return {
		models,
		// See FetchModelsResult.modelInfoUnsupported: a declared-expected probe failure is already handled and gets no
		// hint.
		...(modelInfo.evidence !== undefined && expected?.modelInfo !== true
			? { modelInfoUnsupported: modelInfo.evidence.kind }
			: {}),
	};
}
