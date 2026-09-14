import * as http from "node:http";
import * as https from "node:https";

/**
 * The transport for every request whose budget may outlive undici's fixed 300 s idle clocks (headersTimeout,
 * bodyTimeout): the chat stream and the one-shot features, both bounded by chat.timeout. Node's http client has
 * no idle clock of its own, so the caller's AbortSignal is the only bound. The 30 s surfaces (OAuth exchange,
 * spend, OpenRouter catalog) stay on globalThis.fetch.
 *
 * Why not fetch with an undici Agent: the extension host's fetch patch (@vscode/proxy-agent) rebuilds the
 * dispatcher without timeouts whenever proxy support or system certificates are on, which is the default. The
 * same patch covers http.request and https.request with proxies and certificates: the host assigns the patched
 * functions onto the node:http module itself, so they must be read off the module at call time (msw proxies
 * them the same way), never destructured into a constant.
 *
 * Failure shapes mirror undici's so errorMapping classifies both transports through one pipeline:
 *   before headers  -> rejects TypeError("fetch failed", { cause })
 *   mid-body        -> body stream errors with TypeError("terminated", { cause })
 *   caller's abort  -> rejects, or errors the body, with signal.reason itself
 */
export type TransportFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
/** Never carried across an origin change: the three fetch strips, plus x-api-key, this extension's own auth carrier. */
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key"];
/** Dropped when a redirect turns the request into a bodiless GET, as the fetch spec lists them. */
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];

function fetchFailed(cause: unknown): TypeError {
	return new TypeError("fetch failed", { cause });
}

function terminated(cause: unknown): TypeError {
	return new TypeError("terminated", { cause });
}

/** Sets the same default content-type fetch would for the body kinds the transport accepts. */
function encodeBody(body: RequestInit["body"], headers: Headers): Buffer | undefined {
	if (body === undefined || body === null) {
		return undefined;
	}
	if (typeof body === "string") {
		if (!headers.has("content-type")) {
			headers.set("content-type", "text/plain;charset=UTF-8");
		}
		return Buffer.from(body, "utf8");
	}
	if (body instanceof URLSearchParams) {
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
		}
		return Buffer.from(body.toString(), "utf8");
	}
	if (body instanceof Uint8Array) {
		return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	}
	if (body instanceof ArrayBuffer) {
		return Buffer.from(body);
	}
	throw new TypeError("unsupported request body type");
}

/**
 * The response with its body already owned: the stream attached its listeners inside the headers callback, so
 * nothing the socket does between headers and the caller's first read can be missed. `fail` is where a late
 * req 'error' lands (Node emits one after res.destroy, and after a pre-response req.destroy); an unhandled one
 * would crash the host.
 */
interface Exchange {
	readonly res: http.IncomingMessage;
	readonly body: ReadableStream<Uint8Array>;
	readonly fail: (err: unknown) => void;
}

/** Backpressure rides pause/resume: a slow consumer stops the socket read instead of buffering the whole reply. */
function ownResponse(res: http.IncomingMessage, signal: AbortSignal | undefined): Omit<Exchange, "res"> {
	const onAbort = (): void => {
		res.destroy(signal?.reason);
	};
	let settled = false;
	let fail: (err: unknown) => void = () => undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const settle = (err?: unknown): void => {
				if (settled) {
					return;
				}
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				if (err === undefined) {
					controller.close();
				} else {
					controller.error(signal?.aborted ? signal.reason : terminated(err));
				}
			};
			fail = settle;
			// Node flushes what the socket already buffered after res.destroy(), so a cancelled stream still sees data.
			res.on("data", (chunk: Buffer) => {
				if (settled) {
					return;
				}
				controller.enqueue(chunk);
				if ((controller.desiredSize ?? 0) <= 0) {
					res.pause();
				}
			});
			res.on("end", () => settle());
			res.on("error", settle);
			if (signal?.aborted) {
				onAbort();
			} else {
				signal?.addEventListener("abort", onAbort, { once: true });
			}
		},
		pull() {
			res.resume();
		},
		cancel() {
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			res.destroy();
		},
	});
	return { body, fail };
}

/** Drops a response the caller never sees; cancelling a body that already errored rejects with that error. */
function discard(exchange: Exchange): void {
	exchange.body.cancel().catch(() => undefined);
}

function requestOnce(
	url: URL,
	method: string,
	headers: Headers,
	body: Buffer | undefined,
	signal: AbortSignal | undefined
): Promise<Exchange> {
	return new Promise<Exchange>((resolve, reject) => {
		const client = url.protocol === "https:" ? https : http;
		let exchange: Exchange | undefined;
		let pending = true;
		const settlePending = (outcome: () => void): void => {
			if (!pending) {
				return;
			}
			pending = false;
			signal?.removeEventListener("abort", onAbort);
			outcome();
		};
		const onAbort = (): void => {
			settlePending(() => reject(signal?.reason));
			req.destroy();
		};
		const req = client.request(url.href, { method, headers: Object.fromEntries(headers) }, (res) => {
			exchange = { res, ...ownResponse(res, signal) };
			settlePending(() => resolve(exchange as Exchange));
		});
		req.on("error", (err) => {
			if (exchange === undefined) {
				settlePending(() => reject(fetchFailed(err)));
			} else {
				exchange.fail(err);
			}
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		req.end(body);
	});
}

function toResponse(exchange: Exchange, method: string): Response {
	const { res } = exchange;
	const status = res.statusCode ?? 0;
	const headers = new Headers();
	for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
		headers.append(res.rawHeaders[i] as string, res.rawHeaders[i + 1] as string);
	}
	const init = { status, statusText: res.statusMessage ?? "", headers };
	if (NULL_BODY_STATUSES.has(status) || method === "HEAD") {
		discard(exchange);
		return new Response(null, init);
	}
	return new Response(exchange.body, init);
}

export async function nodeHttpFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const signal = init.signal ?? undefined;
	if (signal?.aborted) {
		throw signal.reason;
	}
	let url: URL;
	let body: Buffer | undefined;
	const headers = new Headers(init.headers);
	try {
		url = new URL(input);
		body = encodeBody(init.body, headers);
	} catch (err) {
		throw fetchFailed(err);
	}
	let method = (init.method ?? "GET").toUpperCase();
	for (let hop = 0; ; hop++) {
		if (signal?.aborted) {
			throw signal.reason;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw fetchFailed(new TypeError(`unsupported protocol ${url.protocol}`));
		}
		if (body !== undefined) {
			headers.set("content-length", String(body.byteLength));
		}
		const exchange = await requestOnce(url, method, headers, body, signal);
		const status = exchange.res.statusCode ?? 0;
		const location = exchange.res.headers.location;
		if (!REDIRECT_STATUSES.has(status) || location === undefined || init.redirect === "manual") {
			return toResponse(exchange, method);
		}
		// A discarded response is cancelled, not drained: draining an unbounded body would outlive the caller's signal.
		discard(exchange);
		if (init.redirect === "error") {
			throw fetchFailed(new TypeError("unexpected redirect"));
		}
		if (hop >= MAX_REDIRECTS) {
			throw fetchFailed(new TypeError("redirect count exceeded"));
		}
		let next: URL;
		try {
			next = new URL(location, url);
		} catch (err) {
			throw fetchFailed(err);
		}
		if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
			method = "GET";
			body = undefined;
			for (const name of BODY_HEADERS) {
				headers.delete(name);
			}
		}
		if (next.origin !== url.origin) {
			for (const name of CREDENTIAL_HEADERS) {
				headers.delete(name);
			}
		}
		url = next;
	}
}
