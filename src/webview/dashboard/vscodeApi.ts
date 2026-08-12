/**
 * The webview's posting seam: acquireVsCodeApi (callable exactly once per
 * page) wrapped as one typed request sender. Every message the page posts is
 * a request envelope with a fresh correlation id; the id returns to the
 * caller so hooks can match the response, ack, or fail envelope that echoes
 * it.
 */

import type { DashboardMethod, RequestPayload, RpcRequest } from "../../dashboard/endpoints";

interface VsCodeWebviewApi {
	postMessage(message: unknown): void;
}

/** Provided by the webview host at runtime; callable exactly once per page. */
declare const acquireVsCodeApi: () => VsCodeWebviewApi;

const api = acquireVsCodeApi();

function newRequestId(): string {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi?.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Post one typed request to the extension; returns the minted correlation id. */
export function sendRequest<K extends DashboardMethod>(method: K, payload: RequestPayload<K>): string {
	const id = newRequestId();
	const request: RpcRequest<K> = { kind: "request", id, method, payload };
	api.postMessage(request);
	return id;
}
