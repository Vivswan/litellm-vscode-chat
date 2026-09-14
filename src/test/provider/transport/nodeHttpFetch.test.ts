import * as assert from "node:assert";
import { getEventListeners } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { nodeHttpFetch } from "../../../provider/transport/nodeHttpFetch";

interface Echo {
	method: string;
	body: string;
	headers: Record<string, string | undefined>;
}

/**
 * The routes the adapter is exercised against. `peer` is the other origin, so a
 * cross-origin redirect can be observed end to end on real sockets.
 */
function routes(peer: () => string): http.RequestListener {
	return (req, res) => {
		const path = req.url ?? "/";
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString();
			// No keep-alive: a socket outliving its response would be the client holding it, which the tests assert on.
			res.setHeader("connection", "close");
			switch (path) {
				case "/echo": {
					const echo: Echo = {
						method: req.method ?? "",
						body,
						headers: {
							authorization: req.headers.authorization,
							"x-api-key": req.headers["x-api-key"] as string | undefined,
							cookie: req.headers.cookie,
							"proxy-authorization": req.headers["proxy-authorization"],
							"x-custom": req.headers["x-custom"] as string | undefined,
							"content-type": req.headers["content-type"],
							"content-length": req.headers["content-length"],
						},
					};
					res.writeHead(200, { "content-type": "application/json", "x-echo": "yes" });
					res.end(JSON.stringify(echo));
					return;
				}
				case "/stream":
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write("one");
					setTimeout(() => {
						res.write("two");
						res.end();
					}, 1500);
					return;
				case "/firehose": {
					res.writeHead(200, { "content-type": "application/octet-stream" });
					const chunk = Buffer.alloc(64 * 1024, 120);
					const pump = (): void => {
						if (res.destroyed) {
							return;
						}
						res.write(chunk);
						setImmediate(pump);
					};
					pump();
					return;
				}
				case "/stream-hang":
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write("one");
					return;
				case "/hang":
					return;
				case "/malformed-chunk":
					// Headers, then a chunk-size line the parser rejects: the failure lands in the gap between the
					// headers callback and the caller's first read.
					req.socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\nZ\r\n");
					return;
				case "/kill":
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write("one");
					setTimeout(() => res.destroy(), 50);
					return;
				case "/204":
					res.writeHead(204, { "x-empty": "yes" });
					res.end();
					return;
				case "/redirect/307":
					res.writeHead(307, { location: "/echo" });
					res.end();
					return;
				case "/redirect/302":
					res.writeHead(302, { location: "/echo" });
					res.end();
					return;
				case "/redirect/cross":
					res.writeHead(302, { location: `${peer()}/echo` });
					res.end();
					return;
				case "/redirect/malformed":
					req.socket.write("HTTP/1.1 302 Found\r\nlocation: /echo\r\ntransfer-encoding: chunked\r\n\r\nZ\r\n");
					return;
				case "/205-malformed":
					req.socket.write("HTTP/1.1 205 Reset Content\r\ntransfer-encoding: chunked\r\n\r\nZ\r\n");
					return;
				case "/redirect/unfinished":
					res.writeHead(302, { location: "/echo" });
					res.write("a body that never ends");
					return;
				case "/redirect/loop":
					res.writeHead(302, { location: "/redirect/loop" });
					res.end();
					return;
				default:
					res.writeHead(404);
					res.end();
			}
		});
	};
}

interface TestServer {
	readonly url: string;
	readonly server: http.Server;
	/** Sockets opened and closed on the server side; with keep-alive off, a gap between them is a client holding one. */
	readonly openedSockets: number;
	readonly closedSockets: number;
}

function startServer(handler: http.RequestListener): Promise<TestServer> {
	return new Promise((resolve) => {
		const state = { opened: 0, closed: 0 };
		const server = http.createServer(handler);
		server.on("connection", (socket) => {
			state.opened++;
			socket.on("close", () => state.closed++);
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				server,
				get openedSockets() {
					return state.opened;
				},
				get closedSockets() {
					return state.closed;
				},
			});
		});
	});
}

