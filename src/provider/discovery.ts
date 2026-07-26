import type OpenAI from "openai";
import { normalizePositiveNumber } from "../shared/numbers";
import type { LiteLLMArchitecture, LiteLLMModelInfoItem, LiteLLMModelItem, LiteLLMProvider } from "../types";
import { isRecord } from "../types";
import { mapSdkError, RequestError, timeoutMessage } from "./errorMapping";

/** Wire-shape entry accepted from either discovery endpoint; /v1/models entries carry no providers. */
interface RawModelItem {
	id: string;
	providers?: unknown[];
	architecture?: LiteLLMArchitecture;
}

/**
 * Accept an entry shaped like a models-listing item: `id` must be a string
 * and `providers`, when present, must be an array (/v1/models items omit it).
 */
export function isLiteLLMModelItem(value: unknown): value is RawModelItem {
	if (!isRecord(value) || typeof value.id !== "string") {
		return false;
	}
	return value.providers === undefined || Array.isArray(value.providers);
}

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

/** The model identifier of a /v1/model/info entry, in documented priority order. */
function modelInfoId(value: Record<string, unknown>): string | undefined {
	const litellmParams = isRecord(value.litellm_params) ? value.litellm_params : undefined;
	const modelInfo = isRecord(value.model_info) ? value.model_info : undefined;
	return firstNonEmptyString(value.model_name, litellmParams?.model, modelInfo?.key, modelInfo?.id);
}

/**
 * Accept an entry shaped like a /v1/model/info item: at least one usable
 * model identifier among model_name, litellm_params.model, model_info.key,
 * and model_info.id.
 */
export function isLiteLLMModelInfoItem(value: unknown): value is LiteLLMModelInfoItem {
	return isRecord(value) && modelInfoId(value) !== undefined;
}

function isProviderEntry(value: unknown): value is LiteLLMProvider {
	return isRecord(value) && typeof value.provider === "string";
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
	return { id: raw.id, providers, architecture: raw.architecture };
}

function truncateForLog(value: unknown): string {
	try {
		return JSON.stringify(value)?.slice(0, 300) ?? String(value);
	} catch {
		return String(value);
	}
}

export function mapModelInfoToLiteLLMModel(item: LiteLLMModelInfoItem): LiteLLMModelItem | undefined {
	const modelId = modelInfoId(item as unknown as Record<string, unknown>);

	if (!modelId) {
		return undefined;
	}

	const supportsTools = item.model_info?.supports_function_calling ?? item.model_info?.supports_tool_choice ?? true;
	const providerName = item.model_info?.litellm_provider ?? "litellm";
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
	};

	const inputModalities: string[] = [];
	if (item.model_info?.supports_vision) {
		inputModalities.push("image");
	}
	if (item.model_info?.supports_pdf_input) {
		inputModalities.push("pdf");
	}
	const architecture = inputModalities.length > 0 ? { input_modalities: inputModalities } : undefined;

	return {
		id: modelId,
		providers: [provider],
		architecture,
	};
}

export interface FetchModelsResult {
	models: LiteLLMModelItem[];
}

export interface FetchModelsRequest {
	/** Transport for this server, from clients.ts; auth and headers live there. */
	client: OpenAI;
	baseUrl: string;
	/** Pre-validated by settings.getDiscoveryTimeout(); used as-is. */
	discoveryTimeout: number;
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

/**
 * Narrow a /v1/model/info payload element-wise. Entries with a model-info
 * identifier take the documented mapping (model_name first); entries shaped
 * like models-listing items pass through; anything else is skipped with a
 * log line instead of aborting the whole registration.
 */
function narrowModelInfoData(data: unknown[], log: FetchModelsRequest["log"]): LiteLLMModelItem[] {
	const models: LiteLLMModelItem[] = [];
	for (const entry of data) {
		if (isLiteLLMModelInfoItem(entry)) {
			const mapped = mapModelInfoToLiteLLMModel(entry);
			if (mapped) {
				models.push(mapped);
				continue;
			}
		}
		if (isLiteLLMModelItem(entry)) {
			models.push(normalizeModelItem(entry, log));
			continue;
		}
		log("Skipping malformed model/info entry", { entry: truncateForLog(entry) });
	}
	return models;
}

export async function fetchModels(request: FetchModelsRequest): Promise<FetchModelsResult> {
	const { client, baseUrl, discoveryTimeout, log } = request;

	log("Fetching from:", `${baseUrl}/v1/model/info`);

	try {
		// The per-request timeout keeps the SDK's own 600 s default from
		// overriding ours; boundedBySignal makes the signal a hard whole-call
		// bound across retries. Retries are safe here (idempotent GET) and stay
		// off for chat requests.
		const infoSignal = AbortSignal.timeout(discoveryTimeout);
		const parsedInfo: unknown = coerceJsonPayload(
			await boundedBySignal(
				client.get("/model/info", { signal: infoSignal, timeout: discoveryTimeout, maxRetries: 2 }),
				infoSignal
			),
			baseUrl
		);
		if (isRecord(parsedInfo) && Array.isArray(parsedInfo.data)) {
			const data: unknown[] = parsedInfo.data;
			log("Parsed model/info response:", { modelCount: data.length });

			const models = narrowModelInfoData(data, log);
			if (data.length > 0 && models.length === 0) {
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
				client.get("/models", { signal: timeoutSignal, timeout: discoveryTimeout, maxRetries: 2 }),
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
