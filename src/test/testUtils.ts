import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../provider";
import { Logger } from "../shared/logger";

export function toHeaderMap(headersInit: RequestInit["headers"] | undefined): Record<string, string> {
	if (!headersInit) {
		return {};
	}
	const mapped: Record<string, string> = {};
	new Headers(headersInit).forEach((value, key) => {
		mapped[key] = value;
	});
	return mapped;
}

export type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Run `fn` with `global.fetch` replaced by `mock`, restoring the original
 * fetch even when the body throws so one failing test cannot cascade.
 */
export async function withFetch<T>(mock: FetchMock, fn: () => Promise<T>): Promise<T> {
	const originalFetch = global.fetch;
	global.fetch = mock as unknown as typeof fetch;
	try {
		return await fn();
	} finally {
		global.fetch = originalFetch;
	}
}

/**
 * Run `fn` with `vscode.workspace.getConfiguration` overridden for the
 * "litellm-vscode-chat" section. Keys present in `sectionValues` are returned
 * as-is (including explicit null); absent keys fall back to the caller's
 * default value. Other sections delegate to the real implementation. The
 * original function is restored in a finally block.
 */
export async function withConfig<T>(
	sectionValues: Record<string, unknown>,
	fn: () => T | Promise<T>
): Promise<Awaited<T>> {
	const originalGetConfiguration = vscode.workspace.getConfiguration;
	vscode.workspace.getConfiguration = ((section?: string, scope?: vscode.ConfigurationScope | null) => {
		if (section === "litellm-vscode-chat") {
			return {
				get: (key: string, defaultValue?: unknown) =>
					Object.hasOwn(sectionValues, key) ? sectionValues[key] : defaultValue,
			} as unknown as vscode.WorkspaceConfiguration;
		}
		return originalGetConfiguration(section, scope);
	}) as unknown as typeof vscode.workspace.getConfiguration;
	try {
		return await fn();
	} finally {
		vscode.workspace.getConfiguration = originalGetConfiguration;
	}
}

/**
 * Create a provider wired to a single configured server, or to an empty
 * server list when `baseUrl` is omitted (the "not configured" case).
 */
export function makeProvider(
	baseUrl?: string,
	apiKey = "test-key",
	outputChannel?: vscode.OutputChannel
): LiteLLMChatModelProvider {
	const logger = outputChannel ? new Logger(outputChannel) : undefined;
	const provider = new LiteLLMChatModelProvider("GitHubCopilotChat/test VSCode/test", logger);
	const servers = baseUrl === undefined ? [] : [{ id: "srv1", label: "Default", baseUrl, apiKey }];
	provider.setServerProvider(() => Promise.resolve(servers));
	return provider;
}

export function createConfiguredProvider(): LiteLLMChatModelProvider {
	return makeProvider("http://test");
}

export function jsonResponse(payload: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		json: async () => payload,
		text: async () => JSON.stringify(payload),
	} as unknown as Response;
}

export function makeModelInfo(
	overrides: Partial<Record<keyof vscode.LanguageModelChatInformation, unknown>> = {}
): vscode.LanguageModelChatInformation {
	return {
		id: "test-model",
		name: "test-model",
		family: "litellm",
		version: "1.0.0",
		maxInputTokens: 100000,
		maxOutputTokens: 8000,
		capabilities: {},
		...overrides,
	} as unknown as vscode.LanguageModelChatInformation;
}

export function userMessage(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart(text)],
		name: undefined,
	};
}

/** VS Code sends role 3 for system messages via a proposed API; the stable enum has no System member. */
export function systemMessage(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: 3 as vscode.LanguageModelChatMessageRole,
		content: [new vscode.LanguageModelTextPart(text)],
		name: undefined,
	};
}

export function sseStream(text: string): ReadableStream<Uint8Array> {
	const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	});
}

/**
 * A /v1/model/info discovery payload registering "test-model" with the same
 * token limits as `makeModelInfo()`. Prompt caching is not advertised.
 */
export const DEFAULT_DISCOVERY_PAYLOAD = {
	data: [
		{
			model_name: "test-model",
			model_info: {
				id: "test-model",
				supports_function_calling: true,
				max_input_tokens: 100000,
				max_output_tokens: 8000,
			},
		},
	],
};

export interface CapturedRequest {
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

export interface CaptureRequestOverrides {
	messages?: vscode.LanguageModelChatRequestMessage[];
	discoveryPayload?: unknown;
}

/**
 * Run model discovery followed by a chat request against a fetch mock that
 * dispatches on URL: discovery endpoints return `discoveryPayload` (default:
 * a valid "test-model" listing), and POST /v1/chat/completions captures the
 * request body and headers before answering with a minimal SSE stream.
 */
export async function captureRequest(
	provider: LiteLLMChatModelProvider,
	model: vscode.LanguageModelChatInformation,
	opts: unknown,
	overrides: CaptureRequestOverrides = {}
): Promise<CapturedRequest> {
	let capturedBody: Record<string, unknown> = {};
	let capturedHeaders: Record<string, string> = {};
	const discoveryPayload = overrides.discoveryPayload ?? DEFAULT_DISCOVERY_PAYLOAD;
	await withFetch(
		async (url, init) => {
			const urlStr = url.toString();
			if ((init?.method ?? "GET") === "POST" && urlStr.includes("/v1/chat/completions")) {
				capturedBody = JSON.parse(init?.body as string);
				capturedHeaders = toHeaderMap(init?.headers);
				return { ok: true, body: sseStream("ok") } as unknown as Response;
			}
			if (urlStr.includes("/v1/model/info") || urlStr.includes("/v1/models")) {
				return jsonResponse(discoveryPayload);
			}
			throw new Error(`Unexpected request in captureRequest: ${init?.method ?? "GET"} ${urlStr}`);
		},
		async () => {
			await provider.provideLanguageModelChatInformation({ silent: true }, new vscode.CancellationTokenSource().token);
			await provider.provideLanguageModelChatResponse(
				model,
				overrides.messages ?? [userMessage("test")],
				opts as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: () => {} },
				new vscode.CancellationTokenSource().token
			);
		}
	);
	return { body: capturedBody, headers: capturedHeaders };
}

export async function captureRequestBody(
	provider: LiteLLMChatModelProvider,
	model: vscode.LanguageModelChatInformation,
	opts: unknown,
	overrides: CaptureRequestOverrides = {}
): Promise<Record<string, unknown>> {
	return (await captureRequest(provider, model, opts, overrides)).body;
}
