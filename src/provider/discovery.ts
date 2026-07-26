import type OpenAI from "openai";
import { isRecord } from "../shared/json";
import { normalizeCostPerToken, normalizePositiveNumber } from "../shared/numbers";
import type { TokenDefaults } from "../shared/settings";
import { mapSdkError, RequestError, timeoutMessage } from "./errorMapping";
import { deriveTokenConstraints } from "./modelCatalog";
import type {
	LiteLLMArchitecture,
	LiteLLMModelInfoItem,
	LiteLLMModelItem,
	LiteLLMProvider,
	RawModelItem,
} from "./schemas";
import { modelInfoId, providerEntrySchema, rawModelInfoItemSchema, rawModelItemSchema } from "./schemas";

/**
 * Accept an entry shaped like a models-listing item: `id` must be a string
 * and `providers`, when present, must be an array (/v1/models items omit it).
 */
export function isLiteLLMModelItem(value: unknown): value is RawModelItem {
	return rawModelItemSchema.safeParse(value).success;
}

/**
 * Accept an entry shaped like a /v1/model/info item: at least one usable
 * model identifier among model_name, litellm_params.model, model_info.key,
 * and model_info.id.
 */
export function isLiteLLMModelInfoItem(value: unknown): value is LiteLLMModelInfoItem {
	return rawModelInfoItemSchema.safeParse(value).success;
}

function isProviderEntry(value: unknown): value is LiteLLMProvider {
	return providerEntrySchema.safeParse(value).success;
}

