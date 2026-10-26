import * as l10n from "@vscode/l10n";
import type OpenAI from "openai";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { consumedFieldsOfKind } from "../../shared/config/capabilityResolution";
import { CONFIG_SECTION, DISCOVERY_MAX_RETRIES } from "../../shared/config/settingSpec";
import type { UnservedEndpointEvidence } from "../../shared/errorClassification";
import type { NonChatMode, SkippedModeCounts } from "../../shared/serverEntry";
import { isNonChatMode } from "../../shared/serverEntry";
import { isRecord, recordFromKeys } from "../../shared/util/json";
import { normalizeCostPerToken, normalizePositiveNumber } from "../../shared/util/numbers";
import { sleepUnlessAborted } from "../../shared/util/timer";
import {
	MODEL_GROUP_INFO_PATH,
	MODEL_INFO_PATH,
	MODELS_PATH,
	modelGroupInfoUrl,
	modelInfoUrl,
	modelsUrl,
} from "../transport/clients";
import { mapSdkError } from "../transport/errorMapping";
import type { BackoffSleep } from "../transport/retry";
import { retryBudgetMs, retryIdempotent } from "../transport/retry";
import type { MapErrorContext } from "../transport/transportErrors";
import { RequestError, timeoutRequestError } from "../transport/transportErrors";
import type { DiscoveryLog } from "./discoveryLog";
import { discoveryLineWriter, failureKindOf, parseWire } from "./discoveryLog";
import { collapseTokenLimits, deriveTokenConstraints, reportedReasoningLevels } from "./modelCatalog";
import { orderedReasoningLevels, resolveSupportedReasoningEfforts } from "./modelConfiguration";
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
	modelGroupInfoItemSchema,
	providerEntrySchema,
	rawModelInfoItemSchema,
	rawModelItemSchema,
	supportsTools,
} from "./schemas";

/** The wire never says whether LiteLLM's catalog described a deployment, so every entry resolves as unmapped. */
const UNMAPPED_DEPLOYMENT = { deploymentIsMapped: false } as const;

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

/**
 * LiteLLM's provider name for DeepSeek's own API, the one backend that demands reasoning_content on replay. Authored
 * here for both listing shapes, so the deployment merge and registration read one field whichever path found the
 * model; null is "unknown", like the other discovery-authored flags.
 */
