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