function normalizeModelItem(raw: RawModelItem, log: FetchModelsRequest["log"]): LiteLLMModelItem {
	const providers: LiteLLMProvider[] = [];
	for (const entry of raw.providers ?? []) {
		if (isProviderEntry(entry)) {
			providers.push(entry);
		} else {
			log("Skipping malformed provider entry", { modelId: raw.id, entry: truncateForLog(entry) });
		}
	}
	// The architecture field is read on the same trust basis as the rest of the
	// entry: shape-checked only where registration actually consumes it.
	return { id: raw.id, providers, architecture: raw.architecture as LiteLLMArchitecture | undefined };
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
 * Map one /v1/model/info entry to its MappedModelInfo. Exported so tests can
 * build deployment entries through the same mapping the production path uses.
 */
export function mapModelInfoEntry(item: LiteLLMModelInfoItem): MappedModelInfo | undefined {
	const modelId = modelInfoId(item);

	if (!modelId) {
		return undefined;
	}

	const supportsTools = item.model_info?.supports_function_calling ?? item.model_info?.supports_tool_choice ?? true;
	// The lenient schema lets a non-string litellm_provider through; anything
	// but a string must not reach the host as the model family.
	const rawProvider = item.model_info?.litellm_provider;
	const providerName = typeof rawProvider === "string" ? rawProvider : "litellm";
	const maxInputTokens = normalizePositiveNumber(item.model_info?.max_input_tokens);
	const maxOutputTokens =
		normalizePositiveNumber(item.model_info?.max_output_tokens) ?? normalizePositiveNumber(item.model_info?.max_tokens);
	const maxTokens =
		normalizePositiveNumber(item.model_info?.max_tokens) ?? normalizePositiveNumber(item.model_info?.max_output_tokens);

	const provider: LiteLLMProvider = {
		provider: providerName,
		status: "ok",
		supports_tools: supportsTools,
		context_length: maxInputTokens ?? maxTokens,
		max_tokens: maxTokens,
		max_input_tokens: maxInputTokens,
		max_output_tokens: maxOutputTokens,
		source: "model_info",
		supports_prompt_caching: item.model_info?.supports_prompt_caching ?? null,
		supports_response_schema: item.model_info?.supports_response_schema ?? null,
		supports_reasoning: item.model_info?.supports_reasoning ?? null,
		supports_pdf_input: item.model_info?.supports_pdf_input ?? null,
		supported_openai_params: item.model_info?.supported_openai_params ?? null,
		input_cost_per_token: normalizeCostPerToken(item.model_info?.input_cost_per_token),
		output_cost_per_token: normalizeCostPerToken(item.model_info?.output_cost_per_token),
		cache_read_input_token_cost: normalizeCostPerToken(item.model_info?.cache_read_input_token_cost),
		cache_creation_input_token_cost: normalizeCostPerToken(item.model_info?.cache_creation_input_token_cost),
	};

	const inputModalities: string[] = [];
	if (item.model_info?.supports_vision) {
		inputModalities.push("image");
	}
	if (item.model_info?.supports_pdf_input) {
		inputModalities.push("pdf");
	}

	return { id: modelId, provider, inputModalities };
}

function toModelItem(mapped: MappedModelInfo): LiteLLMModelItem {
	return {
		id: mapped.id,
		providers: [mapped.provider],
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
 * Token limits: each deployment's standalone constraints are derived through
 * deriveTokenConstraints (the same rules registration applies), the per-field
 * minimum is taken, and those effective values are stored on the merged
 * provider, which deriveTokenConstraints reproduces verbatim: `defaults` is
 * the refresh pass's one snapshot, threaded to both this merge and
 * registration, so the reproduction cannot drift when settings change
 * mid-refresh. This guarantees the merged advertisement never exceeds what
 * any deployment would have advertised on its own, whichever combination of
 * raw limit fields each one set. Capability flags hold only when every
 * deployment advertises them, and input modalities and
 * supported_openai_params intersect. Pricing carries over only when every
 * deployment advertises the identical per-field cost: with differing prices
 * the proxy's routing decides which deployment (and cost) actually serves a
 * request, so advertising either number would lie, and the merged entry
 * drops that field instead. Non-constraint metadata (provider name,
 * status, parameter order) follows the first deployment; registration
 * surfaces the provider name as the model family, so a merged model's family
 * is its first deployment's litellm_provider.
 */
export function mergeModelDeployments(deployments: ModelDeployments, defaults: TokenDefaults): MappedModelInfo {
	const [first, ...rest] = deployments;
	if (rest.length === 0) {
		return first;
	}
	const providers = deployments.map((deployment) => deployment.provider);
	const standalone = providers.map((p) => deriveTokenConstraints(p, defaults));
	const maxOutputTokens = Math.min(...standalone.map((c) => c.maxOutputTokens));
	const contextLength = Math.min(...standalone.map((c) => c.contextLength));
	const maxInputTokens = Math.min(...standalone.map((c) => c.maxInputTokens));
	const provider: LiteLLMProvider = {
		provider: first.provider.provider,
		status: first.provider.status,
		supports_tools: providers.every((p) => p.supports_tools !== false),
		context_length: contextLength,
		max_tokens: maxOutputTokens,
		max_input_tokens: maxInputTokens,
		max_output_tokens: maxOutputTokens,
		source: "model_info",
		supports_prompt_caching: everyDeploymentSupports(providers.map((p) => p.supports_prompt_caching)),
		supports_response_schema: everyDeploymentSupports(providers.map((p) => p.supports_response_schema)),
		supports_reasoning: everyDeploymentSupports(providers.map((p) => p.supports_reasoning)),
		supports_pdf_input: everyDeploymentSupports(providers.map((p) => p.supports_pdf_input)),
		supported_openai_params: intersectSupportedParams(providers.map((p) => p.supported_openai_params)),
		input_cost_per_token: agreedCost(providers.map((p) => p.input_cost_per_token)),
		output_cost_per_token: agreedCost(providers.map((p) => p.output_cost_per_token)),
		cache_read_input_token_cost: agreedCost(providers.map((p) => p.cache_read_input_token_cost)),
		cache_creation_input_token_cost: agreedCost(providers.map((p) => p.cache_creation_input_token_cost)),
	};
	const inputModalities = first.inputModalities.filter((modality) =>
		rest.every((deployment) => deployment.inputModalities.includes(modality))
	);
	return { id: first.id, provider, inputModalities };
}

export interface FetchModelsResult {
	models: LiteLLMModelItem[];
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
	/** Per-request headers resolved by the caller, e.g. a freshly exchanged OAuth bearer token. */
	headers?: Record<string, string>;
	log: (message: string, data?: unknown) => void;
}

function extractDataArray(parsed: unknown): unknown[] {
	return isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
}

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
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse LiteLLM models response from ${baseUrl}: ${msg}`);
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
 * Narrow a /v1/model/info payload element-wise. Entries with a model-info
 * identifier take the documented mapping (model_name first); entries shaped
 * like models-listing items pass through; anything else is skipped with a
 * log line instead of aborting the whole registration. Blocked (paused)
 * deployments are dropped, and deployments sharing one model id merge into a
 * single model in first-seen order.
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
		if (isLiteLLMModelInfoItem(entry)) {
			const mapped = mapModelInfoEntry(entry);
			if (mapped) {
				usableEntryCount += 1;
				if (entry.model_info?.blocked === true) {
					log("Skipping blocked model/info entry", { modelId: mapped.id });
					continue;
				}
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
	const { client, baseUrl, discoveryTimeout, tokenDefaults, headers, log } = request;

	log("Fetching from:", `${baseUrl}/v1/model/info`);

	try {
		// The per-request timeout keeps the SDK's own 600 s default from
		// overriding ours; boundedBySignal makes the signal a hard whole-call
		// bound across retries. Retries are safe here (idempotent GET) and stay
		// off for chat requests.
		const infoSignal = AbortSignal.timeout(discoveryTimeout);
		const parsedInfo: unknown = coerceJsonPayload(
			await boundedBySignal(
				client.get("/model/info", { signal: infoSignal, timeout: discoveryTimeout, maxRetries: 2, headers }),
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
		log("model/info failed, falling back to /v1/models", {
			message: error instanceof Error ? error.message : String(error),
		});
	}

	log("Fetching from:", `${baseUrl}/v1/models`);
	const timeoutSignal = AbortSignal.timeout(discoveryTimeout);
	const errorContext = { surface: "discovery" as const, baseUrl, timeoutMs: discoveryTimeout };
	let parsed: unknown;
	try {
		parsed = coerceJsonPayload(
			await boundedBySignal(
				client.get("/models", { signal: timeoutSignal, timeout: discoveryTimeout, maxRetries: 2, headers }),
				timeoutSignal
			),
			baseUrl
		);
	} catch (error) {
		if (timeoutSignal.aborted) {
			throw new RequestError(timeoutMessage(errorContext), "timeout", { cause: error });
		}
		if (error instanceof Error && error.message.startsWith("Failed to parse LiteLLM models response")) {
			throw error;
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse LiteLLM models response from ${baseUrl}: ${error.message}`);
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
