import type OpenAI from "openai";
import { l10n } from "vscode";
import type { TokenDefaults } from "../../shared/config/settings";
import { errorMessageText } from "../../shared/logger";
import { isRecord } from "../../shared/util/json";
import { normalizeCostPerToken, normalizePositiveNumber } from "../../shared/util/numbers";
import { MODEL_INFO_PATH, MODELS_PATH, modelInfoUrl, modelsUrl } from "../transport/clients";
import { mapSdkError, RequestError, timeoutRequestError } from "../transport/errorMapping";
import { collapseTokenConstraints } from "./modelCatalog";
import type {
	LiteLLMArchitecture,
	LiteLLMModelInfoItem,
	LiteLLMModelItem,
	LiteLLMProvider,
	RawModelItem,
} from "./schemas";
import { providerEntrySchema, rawModelInfoItemSchema, rawModelItemSchema, supportsTools } from "./schemas";

/**
 * The retry budget for discovery GETs. They are idempotent, so retrying is
 * safe; chat completions never retry. auth.ts reuses this for the equally
 * idempotent OAuth token exchange.
 */
export const DISCOVERY_MAX_RETRIES = 2;

/**
 * Accept an entry shaped like a models-listing item: `id` must be a string
 * and `providers`, when present, must be an array (/v1/models items omit it).
 */
export function isLiteLLMModelItem(value: unknown): value is RawModelItem {
	return rawModelItemSchema.safeParse(value).success;
}

/**
 * Parse an entry shaped like a /v1/model/info item: at least one usable model
 * identifier among model_name, litellm_params.model, model_info.key, and
 * model_info.id. The parsed entry carries its resolved model id; malformed
 * fields degrade to undefined rather than dropping the entry.
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

/**
 * Read a model's long-context tier costs from LiteLLM's threshold-suffixed
 * keys, e.g. input_cost_per_token_above_200k_tokens (the price map currently
 * carries above_128k/200k/256k/272k/512k variants). VS Code's pricing
 * metadata has exactly one long-context tier, so when a model declares more
 * than one threshold the lowest wins, and only fields declared at that
 * threshold are reported, so the four values always describe one boundary:
 * it is the first one a growing prompt crosses, so its prices are the ones a
 * user starts paying beyond the default tier. Only keys holding a usable
 * cost participate in that
 * selection, so a tier declared entirely in malformed values cannot mask a
 * well-formed higher one, and LiteLLM's non-tier variants (_priority keys,
 * above_1hr cache windows, per-character/image/audio/video costs) never
 * match the key pattern. All four fields come back explicitly (undefined
 * when absent) so spreading the result always overrides look-alike keys on
 * lenient pass-through entries.
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
			// `output_limit_source` marker (which feeds deriveTokenConstraints'
			// demotion rule) is cleared so a wire entry cannot forge it,
			// the four base costs are re-narrowed, and the long-context tier
			// costs are synthesized (same selection rule as model_info entries).
			providers.push({
				...entry,
				output_limit_source: undefined,
				input_cost_per_token: normalizeCostPerToken(entry.input_cost_per_token),
				output_cost_per_token: normalizeCostPerToken(entry.output_cost_per_token),
				cache_read_input_token_cost: normalizeCostPerToken(entry.cache_read_input_token_cost),
				cache_creation_input_token_cost: normalizeCostPerToken(entry.cache_creation_input_token_cost),
				...longContextCosts(entry),
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
 * One /v1/model/info entry after mapping: the resolved model id, the single
 * model_info-sourced provider built from its capability fields, and the input
 * modalities it advertises. A dedicated shape (rather than LiteLLMModelItem)
 * so deployment merging can rely on exactly one provider per entry at the
 * type level.
 */
export interface MappedModelInfo {
	id: string;
	provider: LiteLLMProvider;
	inputModalities: readonly string[];
}

/** A non-empty group of mapped entries sharing one model id. */
export type ModelDeployments = readonly [MappedModelInfo, ...MappedModelInfo[]];

