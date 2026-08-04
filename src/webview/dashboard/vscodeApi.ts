import type { WebviewToExtensionMessage } from "../../extension/dashboard/protocol";

interface VsCodeWebviewApi {
	postMessage(message: unknown): void;
}

/** Provided by the webview host at runtime; callable exactly once per page. */
declare const acquireVsCodeApi: () => VsCodeWebviewApi;

const api = acquireVsCodeApi();

/** Post one typed intent to the extension. */
export function postMessage(message: WebviewToExtensionMessage): void {
	api.postMessage(message);
}

/** A correlation ID for one posted request; matched against the response or outcome notice it echoes. */
export function newRequestId(): string {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi?.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