function replayRequirementOf(providerName: string): boolean | null {
	return providerName === "deepseek" ? true : null;
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
				// null is the one "unknown" a discovery-authored provider carries, on both listing paths.
				reasoning_effort_levels: resolveSupportedReasoningEfforts(entry, UNMAPPED_DEPLOYMENT) ?? null,
				replay_reasoning_content: replayRequirementOf(entry.provider),
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

/**
 * A /model/info entry as mapModelInfoEntry maps it. `limits` are derived once at ingest, and the merge min-collapses
 * them, so a merged record never re-derives from itself.
 */
export interface MappedModelInfo {
	id: string;

	provider: LiteLLMProvider;

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
		replay_reasoning_content: replayRequirementOf(providerName),
		supported_openai_params: item.model_info?.supported_openai_params ?? null,
		reasoning_effort_levels: resolveSupportedReasoningEfforts(item.model_info, UNMAPPED_DEPLOYMENT) ?? null,
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
		replay_reasoning_content: everyDeploymentSupports(providers.map((p) => p.replay_reasoning_content)),
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

/**
 * What one discovery pass yields. `observedModelInfoKeys` and `skippedModeCounts` are present ONLY when the
 * /model/info listing succeeded (absent on the /models fallback and on failure), so downstream advisory hints can tell
 * "the server reports these fields" from "nothing was observed".
 *   observedModelInfoKeys -> collected from the RAW entries, before parsing and the blocked/non-chat filters, sorted,
 *                            then capped at OBSERVED_MODEL_INFO_KEYS_MAX
 *   skippedModeCounts     -> excludes blocked deployments (judged first) and the modes the entry already includes; the
 *                            dashboard offers includeModes on this evidence, and an all-dropped server explains its
 *                            empty picker with it
 */
export interface FetchModelsResult {
	/** The listing's models, from /model/info or the /models fallback. */
	models: LiteLLMModelItem[];

	/** The sorted union of model_info keys observed across the /model/info items. */
	observedModelInfoKeys?: readonly string[];

	/** How many usable /model/info entries were dropped per non-chat mode. */
	skippedModeCounts?: SkippedModeCounts;

	/** Advisory only: the pass succeeded and the models serve either way. */
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

/**
 * One listing fetch. `apiVersion` is required, not optional, so a caller cannot build the client on an overridden root
 * and silently report the auto one: the endpoint URLs in discovery errors must match the client's real API root.
 *   entryLabel "" -> "no nameable entry", like undefined; never used for matching here
 */
export interface FetchModelsRequest {
	/** Transport for this server, from clients.ts; static auth and headers live there. */
	client: OpenAI;

	/** The server's base URL as configured; error texts and the endpoint URLs name it. */
	baseUrl: string;

	/** The entry's apiVersion override the client was built with; "" and undefined follow apiRootOf's rules. */
	apiVersion: string | undefined;

	/** Pre-validated by settings.getDiscoveryTimeout(); used as-is. */
	discoveryTimeout: number;

	/** The endpoints the entry declares as expected failures; absent means none. */
	expected?: ExpectedDiscoveryFailures;

	/** The non-chat modes the entry's discovery.includeModes admits to the chat catalog; see NON_CHAT_MODES. */
	includeModes?: readonly NonChatMode[];

	/** The declared entry's label, when the server has one, so endpoint-unserved hints can name the entry. */
	entryLabel?: string | undefined;

	/** Per-request headers resolved by the caller, e.g. a freshly exchanged OAuth bearer token. */
	headers?: Record<string, string>;

	/** Receives only what discoveryLineWriter lets through. */
	log: (message: string, data?: unknown) => void;

	/** mapSdkError's cancellation predicate; see cancellation.ts. */
	isCancellation: (error: unknown) => error is Error;

	/** The retry backoff between failed GETs: the real timer unless a test passes a zero sleep. */
	sleep?: BackoffSleep;
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
 * What a discovery GET answered with. An empty body (a 204, a bare 200) is kept apart from a body that parses to
 * null, because "answered with a body" is the evidence that marks a LiteLLM proxy for the group probe.
 */
type DiscoveryBody = { readonly empty: true } | { readonly empty: false; readonly value: unknown };

/** What a 204 or a bare 200 answers with. */
const EMPTY_BODY: DiscoveryBody = { empty: true };

/** An empty body reads as an empty listing downstream, exactly like a body that parsed to null. */
const bodyValue = (body: DiscoveryBody): unknown => (body.empty ? null : body.value);

/**
 * One discovery GET under two clocks: each attempt gets `context.timeoutMs` (discovery.timeout) for its headers and
 * body together, and the whole call ends at retryBudgetMs of it, so a hung attempt is retried like any other
 * connection failure.
 *   the SDK's own retries  -> off: its backoff sleep ignores the signal, so retryIdempotent owns them
 *   the SDK's own timeout  -> the same value, so its 600 s default cannot cut in under a larger setting; it stops at
 *                             the headers, so the attempt clock also covers a body that stalls after them
 *   a budget expiry with no HTTP status -> the discovery timeout whichever phase it interrupts, rendered here so
 *                                          every caller maps a failure with mapSdkError alone
 *   a status-bearing error              -> keeps its status whatever the clocks did
 */
async function getJson(
	client: OpenAI,
	path: string,
	endpointUrl: string,
	options: {
		readonly context: MapErrorContext;
		readonly maxRetries: number;
		readonly headers: FetchModelsRequest["headers"];
		readonly sleep: BackoffSleep;
	}
): Promise<DiscoveryBody> {
	const { context, maxRetries, headers, sleep } = options;
	const budget = AbortSignal.timeout(retryBudgetMs(context.timeoutMs, maxRetries));
	try {
		return await retryIdempotent(
			async () => {
				const attemptClock = AbortSignal.timeout(context.timeoutMs);
				let text: string;
				try {
					const response = await client
						.get(path, {
							signal: AbortSignal.any([budget, attemptClock]),
							timeout: context.timeoutMs,
							maxRetries: 0,
							headers,
						})
						.asResponse();
					// A socket death mid-body classifies like one before the headers.
					text = await response.text().catch((readError: unknown) => {
						throw new APIConnectionError({ cause: readError instanceof Error ? readError : undefined });
					});
				} catch (error) {
					// The SDK calls only its own headers clock a timeout; an abort it did not arm is a user abort to it.
					throw attemptClock.aborted && !budget.aborted && !carriesStatus(error)
						? new APIConnectionTimeoutError()
						: error;
				}
				// An empty body, a 204 or a bare 200, is an empty listing, not a parse failure.
				return text === "" ? EMPTY_BODY : { empty: false, value: parseJsonBody(text, endpointUrl) };
			},
			{ maxRetries, signal: budget, sleep }
		);
	} catch (error) {
		if (budget.aborted && !carriesStatus(error)) {
			throw timeoutRequestError(context, error);
		}
		throw error;
	}
}

/**
 * A status whose headers arrived is the verdict however the body ended: the SDK reads an error body with a catch and
 * still raises the status, so a 401 whose body stalls past either clock stays a 401, terminal and never re-wrapped.
 */
function carriesStatus(error: unknown): boolean {
	return error instanceof APIError && typeof error.status === "number";
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

	/** The response carried a JSON body (an empty 200 or 204 answers without one), which is what marks a LiteLLM proxy. */
	body: boolean;

	/** The unserved-looking failure the probe's error mapped to, or undefined when it answered or failed otherwise. */
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
		namedEntry === undefined
			? l10n.t(
					'The models listing failed, but this server answers. If it never serves the models listing, add an entry for it in the "{0}" setting declaring "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".',
					`${CONFIG_SECTION}.servers`
				)
			: l10n.t(
					'The models listing failed, but this server answers. If it never serves the models listing, declare that on the "{0}" entry: "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".',
					namedEntry
				);
	const englishHeadline =
		namedEntry === undefined
			? `The models listing failed, but this server answers. If it never serves the models listing, add an entry for it in the "${CONFIG_SECTION}.servers" setting declaring "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".`
			: `The models listing failed, but this server answers. If it never serves the models listing, declare that on the "${namedEntry}" entry: "expectedFailures": ["modelListing"], with model IDs in "discovery.declared".`;
	const detail = `GET ${modelsUrl(ctx.baseUrl, ctx.apiVersion)} ${evidenceText(evidence, ctx.timeoutMs)}; model info ${
		ctx.modelInfo.answered ? "answered" : "is declared an expected failure"
	}`;
	return new RequestError(`${headline}\n${detail}`, kind, {
		...(status === undefined ? {} : { status }),
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
		...(status === undefined ? {} : { status }),
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

/**
 * The /v1/models fallback keys on `usableEntryCount`, never on `models.length`: a payload whose recognized entries
 * were all blocked must yield an empty list, not a fallback that re-lists the blocked models.
 */
interface NarrowedModelInfoData {
	/** The entries that survived parsing and the blocked and non-chat filters; deployments sharing an id are merged. */
	models: LiteLLMModelItem[];

	/** Entries recognized as either payload shape, counted before the blocked filter. */
	usableEntryCount: number;

	/** See FetchModelsResult.observedModelInfoKeys; sorted and capped here. */
	observedModelInfoKeys: readonly string[];

	/** See FetchModelsResult.skippedModeCounts. */
	skippedModeCounts: SkippedModeCounts;
}

/** The list is sorted before this cap, so the kept keys do not depend on the server's order. */
const OBSERVED_MODEL_INFO_KEYS_MAX = 512;

/** An oversized key is dropped, never clipped, so truncation cannot alias two keys. */
const OBSERVED_MODEL_INFO_KEY_MAX_LENGTH = 128;

/** A /model/info entry's place in listing order: the deployments sharing one id, or one listing-shaped model. */
type ModelInfoSlot =
	| { kind: "deployments"; group: [MappedModelInfo, ...MappedModelInfo[]] }
	| { kind: "model"; model: LiteLLMModelItem };

/**
 * Narrows a /v1/model/info payload element-wise: unrecognized entries are skipped with a log line instead of aborting
 * the whole registration.
 *   Blocked (paused) deployments     -> are dropped
 *   deployments sharing one model id -> merge in first-seen order
 */
class ModelInfoCollector {
	private usableEntryCount = 0;

	private readonly observedKeys = new Set<string>();

	private readonly skippedModeCounts: { -readonly [M in NonChatMode]?: number } = {};

	private readonly slots: ModelInfoSlot[] = [];

	private readonly deploymentsById = new Map<string, [MappedModelInfo, ...MappedModelInfo[]]>();

	constructor(
		private readonly log: DiscoveryLog,
		private readonly includeModes: readonly NonChatMode[]
	) {}

	/**
	 * Raw keys, before any parsing: the union covers every entry that carries a model_info object on the wire,
	 * malformed and listing-shaped entries included, because the keys were observed either way.
	 */
	private observeKeys(entry: unknown): void {
		if (!(isRecord(entry) && isRecord(entry.model_info))) {
			return;
		}
		for (const key of Object.keys(entry.model_info)) {
			if (key.length <= OBSERVED_MODEL_INFO_KEY_MAX_LENGTH) {
				this.observedKeys.add(key);
			}
		}
	}

	/**
	 * One mode verdict for both entry shapes: a listing-shaped entry may carry model_info too, and a verdict read off
	 * the rich shape alone let such entries register uncounted, includeModes or not.
	 */
	private dropsByMode(mode: unknown): boolean {
		if (!isNonChatMode(mode)) {
			return false;
		}
		// Classification only: the logged mode is always one of the NON_CHAT_MODES constants; the server-provided model
		// id stays out of the issue-report buffer.
		if (this.includeModes.includes(mode)) {
			this.log("Registering included non-chat model/info entry", { mode });
			return false;
		}
		this.skippedModeCounts[mode] = (this.skippedModeCounts[mode] ?? 0) + 1;
		this.log("Skipping non-chat model/info entry", { mode });
		return true;
	}

	/**
	 * Whether a usable entry registers: the same two judgments for both shapes, in the same order, so a paused
	 * deployment is blocked, never a skipped mode and never admitted.
	 */
	private admits(modelInfo: { blocked?: unknown; mode?: unknown } | undefined, index: number): boolean {
		if (modelInfo?.blocked === true) {
			this.log("Skipping blocked model/info entry", { index });
			return false;
		}
		return !this.dropsByMode(modelInfo?.mode);
	}

	/** A rich entry joins the deployments sharing its id, or opens a new group in listing order. */
	private admitDeployment(parsed: LiteLLMModelInfoItem): void {
		const mapped = mapModelInfoEntry(parsed);
		const group = this.deploymentsById.get(mapped.id);
		if (group) {
			group.push(mapped);
			return;
		}
		const newGroup: [MappedModelInfo, ...MappedModelInfo[]] = [mapped];
		this.deploymentsById.set(mapped.id, newGroup);
		this.slots.push({ kind: "deployments", group: newGroup });
	}

	/** Judges one payload element: a rich entry, a listing-shaped entry, or a malformed one, logged and skipped. */
	add(index: number, entry: unknown): void {
		this.observeKeys(entry);

		const info = parseWire(rawModelInfoItemSchema, entry);
		if (info.success) {
			this.usableEntryCount += 1;
			if (this.admits(info.data.model_info, index)) {
				this.admitDeployment(info.data);
			}
			return;
		}

		const listing = parseWire(rawModelItemSchema, entry);
		if (listing.success) {
			this.usableEntryCount += 1;
			const modelInfo = isRecord(listing.data.model_info) ? listing.data.model_info : undefined;
			if (this.admits(modelInfo, index)) {
				this.slots.push({ kind: "model", model: normalizeModelItem(listing.data, this.log) });
			}
			return;
		}

		this.log("Skipping malformed model/info entry", {
			index,
			modelInfo: info.rejection,
			listing: listing.rejection,
		});
	}

	/** The narrowed listing, the deployment groups merged, and the observations capped. */
	result(): NarrowedModelInfoData {
		const models = this.slots.map((slot) =>
			slot.kind === "deployments" ? toModelItem(mergeModelDeployments(slot.group)) : slot.model
		);
		// Sort-then-slice keeps truncation deterministic but drops the alphabetic TAIL: an over-cap payload can make a
		// really-reported key read as unobserved, letting a spurious unknown-key hint through downstream. The set never
		// gains keys the server did not send.
		const observedModelInfoKeys = [...this.observedKeys].sort().slice(0, OBSERVED_MODEL_INFO_KEYS_MAX);
		return {
			models,
			usableEntryCount: this.usableEntryCount,
			observedModelInfoKeys,
			skippedModeCounts: this.skippedModeCounts,
		};
	}
}

function narrowModelInfoData(
	data: unknown[],
	log: DiscoveryLog,
	includeModes: readonly NonChatMode[] = []
): NarrowedModelInfoData {
	const collector = new ModelInfoCollector(log, includeModes);
	for (const [index, entry] of data.entries()) {
		collector.add(index, entry);
	}
	return collector.result();
}

/** What every leg of one fetch shares. */
interface DiscoveryLeg {
	readonly request: FetchModelsRequest;
	readonly log: DiscoveryLog;
	readonly sleep: BackoffSleep;
	readonly errorContext: MapErrorContext;
}

/** What the /model/info probe left for the /models leg: its outcome, and the listing it served when it was usable. */
interface ModelInfoProbe {
	readonly outcome: ModelInfoProbeOutcome;
	readonly served: FetchModelsResult | undefined;
}

/**
 * The group endpoint is LiteLLM-only and lives at the server root, so it is probed only once /model/info has
 * answered with a body: an OpenAI-compatible server (Ollama hangs on unknown routes until the timeout) never pays
 * for it, and its 404 costs that server nothing.
 */
async function withGroupMenus(
	leg: DiscoveryLeg,
	probeAnsweredWithBody: boolean,
	result: FetchModelsResult
): Promise<FetchModelsResult> {
	if (!probeAnsweredWithBody) {
		return result;
	}
	const efforts = await fetchModelGroupReasoningEfforts(leg.request, leg.log, leg.sleep);
	return efforts === undefined
		? result
		: { ...result, models: result.models.map((model) => withServerReasoningEfforts(model, efforts)) };
}

/**
 * The /model/info probe: a usable listing is served (group menus included), anything else falls back to /models
 * with a log line that classifies why. An unparseable body throws and proves nothing about endpoint support; a parsed
 * one marks the probe answered, with a body or without. Retries stay off for an endpoint whose failure the entry
 * declares expected.
 */
async function probeModelInfo(leg: DiscoveryLeg): Promise<ModelInfoProbe> {
	const { request, log, sleep, errorContext } = leg;
	const { client, baseUrl, apiVersion, expected, includeModes, headers } = request;
	const outcome: ModelInfoProbeOutcome = { answered: false, body: false, evidence: undefined };
	try {
		const infoBody = await getJson(client, MODEL_INFO_PATH, modelInfoUrl(baseUrl, apiVersion), {
			context: errorContext,
			maxRetries: expected?.modelInfo === true ? 0 : DISCOVERY_MAX_RETRIES,
			headers,
			sleep,
		});
		outcome.answered = true;
		outcome.body = !infoBody.empty;
		const infoEnvelope = parseWire(dataEnvelopeSchema, bodyValue(infoBody));
		if (!infoEnvelope.success) {
			log("model/info response has no data array; falling back", { rejection: infoEnvelope.rejection });
			return { outcome, served: undefined };
		}
		const data: unknown[] = infoEnvelope.data.data;
		log("Parsed model/info response", { modelCount: data.length });

		const { models, usableEntryCount, observedModelInfoKeys, skippedModeCounts } = narrowModelInfoData(
			data,
			log,
			includeModes
		);
		if (data.length > 0 && usableEntryCount === 0) {
			log("model/info returned data but no usable models; falling back", { dataLength: data.length });
			return { outcome, served: undefined };
		}
		log("Successfully fetched models", { modelCount: models.length });
		const served = await withGroupMenus(leg, outcome.body, { models, observedModelInfoKeys, skippedModeCounts });
		return { outcome, served };
	} catch (error) {
		// Response-derived text can echo credentials into the issue-report buffer, so the log carries only the
		// classification. This is discovery's one expected-failure log seam, because a /model/info failure is nonfatal
		// and never reaches the provider boundary.
		const mapped = mapSdkError(error, errorContext, request.isCancellation);
		outcome.evidence = unservedEvidenceOf(mapped);
		log("model/info failed; falling back to the models listing", {
			expected: expected?.modelInfo === true,
			...failureKindOf(mapped),
		});
		return { outcome, served: undefined };
	}
}

/** The /models listing, the fallback every server answers; its failure is the one that aborts discovery. */
async function listModels(leg: DiscoveryLeg, failureContext: ModelsFailureContext): Promise<LiteLLMModelItem[]> {
	const { request, log, sleep, errorContext } = leg;
	const { client, baseUrl, apiVersion, expected, headers } = request;
	let listingBody: DiscoveryBody;
	try {
		listingBody = await getJson(client, MODELS_PATH, modelsUrl(baseUrl, apiVersion), {
			context: errorContext,
			maxRetries: expected?.modelListing === true ? 0 : DISCOVERY_MAX_RETRIES,
			headers,
			sleep,
		});
	} catch (error) {
		if (error instanceof RequestError && error.logClassification === UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION) {
			throw error;
		}
		throw refineModelsListingFailure(mapSdkError(error, errorContext, request.isCancellation), failureContext);
	}
	const listingEnvelope = parseWire(dataEnvelopeSchema, bodyValue(listingBody));
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
	return models;
}

export async function fetchModels(request: FetchModelsRequest): Promise<FetchModelsResult> {
	const { baseUrl, apiVersion, discoveryTimeout, expected, entryLabel } = request;
	const leg: DiscoveryLeg = {
		request,
		log: discoveryLineWriter(request.log),
		sleep: request.sleep ?? sleepUnlessAborted,
		errorContext: { surface: "discovery", baseUrl, timeoutMs: discoveryTimeout },
	};
	const { log } = leg;

	log("Fetching models", { endpoint: MODEL_INFO_PATH });
	// What the model-info probe did, for the same-pass verdicts: the /models success return and the /models failure
	// refinement both read it.
	const probe = await probeModelInfo(leg);
	if (probe.served !== undefined) {
		return probe.served;
	}

	log("Fetching models", { endpoint: MODELS_PATH });
	const failureContext: ModelsFailureContext = {
		modelInfo: probe.outcome,
		expected,
		entryLabel,
		baseUrl,
		apiVersion,
		timeoutMs: discoveryTimeout,
	};
	const models = await listModels(leg, failureContext);
	log("Successfully fetched models", { modelCount: models.length });
	return await withGroupMenus(leg, probe.outcome.body, {
		models,
		// See FetchModelsResult.modelInfoUnsupported: a declared-expected probe failure is already handled and gets no
		// hint.
		...(probe.outcome.evidence !== undefined && expected?.modelInfo !== true
			? { modelInfoUnsupported: probe.outcome.evidence.kind }
			: {}),
	});
}

/** model_group -> LiteLLM's resolved menu; null is the proxy saying unknown. A group without the field is not here. */
type ModelGroupReasoningEfforts = ReadonlyMap<string, readonly string[] | null>;

/**
 * Nonfatal like the model/info probe: a failure of any kind (a 404 from a proxy without the endpoint, a 401, a timeout)
 * leaves the deployment-flag menus standing and is logged by classification only. A proxy from before the field
 * answers without it, which the schema reads as undefined, so those groups are left out of the map.
 */
async function fetchModelGroupReasoningEfforts(
	request: FetchModelsRequest,
	log: DiscoveryLog,
	sleep: BackoffSleep
): Promise<ModelGroupReasoningEfforts | undefined> {
	const { client, baseUrl, apiVersion, discoveryTimeout, headers } = request;
	log("Fetching models", { endpoint: MODEL_GROUP_INFO_PATH });
	const context: MapErrorContext = { surface: "discovery", baseUrl, timeoutMs: discoveryTimeout };
	// The absolute URL, since the client's base is the API root (.../v1) and this endpoint sits at the server root.
	const url = modelGroupInfoUrl(baseUrl, apiVersion);
	let groupBody: DiscoveryBody;
	try {
		groupBody = await getJson(client, url, url, { context, maxRetries: DISCOVERY_MAX_RETRIES, headers, sleep });
	} catch (error) {
		const mapped = mapSdkError(error, context, request.isCancellation);
		log("model_group/info failed; menus follow the deployment flags", failureKindOf(mapped));
		return undefined;
	}
	const envelope = parseWire(dataEnvelopeSchema, bodyValue(groupBody));
	if (!envelope.success) {
		log("model_group/info response has no data array; menus follow the deployment flags", {
			rejection: envelope.rejection,
		});
		return undefined;
	}
	log("Parsed model_group/info response", { groupCount: envelope.data.data.length });
	const efforts = new Map<string, readonly string[] | null>();
	for (const [index, entry] of envelope.data.data.entries()) {
		const group = parseWire(modelGroupInfoItemSchema, entry);
		if (!group.success) {
			log("Skipping malformed model_group/info entry", { index, rejection: group.rejection });
			continue;
		}
		if (group.data.supported_reasoning_efforts !== undefined) {
			efforts.set(group.data.model_group, group.data.supported_reasoning_efforts);
		}
	}
	return efforts;
}

/** The proxy's own resolution rides the item, so the bare shape (no provider to carry it) keeps it too. */
function withServerReasoningEfforts(model: LiteLLMModelItem, efforts: ModelGroupReasoningEfforts): LiteLLMModelItem {
	const levels = efforts.get(model.id);
	if (levels === undefined) {
		return model;
	}
	return { ...model, reasoningEfforts: levels === null ? null : orderedReasoningLevels(levels) };
}
