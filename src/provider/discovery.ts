import { normalizePositiveNumber } from "../shared/numbers";
import type { ServerWithKey } from "../shared/servers";
import type { LiteLLMArchitecture, LiteLLMModelInfoItem, LiteLLMModelItem, LiteLLMProvider } from "../types";
import { isRecord } from "../types";

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
	server: ServerWithKey;
	userAgent: string;
	customHeaders: Record<string, string>;
	/** Pre-validated by settings.getDiscoveryTimeout(); used as-is. */
	discoveryTimeout: number;
	log: (message: string, data?: unknown) => void;
}

function classifyNetworkError(fetchError: unknown, baseUrl: string): Error {
	const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
	const cause = (fetchError as Error & { cause?: unknown })?.cause;
	const causeMsg = cause === undefined ? "" : cause instanceof Error ? cause.message : String(cause);

	if (causeMsg.includes("certificate has expired") || causeMsg.includes("CERT_HAS_EXPIRED")) {
		return new Error(
			`SSL Certificate Error: The SSL certificate for ${baseUrl} has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.`
		);
	}
	if (causeMsg.includes("certificate") || errMsg.includes("certificate")) {
		return new Error(
			`SSL Certificate Error: There is an issue with the SSL certificate for ${baseUrl}. Error: ${causeMsg || errMsg}`
		);
	}
	if (causeMsg.includes("ENOTFOUND") || causeMsg.includes("ECONNREFUSED")) {
		return new Error(
			`Connection Error: Unable to connect to ${baseUrl}. Please check that the server is running and the URL is correct.`
		);
	}
	return new Error(
		`Network Error: Failed to fetch models from ${baseUrl}. ${errMsg}${causeMsg && causeMsg !== errMsg ? `. Cause: ${causeMsg}` : ""}`
	);
}

async function raiseHttpError(resp: Response): Promise<never> {
	let text = "";
	try {
		text = await resp.text();
	} catch {
		// Best effort; the status line alone is still actionable.
	}
	if (resp.status === 401) {
		throw new Error(
			`Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.`
		);
	}
	throw new Error(`Failed to fetch LiteLLM models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`);
}

function extractDataArray(parsed: unknown): unknown[] {
	return isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
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
	const { userAgent, customHeaders, discoveryTimeout, log } = request;
	const { apiKey, baseUrl } = request.server;
	log("fetchModels called", { baseUrl, hasApiKey: !!apiKey });
	const headers: Record<string, string> = { ...customHeaders, "User-Agent": userAgent };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
		headers["X-API-Key"] = apiKey;
	}

	log("Fetching from:", `${baseUrl}/v1/model/info`);

	try {
		const infoResp = await fetch(`${baseUrl}/v1/model/info`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(discoveryTimeout),
		});
		log("Response status:", `${infoResp.status} ${infoResp.statusText}`);
		if (infoResp.ok) {
			const parsedInfo: unknown = await infoResp.json();
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
		}
	} catch (error) {
		log("model/info failed, falling back to /v1/models", {
			message: error instanceof Error ? error.message : String(error),
		});
	}

	log("Fetching from:", `${baseUrl}/v1/models`);
	let resp: Response;
	try {
		resp = await fetch(`${baseUrl}/v1/models`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(discoveryTimeout),
		});
	} catch (fetchError) {
		throw classifyNetworkError(fetchError, baseUrl);
	}
	log("Response status:", `${resp.status} ${resp.statusText}`);
	// HTTP-status errors are classified here, outside the network-error path,
	// so a 401 is never re-wrapped as a generic network failure.
	if (!resp.ok) {
		await raiseHttpError(resp);
	}

	let parsed: unknown;
	try {
		parsed = await resp.json();
	} catch (parseError) {
		const msg = parseError instanceof Error ? parseError.message : String(parseError);
		throw new Error(`Failed to parse LiteLLM models response from ${baseUrl}: ${msg}`);
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