/**
 * Map one parsed /v1/model/info entry to its MappedModelInfo. Total: the
 * parse already resolved the model id. Exported so tests can build deployment
 * entries through the same parse-and-map path production uses.
 */
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
		input_cost_per_token: normalizeCostPerToken(item.model_info?.input_cost_per_token),
		output_cost_per_token: normalizeCostPerToken(item.model_info?.output_cost_per_token),
		cache_read_input_token_cost: normalizeCostPerToken(item.model_info?.cache_read_input_token_cost),
		cache_creation_input_token_cost: normalizeCostPerToken(item.model_info?.cache_creation_input_token_cost),
		...longContextCosts(item.model_info),
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
 * Collapse the deployments of one load-balanced model_name into a single
 * entry advertising the conservative intersection of their capabilities.
 * LiteLLM reports one /v1/model/info entry per deployment, so without this a
 * load-balanced model would register duplicate ids and overwrite its own
 * routes.
 *
 * Token limits: the deployments' provider entries collapse through
 * collapseTokenConstraints (the one home of the min-collapse rule, shared
 * with registration's aggregates), and the collapsed effective values are
 * stored on the merged provider - but a field is stored ONLY when some
 * deployment reported it: deriveTokenConstraints fills an absent field with
 * exactly the defaults the collapse would have used, so the merged
 * advertisement is identical either way, while the capability baseline
 * (discoveredCapabilityBaseline) can still tell a server-reported minimum
 * from a defaults fill - a defaults-filled number stored as if reported
 * would occupy the walk's server level and block the catalog from
 * backfilling it. `defaults` is the refresh pass's one snapshot, threaded to
 * both this merge and registration, so the reproduction cannot drift when
 * settings change mid-refresh. This guarantees the merged advertisement
 * never exceeds what any deployment would have advertised on its own,
 * whichever combination of raw limit fields each one set. The stored input
 * limit is collapsed WITHOUT the defaultMaxInputTokens quirk (that setting
 * outranks even server-declared limits, so deriveTokenConstraints applies it
 * on top either way) and is stored whenever ANY limit was reported: the
 * collapse grounds a missing input limit in the reported context and output,
 * and re-deriving it from the collapsed pair can overstate it. Because a
 * defaults-filled deployment can contribute the output minimum, the merged
 * provider also records whether the stored output limit counts as
 * server-declared (the collapse's outputLimitSource); without the marker,
 * storing effective values back into provider fields would launder the
 * defaults guess into a declared limit.
 * Capability flags hold only when every deployment advertises them, and
 * input modalities and supported_openai_params intersect. Pricing carries
 * over only when every
 * deployment advertises the identical per-field cost: with differing prices
 * the proxy's routing decides which deployment (and cost) actually serves a
 * request, so advertising either number would lie, and the merged entry
 * drops that field instead. Long-context tier costs follow the same
 * per-field rule on their already threshold-resolved values: the host never
 * displays the boundary, so numerically identical tier prices merge honestly
 * even when the deployments' thresholds differ. Non-constraint metadata
 * (provider name, status, parameter order) follows the first deployment;
 * registration surfaces the provider name as the model family, so a merged
 * model's family is its first deployment's litellm_provider.
 */
export function mergeModelDeployments(deployments: ModelDeployments, defaults: TokenDefaults): MappedModelInfo {
	const [first, ...rest] = deployments;
	if (rest.length === 0) {
		return first;
	}
	const providers: [LiteLLMProvider, ...LiteLLMProvider[]] = [
		first.provider,
		...rest.map((deployment) => deployment.provider),
	];
	const collapsed = collapseTokenConstraints(providers, defaults);
	const quirkFreeInput = collapseTokenConstraints(providers, { ...defaults, maxInputTokens: undefined }).maxInputTokens;
	const contextReported = providers.some((p) => normalizePositiveNumber(p.context_length) !== undefined);
	const inputReported = providers.some((p) => normalizePositiveNumber(p.max_input_tokens) !== undefined);
	const outputReported = providers.some(
		(p) => (normalizePositiveNumber(p.max_output_tokens) ?? normalizePositiveNumber(p.max_tokens)) !== undefined
	);
	const anyLimitReported = contextReported || inputReported || outputReported;
	const provider: LiteLLMProvider = {
		provider: first.provider.provider,
		status: first.provider.status,
		supports_tools: providers.every(supportsTools),
		context_length: contextReported ? collapsed.contextLength : undefined,
		max_tokens: outputReported ? collapsed.maxOutputTokens : undefined,
		max_input_tokens: anyLimitReported ? quirkFreeInput : undefined,
		max_output_tokens: outputReported ? collapsed.maxOutputTokens : undefined,
		output_limit_source: collapsed.outputLimitSource,
		supports_prompt_caching: everyDeploymentSupports(providers.map((p) => p.supports_prompt_caching)),
		supports_response_schema: everyDeploymentSupports(providers.map((p) => p.supports_response_schema)),
		supports_reasoning: everyDeploymentSupports(providers.map((p) => p.supports_reasoning)),
		supports_pdf_input: everyDeploymentSupports(providers.map((p) => p.supports_pdf_input)),
		supported_openai_params: intersectSupportedParams(providers.map((p) => p.supported_openai_params)),
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
}

/**
 * The caller's expected-failure declarations, per endpoint: an expected
 * endpoint gets exactly one attempt (its retry budget drops to zero - the
 * failure is anticipated, so retrying only stretches the whole-call timeout),
 * and the nonfatal /model/info fallback log carries the "(expected)"
 * classification. Which endpoint's failure is terminal never changes: only a
 * /models failure aborts discovery, expected or not.
 */
export interface ExpectedDiscoveryFailures {
	readonly modelInfo: boolean;
	readonly modelListing: boolean;
}

export interface FetchModelsRequest {
	/** Transport for this server, from clients.ts; static auth and headers live there. */
	client: OpenAI;
	baseUrl: string;
	/** Pre-validated by settings.getDiscoveryTimeout(); used as-is. */
	discoveryTimeout: number;
	/**
	 * The refresh pass's one defaults snapshot, read at the top of the
	 * provider's refresh. Deployment merging bakes effective constraints with
	 * it, and registration derives constraints from the same snapshot, so the
	 * two stages cannot disagree when settings change mid-refresh.
	 */
	tokenDefaults: TokenDefaults;
	/** Failure categories the server's entry declares expected; see ExpectedDiscoveryFailures. */
	expected?: ExpectedDiscoveryFailures;
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

/**
 * The SDK only parses JSON when the response advertises a JSON content type;
 * anything else arrives as a string. Servers that return JSON with a missing
 * or wrong content-type header worked with the old response.json() transport,
 * so a string payload gets one JSON.parse attempt here.
 */
function coerceJsonPayload(value: unknown, baseUrl: string): unknown {
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		// V8's SyntaxError message quotes a snippet of the unparseable payload
		// (response-derived), so the classification keeps it off public
		// surfaces while the user-facing message keeps the diagnostic value.
		const reason = errorMessageText(error);
		throw new RequestError(l10n.t("Failed to parse LiteLLM models response from {0}: {1}", baseUrl, reason), "http", {
			logClassification: UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION,
			englishMessage: `Failed to parse LiteLLM models response from ${baseUrl}: ${reason}`,
		});
	}
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
}

/**
 * model_info.mode values that provably serve a non-chat endpoint: selecting
 * such an entry in the chat picker could only ever fail, so it must not
 * register. Deliberately not the inverse (an allow-list of chat modes):
 * an absent, null, or unrecognized mode keeps registering - never lose a
 * model to a vocabulary this extension has not learned yet.
 */
const NON_CHAT_MODES: readonly string[] = [
	"embedding",
	"image_generation",
	"audio_speech",
	"audio_transcription",
	"rerank",
	"moderation",
];

/**
 * Narrow a /v1/model/info payload element-wise. Entries with a model-info
 * identifier take the documented mapping (model_name first); entries shaped
 * like models-listing items pass through; anything else is skipped with a
 * log line instead of aborting the whole registration. Blocked (paused)
 * deployments and provably non-chat modes are dropped, and deployments
 * sharing one model id merge into a single model in first-seen order.
 */
function narrowModelInfoData(
	data: unknown[],
	tokenDefaults: TokenDefaults,
	log: FetchModelsRequest["log"]
): NarrowedModelInfoData {
	let usableEntryCount = 0;
	type Slot =
		| { kind: "deployments"; group: [MappedModelInfo, ...MappedModelInfo[]] }
		| { kind: "model"; model: LiteLLMModelItem };
	const slots: Slot[] = [];
	const deploymentsById = new Map<string, [MappedModelInfo, ...MappedModelInfo[]]>();
	for (const entry of data) {
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
		slot.kind === "deployments" ? toModelItem(mergeModelDeployments(slot.group, tokenDefaults)) : slot.model
	);
	return { models, usableEntryCount };
}

export async function fetchModels(request: FetchModelsRequest): Promise<FetchModelsResult> {
	const { client, baseUrl, discoveryTimeout, tokenDefaults, expected, headers, log } = request;

	log("Fetching from:", modelInfoUrl(baseUrl));

	try {
		// The per-request timeout keeps the SDK's own 600 s default from
		// overriding ours; boundedBySignal makes the signal a hard whole-call
		// bound across retries. Retries are safe here (idempotent GET) and stay
		// off for chat requests - and off entirely for an endpoint whose failure
		// the entry declares expected.
		const infoSignal = AbortSignal.timeout(discoveryTimeout);
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
			baseUrl
		);
		if (isRecord(parsedInfo) && Array.isArray(parsedInfo.data)) {
			const data: unknown[] = parsedInfo.data;
			log("Parsed model/info response:", { modelCount: data.length });

			const { models, usableEntryCount } = narrowModelInfoData(data, tokenDefaults, log);
			if (data.length > 0 && usableEntryCount === 0) {
				log("model/info returned data but no usable models; falling back", {
					dataLength: data.length,
					firstEntry: truncateForLog(data[0]),
				});
			} else {
				log("Successfully fetched models:", models.length);
				return { models };
			}
		} else {
			log("model/info response has no data array; falling back", { payload: truncateForLog(parsedInfo) });
		}
	} catch (error) {
		// Response-derived text can echo credentials into the issue-report
		// buffer (the raw SDK message and even mapped messages for non-401 API
		// errors embed the body), so the log carries only the classification.
		// When the entry declares this failure expected the same line carries
		// the "(expected)" marker - discovery's one expected-failure log seam,
		// because a /model/info failure is nonfatal and never reaches the
		// provider boundary.
		const mapped = mapSdkError(error, { surface: "discovery", baseUrl, timeoutMs: discoveryTimeout });
		const expectedNote = expected?.modelInfo === true ? " (expected: modelInfo)" : "";
		log(`model/info failed, falling back to ${modelsUrl(baseUrl)}${expectedNote}`, {
			error: mapped.name,
			...(mapped instanceof RequestError
				? { kind: mapped.kind, ...(mapped.status !== undefined ? { status: mapped.status } : {}) }
				: {}),
		});
	}

	log("Fetching from:", modelsUrl(baseUrl));
	const timeoutSignal = AbortSignal.timeout(discoveryTimeout);
	const errorContext = { surface: "discovery" as const, baseUrl, timeoutMs: discoveryTimeout };
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
			baseUrl
		);
	} catch (error) {
		if (timeoutSignal.aborted) {
			throw timeoutRequestError(errorContext, error);
		}
		if (error instanceof RequestError && error.logClassification === UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION) {
			throw error;
		}
		if (error instanceof SyntaxError) {
			// The SDK's own response.json() on a malformed application/json body:
			// same leak shape as coerceJsonPayload, same classification.
			throw new RequestError(
				l10n.t("Failed to parse LiteLLM models response from {0}: {1}", baseUrl, error.message),
				"http",
				{
					cause: error,
					logClassification: UNPARSEABLE_MODELS_RESPONSE_CLASSIFICATION,
					englishMessage: `Failed to parse LiteLLM models response from ${baseUrl}: ${error.message}`,
				}
			);
		}
		throw mapSdkError(error, errorContext);
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
	return { models };
}
