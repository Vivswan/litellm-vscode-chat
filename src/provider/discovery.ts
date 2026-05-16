import type {
	LiteLLMModelInfoItem,
	LiteLLMModelInfoResponse,
	LiteLLMModelItem,
	LiteLLMModelsResponse,
	LiteLLMProvider,
} from "../types";
import { normalizePositiveNumber } from "../shared/numbers";

export function mapModelInfoToLiteLLMModel(item: LiteLLMModelInfoItem): LiteLLMModelItem | undefined {
	const modelId = item.model_name ?? item.litellm_params?.model ?? item.model_info?.key ?? item.model_info?.id;

	if (!modelId) {
		return undefined;
	}

	const supportsTools = item.model_info?.supports_function_calling ?? item.model_info?.supports_tool_choice ?? true;
	const providerName = item.model_info?.litellm_provider ?? "litellm";
	const maxInputTokens = normalizePositiveNumber(item.model_info?.max_input_tokens);
	const maxOutputTokens =
		normalizePositiveNumber(item.model_info?.max_output_tokens) ??
		normalizePositiveNumber(item.model_info?.max_tokens);
	const maxTokens =
		normalizePositiveNumber(item.model_info?.max_tokens) ??
		normalizePositiveNumber(item.model_info?.max_output_tokens);

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
		object: "model",
		created: 0,
		owned_by: providerName,
		providers: [provider],
		architecture,
	};
}

export interface FetchModelsResult {
	models: LiteLLMModelItem[];
}

export async function fetchModels(
	apiKey: string,
	baseUrl: string,
	userAgent: string,
	log: (message: string, data?: unknown) => void,
	logError: (message: string, error: unknown) => void,
	discoveryTimeout?: number
): Promise<FetchModelsResult> {
	// Validate and clamp timeout to minimum 1000ms (second line of defense)
	const rawTimeout = discoveryTimeout ?? 30000;
	const timeout = Math.max(1000, Number.isFinite(rawTimeout) ? rawTimeout : 30000);
	if (rawTimeout !== timeout) {
		log("Invalid discoveryTimeout provided, using clamped value", {
			provided: rawTimeout,
			clamped: timeout,
		});
	}
	log("fetchModels called", { baseUrl, hasApiKey: !!apiKey });
	const headers: Record<string, string> = { "User-Agent": userAgent };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
		headers["X-API-Key"] = apiKey;
	}

	const readErrorText = async (resp: Response): Promise<string> => {
		let text = "";
		try {
			text = await resp.text();
		} catch (error) {
			logError("Failed to read response text", error);
		}
		return text;
	};

	const handleNonOk = async (resp: Response): Promise<never> => {
		const text = await readErrorText(resp);
		if (resp.status === 401) {
			const err = new Error(
				`Authentication failed: Your LiteLLM server requires an API key. Please run the "Manage LiteLLM Provider" command to configure your API key.`
			);
			logError("Authentication error", err);
			throw err;
		}

		const err = new Error(
			`Failed to fetch LiteLLM models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`
		);
		logError("Failed to fetch LiteLLM models", err);
		throw err;
	};

	log("Fetching from:", `${baseUrl}/v1/model/info`);

	try {
		const infoResp = await fetch(`${baseUrl}/v1/model/info`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(timeout),
		});
		log("Response status:", `${infoResp.status} ${infoResp.statusText}`);
		if (infoResp.ok) {
			const parsed = (await infoResp.json()) as LiteLLMModelInfoResponse | LiteLLMModelsResponse;
			const data = (parsed as LiteLLMModelInfoResponse).data ?? [];
			log("Parsed model/info response:", { modelCount: data.length });
			if (data.length > 0) {
				log("First model/info sample:", JSON.stringify(data[0], null, 2));
			}

			const first = data[0] as LiteLLMModelItem | undefined;
			if (first && typeof (first as LiteLLMModelItem).id === "string" && Array.isArray(first.providers)) {
				const models = data as LiteLLMModelItem[];
				log("Successfully fetched models:", models.length);
				return { models };
			}

			const models = data
				.map((item) => mapModelInfoToLiteLLMModel(item as LiteLLMModelInfoItem))
				.filter((m): m is LiteLLMModelItem => Boolean(m));
			if (data.length > 0 && models.length === 0) {
				log("model/info returned data but no mappable models; falling back", { dataLength: data.length });
			} else {
				log("Successfully fetched models:", models.length);
				return { models };
			}
		}
	} catch (error) {
		log("model/info failed, falling back to /v1/models", {
			message: error instanceof Error ? error.message : String(error),
		});
	}

	try {
		log("Fetching from:", `${baseUrl}/v1/models`);
		const resp = await fetch(`${baseUrl}/v1/models`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(timeout),
		});
		log("Response status:", `${resp.status} ${resp.statusText}`);
		if (!resp.ok) {
			await handleNonOk(resp);
		}
		const parsed = (await resp.json()) as LiteLLMModelsResponse;
		log("Parsed response:", {
			object: parsed.object,
			modelCount: parsed.data?.length ?? 0,
		});
		if (parsed.data && parsed.data.length > 0) {
			log("First model sample:", JSON.stringify(parsed.data[0], null, 2));
		}
		const models = parsed.data ?? [];
		log("Successfully fetched models:", models.length);
		return { models };
	} catch (fetchError) {
		const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
		const cause = (fetchError as Error & { cause?: unknown })?.cause;
		const causeMsg = cause instanceof Error ? cause.message : String(cause);

		if (causeMsg.includes("certificate has expired") || causeMsg.includes("CERT_HAS_EXPIRED")) {
			const err = new Error(
				`SSL Certificate Error: The SSL certificate for ${baseUrl} has expired. Please contact your LiteLLM server administrator to renew the certificate, or update your base URL.`
			);
			logError("Certificate error", err);
			throw err;
		} else if (causeMsg.includes("certificate") || errMsg.includes("certificate")) {
			const err = new Error(
				`SSL Certificate Error: There is an issue with the SSL certificate for ${baseUrl}. Error: ${causeMsg || errMsg}`
			);
			logError("Certificate error", err);
			throw err;
		} else if (causeMsg.includes("ENOTFOUND") || causeMsg.includes("ECONNREFUSED")) {
			const err = new Error(
				`Connection Error: Unable to connect to ${baseUrl}. Please check that the server is running and the URL is correct.`
			);
			logError("Connection error", err);
			throw err;
		} else {
			const err = new Error(
				`Network Error: Failed to fetch models from ${baseUrl}. ${errMsg}${causeMsg && causeMsg !== errMsg ? `. Cause: ${causeMsg}` : ""}`
			);
			logError("Network error", err);
			throw err;
		}
	}
}