/** Every socket the server ever saw is closed again: the client is holding nothing. */
function allSocketsReleased(server: TestServer): Promise<void> {
	return until(() => server.closedSockets === server.openedSockets, "every socket to be released");
}

async function until(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return chunks;
		}
		chunks.push(decoder.decode(value));
	}
}

function closedPort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = http.createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

suite("provider/transport/nodeHttpFetch", () => {
	let main: TestServer;
	let peer: TestServer;

	suiteSetup(async () => {
		peer = await startServer(routes(() => main.url));
		main = await startServer(routes(() => peer.url));
	});

	suiteTeardown(async () => {
		for (const s of [main, peer]) {
			s.server.closeAllConnections();
			await new Promise((r) => s.server.close(r));
		}
	});

	test("a POST body, its headers, and the response status, headers, and body all cross the wire", async () => {
		const response = await nodeHttpFetch(`${main.url}/echo`, {
			method: "POST",
			headers: new Headers({ Authorization: "Bearer k", "X-API-Key": "k" }),
			body: "payload",
		});
		assert.strictEqual(response.status, 200);
		assert.strictEqual(response.statusText, "OK");
		assert.strictEqual(response.headers.get("x-echo"), "yes");
		assert.ok(response.body instanceof ReadableStream, "the body is a web stream the SSE reader can lock");
		assert.deepStrictEqual((await response.json()) as Echo, {
			method: "POST",
			body: "payload",
			headers: {
				authorization: "Bearer k",
				"x-api-key": "k",
				"content-type": "text/plain;charset=UTF-8",
				"content-length": "7",
			},
		});
	});

	test("chunks stream in order across an idle gap and the stream closes at end", async function () {
		this.timeout(5000);
		const response = await nodeHttpFetch(`${main.url}/stream`);
		assert.deepStrictEqual(await readAll(response.body as ReadableStream<Uint8Array>), ["one", "two"]);
	});

	test("a 204 carries a null body and its headers", async () => {
		const response = await nodeHttpFetch(`${main.url}/204`);
		assert.strictEqual(response.status, 204);
		assert.strictEqual(response.body, null);
		assert.strictEqual(response.headers.get("x-empty"), "yes");
	});

	const redirects: { name: string; path: string; method: string; expect: Partial<Echo> }[] = [
		{
			name: "307 keeps the method and body",
			path: "/redirect/307",
			method: "POST",
			expect: { method: "POST", body: "payload" },
		},
		{
			name: "302 turns a POST into a bodiless GET",
			path: "/redirect/302",
			method: "POST",
			expect: { method: "GET", body: "" },
		},
	];
	for (const { name, path, method, expect } of redirects) {
		test(`redirects: ${name}`, async () => {
			const response = await nodeHttpFetch(`${main.url}${path}`, {
				method,
				headers: { Authorization: "Bearer k" },
				body: "payload",
			});
			const echo = (await response.json()) as Echo;
			assert.strictEqual(echo.method, expect.method);
			assert.strictEqual(echo.body, expect.body);
			assert.strictEqual(echo.headers.authorization, "Bearer k", "same-origin hops keep credentials");
			if (expect.method === "GET") {
				assert.strictEqual(echo.headers["content-type"], undefined, "the body headers go with the body");
			}
		});
	}

	test("redirects: a cross-origin hop drops the credential headers and keeps the rest", async () => {
		const response = await nodeHttpFetch(`${main.url}/redirect/cross`, {
			headers: {
				Authorization: "Bearer k",
				"X-API-Key": "k",
				Cookie: "session=1",
				"Proxy-Authorization": "Basic cHJveHk=",
				"X-Custom": "kept",
			},
		});
		const echo = (await response.json()) as Echo;
		// JSON drops the undefined entries, so the echo carries exactly the headers that crossed.
		assert.deepStrictEqual(echo.headers, { "x-custom": "kept" });
	});

	// Discarding a body that already errored: cancel() rejects with the stored error, which must not surface as an
	// unhandled rejection.
	const discardedErrored: { name: string; path: string; expect: (response: Response) => Promise<void> }[] = [
		{
			name: "a 302 whose body breaks alongside its headers still redirects",
			path: "/redirect/malformed",
			expect: async (response) => assert.strictEqual(((await response.json()) as Echo).method, "GET"),
		},
		{
			name: "a 205 whose body breaks alongside its headers still answers with a null body",
			path: "/205-malformed",
			expect: async (response) => {
				assert.strictEqual(response.status, 205);
				assert.strictEqual(response.body, null);
			},
		},
	];
	for (const { name, path, expect } of discardedErrored) {
		test(`discarding an errored body: ${name}, without an unhandled rejection`, async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => {
				unhandled.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				await expect(await nodeHttpFetch(`${main.url}${path}`));
				await new Promise((r) => setTimeout(r, 50));
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
			assert.deepStrictEqual(unhandled, []);
		});
	}

	test("redirects: a discarded 3xx whose body never ends is cancelled, not drained", async () => {
		const response = await nodeHttpFetch(`${main.url}/redirect/unfinished`);
		assert.strictEqual(((await response.json()) as Echo).method, "GET");
		await allSocketsReleased(main);
	});

	test("redirects: redirect: manual returns the 3xx itself", async () => {
		const response = await nodeHttpFetch(`${main.url}/redirect/307`, { redirect: "manual" });
		assert.strictEqual(response.status, 307);
		assert.strictEqual(response.headers.get("location"), "/echo");
	});

	test("failures before headers reject like fetch: TypeError('fetch failed') with the cause attached", async () => {
		const port = await closedPort();
		const cases: { name: string; run: () => Promise<Response>; cause: RegExp }[] = [
			{
				name: "ECONNREFUSED",
				run: () => nodeHttpFetch(`http://127.0.0.1:${port}/echo`),
				cause: /ECONNREFUSED/,
			},
			{
				name: "unsupported protocol",
				run: () => nodeHttpFetch("ftp://example.invalid/x"),
				cause: /unsupported protocol/,
			},
			{ name: "unparseable URL", run: () => nodeHttpFetch("not a url"), cause: /Invalid URL/ },
			{
				name: "unsupported body type",
				run: () => nodeHttpFetch(`${main.url}/echo`, { method: "POST", body: {} as unknown as string }),
				cause: /unsupported request body type/,
			},
			{
				name: "redirect loop past 20 hops",
				run: () => nodeHttpFetch(`${main.url}/redirect/loop`),
				cause: /redirect count exceeded/,
			},
			{
				name: "redirect: error",
				run: () => nodeHttpFetch(`${main.url}/redirect/307`, { redirect: "error" }),
				cause: /unexpected redirect/,
			},
		];
		for (const { name, run, cause } of cases) {
			await assert.rejects(run(), (err: unknown) => {
				assert.ok(err instanceof TypeError && err.message === "fetch failed", `${name}: ${String(err)}`);
				const inner = err.cause;
				assert.ok(inner instanceof Error, `${name}: the Node error rides as the cause`);
				assert.match(`${inner.message} ${(inner as { code?: string }).code ?? ""}`, cause, name);
				return true;
			});
		}
	});

	test("a failure before headers releases the signal's abort listener", async () => {
		const port = await closedPort();
		const controller = new AbortController();
		await assert.rejects(nodeHttpFetch(`http://127.0.0.1:${port}/echo`, { signal: controller.signal }));
		assert.strictEqual(getEventListeners(controller.signal, "abort").length, 0);
	});

	test("a body that goes bad before the first read still errors the stream instead of hanging it", async () => {
		const response = await nodeHttpFetch(`${main.url}/malformed-chunk`);
		// Let the parser failure land before anything reads, the window the old handoff left unowned.
		await new Promise((r) => setTimeout(r, 50));
		await assert.rejects(response.text(), (err: unknown) => {
			assert.ok(err instanceof TypeError && err.message === "terminated", String(err));
			assert.ok(err.cause instanceof Error, "the parser error rides as the cause");
			return true;
		});
	});

	test("the server dying mid-body errors the stream with TypeError('terminated') and an ECONNRESET cause", async () => {
		const response = await nodeHttpFetch(`${main.url}/kill`);
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		assert.strictEqual(new TextDecoder().decode((await reader.read()).value), "one");
		await assert.rejects(reader.read(), (err: unknown) => {
			assert.ok(err instanceof TypeError && err.message === "terminated", String(err));
			assert.strictEqual((err.cause as { code?: string }).code, "ECONNRESET");
			return true;
		});
	});

	test("an abort mid-body errors the stream with the signal's reason and releases the socket", async () => {
		const controller = new AbortController();
		const response = await nodeHttpFetch(`${main.url}/stream-hang`, { signal: controller.signal });
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		assert.strictEqual(new TextDecoder().decode((await reader.read()).value), "one");
		const reason = new DOMException("stop", "AbortError");
		controller.abort(reason);
		await assert.rejects(reader.read(), (err: unknown) => err === reason);
		await allSocketsReleased(main);
		assert.strictEqual(getEventListeners(controller.signal, "abort").length, 0);
	});

	// The SDK cancels a failed response's body before retrying. Node keeps flushing what the socket already
	// buffered after res.destroy(), so a data handler that still enqueues would throw on a closed controller.
	const cancels: { name: string; cancel: (body: ReadableStream<Uint8Array>) => Promise<void> }[] = [
		{
			name: "before the first read, while the listener's own resume is still pending",
			cancel: (body) => body.cancel(),
		},
		{
			name: "with a pull pending after a read",
			cancel: async (body) => {
				const reader = body.getReader();
				await reader.read();
				const pending = reader.read();
				await reader.cancel();
				assert.deepStrictEqual(await pending, { done: true, value: undefined });
			},
		},
	];
	for (const { name, cancel } of cancels) {
		test(`cancelling the body ${name} discards what the socket still delivers, without an uncaught error`, async () => {
			const uncaught: unknown[] = [];
			const onUncaught = (err: unknown): void => {
				uncaught.push(err);
			};
			process.on("uncaughtException", onUncaught);
			try {
				const response = await nodeHttpFetch(`${main.url}/firehose`);
				await cancel(response.body as ReadableStream<Uint8Array>);
				await allSocketsReleased(main);
				await new Promise((r) => setTimeout(r, 50));
			} finally {
				process.off("uncaughtException", onUncaught);
			}
			assert.deepStrictEqual(uncaught, []);
		});
	}

	test("an abort before headers rejects with the signal's reason, including AbortSignal.timeout", async () => {
		const controller = new AbortController();
		const pending = nodeHttpFetch(`${main.url}/hang`, { signal: controller.signal });
		const reason = new Error("cancelled");
		setTimeout(() => controller.abort(reason), 20);
		await assert.rejects(pending, (err: unknown) => err === reason);
		await allSocketsReleased(main);

		await assert.rejects(nodeHttpFetch(`${main.url}/hang`, { signal: AbortSignal.timeout(30) }), (err: unknown) => {
			assert.ok(err instanceof DOMException && err.name === "TimeoutError", String(err));
			return true;
		});
	});

	test("a signal already aborted rejects without opening a connection", async () => {
		const before = main.openedSockets;
		const reason = new Error("never started");
		await assert.rejects(
			nodeHttpFetch(`${main.url}/echo`, { signal: AbortSignal.abort(reason) }),
			(err: unknown) => err === reason
		);
		await new Promise((r) => setTimeout(r, 30));
		assert.strictEqual(main.openedSockets, before, "no socket was opened");
	});
});
