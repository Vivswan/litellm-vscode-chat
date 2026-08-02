import * as assert from "node:assert";
import { APIError } from "openai";
import * as vscode from "vscode";
import type { DiagnosticsSnapshot } from "../../../extension/ui/issueReporter";
import { IssueReporter, redactSecrets } from "../../../extension/ui/issueReporter";
import { mapSdkError, RequestError } from "../../../provider/transport/errorMapping";
import { expectDefined } from "../../testUtils";

suite("IssueReporter", () => {
	const MAX_SAFE_URL_LENGTH = 8000;

	function makeSnapshot(overrides?: Partial<DiagnosticsSnapshot>): DiagnosticsSnapshot {
		return {
			extensionVersion: "0.2.3",
			vscodeVersion: "1.118.0",
			platform: "darwin arm64",
			connectionState: "connected",
			modelCount: 5,
			apiKeyConfigured: true,
			baseUrlConfigured: true,
			recentLogs: [],
			...overrides,
		};
	}

	function getIssueBody(url: string): string {
		return new URL(url).searchParams.get("body") ?? "";
	}

	/**
	 * Redaction assert: the host rides a parameter so a hostname literal never
	 * sits at an includes() call, the shape CodeQL reads as
	 * URL-sanitization-by-substring (js/incomplete-url-substring-sanitization).
	 */
	function assertHostRedacted(text: string, host: string): void {
		assert.ok(!text.includes(host), "Should not leak hostname");
	}

	test("buildIssueUrl produces valid GitHub URL with query params", () => {
		const reporter = new IssueReporter();
		const url = reporter.buildIssueUrl(makeSnapshot());
		assert.ok(url.startsWith("https://github.com/Vivswan/litellm-vscode-chat/issues/new?"));
		assert.ok(url.includes("labels=bug"));
		assert.ok(url.includes("title="));
		assert.ok(url.includes("body="));
	});

	test("an unknown key state renders as VS Code-managed instead of a false no", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(makeSnapshot({ apiKeyConfigured: "unknown" }));
		assert.ok(body.includes("API key configured: Unknown (managed by VS Code)"), body);
	});

	test("buildTitle sanitizes error message secrets", () => {
		const reporter = new IssueReporter();
		const snapshot = makeSnapshot({
			latestError: {
				source: "fetchModels",
				message: "Failed to connect to https://internal.corp.com:4000/v1/models",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
		});
		const title = reporter.buildTitle(snapshot);
		assert.ok(title.includes("[Bug]"));
		assert.ok(title.includes("fetchModels"));
		assertHostRedacted(title, "internal.corp.com");
		assert.ok(title.includes("[REDACTED_HOST]"));
	});

	test("buildTitle includes error source and message when error exists", () => {
		const reporter = new IssueReporter();
		const snapshot = makeSnapshot({
			latestError: {
				source: "fetchModels",
				message: "Connection refused\nsome detail",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
		});
		const title = reporter.buildTitle(snapshot);
		assert.ok(title.includes("[Bug]"));
		assert.ok(title.includes("fetchModels"));
		assert.ok(title.includes("Connection refused"));
		assert.ok(!title.includes("some detail"));
	});

	test("buildTitle returns generic title when no error", () => {
		const reporter = new IssueReporter();
		const title = reporter.buildTitle(makeSnapshot());
		assert.ok(title.includes("[Bug]"));
		assert.ok(title.includes("diagnostics"));
	});

	test("buildBody includes environment and diagnostics sections", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(makeSnapshot());
		assert.ok(body.includes("## Environment"));
		assert.ok(body.includes("0.2.3"));
		assert.ok(body.includes("## Diagnostics"));
		assert.ok(body.includes("API key configured: yes"));
		assert.ok(body.includes("Model count: 5"));
	});

	test("buildBody includes error details and stack trace", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(
			makeSnapshot({
				latestError: {
					source: "chat",
					message: "timeout",
					stack: "Error: timeout\n    at foo.ts:1",
					timestamp: "2026-01-01T00:00:00.000Z",
				},
			})
		);
		assert.ok(body.includes("### Latest error"));
		assert.ok(body.includes("timeout"));
		assert.ok(body.includes("Stack trace"));
	});

	test("an http RequestError's response body never reaches the issue prefill", () => {
		const reporter = new IssueReporter();
		// Through the real mapping: a non-JSON body whose text contains both a
		// marker and a line SHAPED like a stack frame (the reviewer-reproduced
		// case: prefix-stripping by length must remove it; a frame-shape filter
		// alone would keep it).
		const sdkError = new APIError(
			422,
			undefined,
			"422 BODY-MARKER-422\n\tat com.example.Foo.bar(Foo.java:1)",
			new Headers()
		);
		const mapped = mapSdkError(sdkError, { surface: "chat", baseUrl: "http://litellm.test", timeoutMs: 5000 });
		reporter.recordError("Chat request failed", mapped);
		const snapshot = makeSnapshot({ latestError: reporter.getLatestError() });

		const body = reporter.buildBody(snapshot);
		assert.ok(!body.includes("BODY-MARKER-422"), "the response body leaked into the issue prefill");
		assert.ok(!body.includes("com.example.Foo.bar"), "the body's frame-shaped line leaked into the issue prefill");
		assert.ok(body.includes("RequestError(http, status 422)"), "the classification replaces the message");
		assert.ok(!reporter.buildTitle(snapshot).includes("BODY-MARKER-422"), "the title must not leak the body either");

		// The stack section keeps its call frames but nothing message-derived.
		const stack = expectDefined(expectDefined(reporter.getLatestError()).stack);
		assert.ok(!stack.includes("BODY-MARKER-422"), "the stack's message line leaked the body");
		assert.ok(!stack.includes("com.example.Foo.bar"), "the stack kept the body's frame-shaped line");
		assert.match(stack, /^RequestError\(http, status 422\)\n\s+at /);
	});

	test("non-http RequestErrors keep their template message in the prefill", () => {
		const reporter = new IssueReporter();
		reporter.recordError("Chat request failed", new RequestError("LiteLLM request timed out after 3000ms.", "timeout"));
		const body = reporter.buildBody(makeSnapshot({ latestError: reporter.getLatestError() }));
		assert.ok(body.includes("LiteLLM request timed out after 3000ms."), "template text stays useful in the issue");
	});

	test("recordError captures the transport classification, and only for transport errors", () => {
		const reporter = new IssueReporter();
		const mapped = mapSdkError(new APIError(404, { error: { message: "no such route" } }, undefined, new Headers()), {
			surface: "discovery",
			baseUrl: "http://litellm.test",
			timeoutMs: 5000,
		});
		reporter.recordError("discovery", mapped);
		assert.deepStrictEqual(expectDefined(reporter.getLatestError()).classification, {
			kind: "http",
			status: 404,
			setupHint: "check-base-url",
		});

		reporter.recordError("discovery", new Error("plain failure"));
		assert.strictEqual(
			expectDefined(reporter.getLatestError()).classification,
			undefined,
			"a plain Error carries no classification"
		);
	});

	test("a classified latest error renders one Classification line in the body", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(
			makeSnapshot({
				latestError: {
					source: "discovery",
					message: "answered 404",
					timestamp: "2026-01-01T00:00:00.000Z",
					classification: { kind: "http", status: 404, setupHint: "check-base-url" },
				},
			})
		);
		assert.ok(body.includes("- Classification: http 404 (check-base-url)"), body);
	});

	test("a status-less, hint-less classification renders just the kind", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(
			makeSnapshot({
				latestError: {
					source: "chat",
					message: "timed out",
					timestamp: "2026-01-01T00:00:00.000Z",
					classification: { kind: "timeout" },
				},
			})
		);
		assert.ok(body.includes("- Classification: timeout\n"), body);
	});

	test("an unclassified latest error renders no Classification line", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(
			makeSnapshot({
				latestError: { source: "chat", message: "boom", timestamp: "2026-01-01T00:00:00.000Z" },
			})
		);
		assert.ok(!body.includes("- Classification:"), body);
	});

	test("the Classification line survives into the clipboard fallback body", () => {
		const reporter = new IssueReporter();
		const url = reporter.buildIssueUrl(
			makeSnapshot({
				latestError: {
					source: "fetchModels",
					message: `network failure ${"x".repeat(30000)}`,
					timestamp: "2026-01-01T00:00:00.000Z",
					classification: { kind: "http", status: 404, setupHint: "check-base-url" },
				},
				recentLogs: [],
			})
		);
		const body = getIssueBody(url);

		assert.ok(url.length <= MAX_SAFE_URL_LENGTH);
		assert.ok(body.includes("Full redacted diagnostics were too large to prefill in GitHub"), body);
		assert.ok(body.includes("- Classification: http 404 (check-base-url)"), body);
	});

	test("a classified error's redaction stays exactly as before", () => {
		// The Classification line is enum ids plus an integer; the message and
		// title redaction pipeline must behave as if the field were not there.
		const reporter = new IssueReporter();
		const snapshot = makeSnapshot({
			latestError: {
				source: "discovery",
				message: "Failed to connect to https://internal.corp.com:4000/v1/models",
				timestamp: "2026-01-01T00:00:00.000Z",
				classification: { kind: "connection", setupHint: "proxy-not-running" },
			},
		});
		const body = reporter.buildBody(snapshot);
		assertHostRedacted(body, "internal.corp.com");
		assert.ok(body.includes("[REDACTED_HOST]"), body);
		assert.ok(body.includes("- Classification: connection (proxy-not-running)"), body);
		assertHostRedacted(reporter.buildTitle(snapshot), "internal.corp.com");
	});

	test("buildBody includes recent logs", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(
			makeSnapshot({ recentLogs: ["[2026-01-01] Fetching models", "[2026-01-01] Got 5 models"] })
		);
		assert.ok(body.includes("## Recent logs"));
		assert.ok(body.includes("Fetching models"));
	});

	test("buildBody keeps recent logs before stack trace", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(
			makeSnapshot({
				latestError: {
					source: "fetchModels",
					message: "network failure",
					stack: "Error: network failure\n    at fetchModels.ts:1",
					timestamp: "2026-01-01T00:00:00.000Z",
				},
				recentLogs: ["[2026-01-01] ERROR: Failed to fetch models from server Default"],
			})
		);

		assert.ok(body.indexOf("## Recent logs") < body.indexOf("Stack trace"));
		assert.ok(body.includes("[2026-01-01] ERROR: Failed to fetch models from server Default"));
	});

	test("buildBody includes all buffered recent logs", () => {
		const reporter = new IssueReporter();
		const recentLogs = Array.from({ length: 25 }, (_, i) => `line ${i}`);
		const body = reporter.buildBody(makeSnapshot({ recentLogs }));

		assert.ok(body.includes("line 0"));
		assert.ok(body.includes("line 24"));
	});

	test("buildIssueUrl does not truncate realistic diagnostics", () => {
		const reporter = new IssueReporter();
		const finalLog = '[2026-06-05T01:22:21.281Z] ERROR: Failed to fetch models from server "Default": fetch failed';
		const url = reporter.buildIssueUrl(
			makeSnapshot({
				connectionState: "error",
				modelCount: 0,
				latestError: {
					source: 'Failed to fetch models from server "Default"',
					message: "Network Error: Failed to fetch models from https://internal.example.com/v1/models fetch failed",
					stack: [
						"Error: Network Error: Failed to fetch models from https://internal.example.com/v1/models fetch failed",
						"    at fetchModels (c:\\Users\\user\\.vscode\\extensions\\vivswan.litellm-vscode-chat-0.2.6\\out\\provider\\discovery.js:166:25)",
						"    at processTicksAndRejections (node:internal/process/task_queues:104:5)",
						"    at LiteLLMChatModelProvider.prepareLanguageModelChatInformation (c:\\Users\\user\\.vscode\\extensions\\vivswan.litellm-vscode-chat-0.2.6\\out\\provider.js:119:25)",
					].join("\n"),
					timestamp: "2026-06-05T01:22:23.326Z",
				},
				recentLogs: [
					"[2026-06-05T01:22:20.000Z] prepareLanguageModelChatInformation called",
					"[2026-06-05T01:22:20.500Z] Fetching models from servers",
					finalLog,
				],
			})
		);
		const body = getIssueBody(url);

		assert.ok(url.length <= MAX_SAFE_URL_LENGTH);
		assert.ok(body.includes(finalLog));
		assert.ok(!body.includes("...(truncated)"));
		assert.ok(!body.includes("full diagnostics copied to clipboard"));
	});

	test("buildIssueUrl drops oldest logs as whole lines when the report is too large", () => {
		const reporter = new IssueReporter();
		const logs = Array.from({ length: 50 }, (_, i) => `log ${i.toString().padStart(2, "0")} ${"x".repeat(140)}`);
		const url = reporter.buildIssueUrl(
			makeSnapshot({
				latestError: {
					source: "fetchModels",
					message: "network failure",
					stack: Array.from({ length: 40 }, (_, i) => `    at frame${i} (file${i}.ts:1:1)`).join("\n"),
					timestamp: "2026-01-01T00:00:00.000Z",
				},
				recentLogs: logs,
			})
		);
		const body = getIssueBody(url);

		assert.ok(url.length <= MAX_SAFE_URL_LENGTH);
		assert.ok(body.includes("older log lines omitted"));
		assert.ok(!body.includes(expectDefined(logs[0])));
		assert.ok(body.includes(expectDefined(logs[49])));
		assert.ok(!body.includes("...(truncated)"));
	});

	test("openIssue copies full diagnostics when the URL body is compacted", async () => {
		let clipboardText: string | undefined;
		let savedText: string | undefined;
		let notifiedFile: vscode.Uri | undefined;
		let openedUri: string | undefined;
		const diagnosticsFile = vscode.Uri.file("/tmp/litellm-diagnostics.md");
		const reporter = new IssueReporter({
			writeClipboard: async (text) => {
				clipboardText = text;
			},
			saveDiagnosticsFile: async (text) => {
				savedText = text;
				return diagnosticsFile;
			},
			openExternal: async (url) => {
				openedUri = url;
			},
			showCompactedDiagnosticsMessage: async (file) => {
				notifiedFile = file;
			},
		});
		const logs = Array.from({ length: 50 }, (_, i) => `log ${i.toString().padStart(2, "0")} ${"x".repeat(140)}`);

		await reporter.openIssue(
			makeSnapshot({
				latestError: {
					source: "fetchModels",
					message: "network failure",
					stack: Array.from({ length: 40 }, (_, i) => `    at frame${i} (file${i}.ts:1:1)`).join("\n"),
					timestamp: "2026-01-01T00:00:00.000Z",
				},
				recentLogs: logs,
			})
		);

		assert.ok(openedUri);
		assert.ok(openedUri.length <= MAX_SAFE_URL_LENGTH);
		assert.ok(openedUri.includes("%23"), openedUri);
		assert.ok(!openedUri.includes("%2523"), openedUri);
		assert.ok(clipboardText?.includes(expectDefined(logs[0])));
		assert.ok(clipboardText?.includes(expectDefined(logs[49])));
		assert.equal(savedText, clipboardText);
		assert.equal(notifiedFile?.toString(), diagnosticsFile.toString());
		assert.ok(getIssueBody(openedUri).includes("saved to a diagnostics file"));
	});

	test("openIssue hands the opener the exact URL string it built", async () => {
		let openedUrl: string | undefined;
		const reporter = new IssueReporter({
			writeClipboard: async () => {},
			openExternal: async (url) => {
				openedUrl = url;
			},
		});
		const snapshot = makeSnapshot({
			latestError: {
				source: "chat",
				message: "50% of #anchors dropped: café 中文",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
		});

		await reporter.openIssue(snapshot);

		assert.equal(openedUrl, reporter.buildIssueUrl(snapshot));
	});

	test("issue URLs decode exactly once back to the original title and body", () => {
		const reporter = new IssueReporter();
		const snapshot = makeSnapshot({
			latestError: {
				source: "chat",
				message: "50% of #anchors dropped: café 中文",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
			recentLogs: ["first line\nsecond line"],
		});
		const url = reporter.buildIssueUrl(snapshot);
		const params = new URL(url).searchParams;

		assert.ok(url.includes("%23"), url);
		assert.ok(!url.includes("%2523"), url);
		assert.equal(params.get("title"), reporter.buildTitle(snapshot));
		assert.equal(params.get("body"), reporter.buildBody(snapshot));
	});

	test("vscode.Uri cannot carry the URL: parse/toString round-trips corrupt the encoded query", () => {
		const url = new IssueReporter().buildIssueUrl(makeSnapshot());
		assert.ok(url.includes("%23"), url);

		const uri = vscode.Uri.parse(url);
		assert.notEqual(
			uri.toString(),
			url,
			"VS Code's Uri now round-trips the URL losslessly; re-evaluate whether the vscode.open string form is still needed"
		);
		// encodeURI(uri.toString(true)) is the browser href VS Code derives from a Uri passed to env.openExternal.
		assert.ok(
			encodeURI(uri.toString(true)).includes("%2523"),
			"VS Code's Uri no longer corrupts encoded queries; re-evaluate whether the vscode.open string form is still needed"
		);
	});

	test("buildIssueUrl final fallback stays short for huge messages", () => {
		const reporter = new IssueReporter();
		const url = reporter.buildIssueUrl(
			makeSnapshot({
				latestError: {
					source: "fetchModels",
					message: `network failure ${"x".repeat(30000)}`,
					timestamp: "2026-01-01T00:00:00.000Z",
				},
				recentLogs: [],
			})
		);
		const body = getIssueBody(url);

		assert.ok(url.length <= MAX_SAFE_URL_LENGTH);
		assert.ok(body.includes("Full redacted diagnostics were too large to prefill in GitHub"));
		assert.ok(body.includes("Please add the full diagnostics separately"));
		assert.ok(!body.includes("x".repeat(1000)));
	});

	test("appendLog maintains rolling buffer", () => {
		const reporter = new IssueReporter();
		for (let i = 0; i < 60; i++) {
			reporter.appendLog(`line ${i}`);
		}
		const logs = reporter.getRecentLogs();
		assert.equal(logs.length, 50);
		assert.ok(expectDefined(logs[0]).includes("line 10"));
		assert.ok(expectDefined(logs[49]).includes("line 59"));
	});

	test("recordError captures message and stack", () => {
		const reporter = new IssueReporter();
		const err = new Error("test failure");
		reporter.recordError("testSource", err);
		const latest = reporter.getLatestError();
		assert.ok(latest);
		assert.equal(latest.source, "testSource");
		assert.equal(latest.message, "test failure");
		assert.ok(latest.stack?.includes("test failure"));
		assert.ok(latest.timestamp);
	});

	test("recordError handles string errors", () => {
		const reporter = new IssueReporter();
		reporter.recordError("src", "plain string error");
		const latest = reporter.getLatestError();
		assert.ok(latest);
		assert.equal(latest.message, "plain string error");
		assert.equal(latest.stack, undefined);
	});

	test("redactSecrets removes Bearer tokens", () => {
		assert.equal(redactSecrets("Bearer sk-abc123xyz"), "Bearer [REDACTED]");
	});

	test("redactSecrets removes X-API-Key values", () => {
		assert.equal(redactSecrets("X-API-Key: my-secret-key"), "X-API-Key: [REDACTED]");
	});

	test("redactSecrets removes sk- prefixed keys", () => {
		const result = redactSecrets("key is sk-abcd1234567890");
		assert.ok(result.includes("sk-abcd[REDACTED]"));
		assert.ok(!result.includes("1234567890"));
	});

	test("redactSecrets removes credentials from URLs", () => {
		const result = redactSecrets("https://user:pass@example.com/api");
		assert.ok(!result.includes("pass"));
	});

	test("redactSecrets preserves non-secret text", () => {
		assert.equal(redactSecrets("Connection refused to localhost:4000"), "Connection refused to localhost:4000");
	});

	test("redactSecrets redacts full non-localhost URLs", () => {
		const result = redactSecrets("Fetching from: https://my-litellm.internal.corp.com:4000/v1/models");
		assertHostRedacted(result, "my-litellm.internal.corp.com");
		assert.ok(result.includes("[REDACTED_HOST]"));
		assert.ok(result.includes("/v1/models"), "Should preserve path");
	});

	test("redactSecrets preserves localhost URLs", () => {
		const result = redactSecrets("Fetching from: http://localhost:4000/v1/models");
		assert.ok(result.includes("http://localhost:4000/v1/models"));
	});

	test("redactSecrets handles JSON-encoded auth headers", () => {
		const json = '{"Authorization": "Bearer sk-abc123", "X-API-Key": "secret-key-value"}';
		const result = redactSecrets(json);
		assert.ok(!result.includes("sk-abc123"), "Should not leak Bearer token");
		assert.ok(!result.includes("secret-key-value"), "Should not leak API key");
		assert.ok(result.includes("[REDACTED]"));
	});

	test("redactSecrets removes OAuth client secrets and access tokens", () => {
		const bare = redactSecrets("token exchange failed: client_secret=oauth-secret-value access_token: tok-value");
		assert.ok(!bare.includes("oauth-secret-value"), "Should not leak the client secret");
		assert.ok(!bare.includes("tok-value"), "Should not leak the access token");
		assert.ok(bare.includes("client_secret=[REDACTED]"));
		assert.ok(bare.includes("access_token: [REDACTED]"));
	});

	test("redactSecrets handles JSON-encoded OAuth material", () => {
		const json = '{"client_secret": "oauth-secret-value", "access_token": "tok-value", "expires_in": 3600}';
		const result = redactSecrets(json);
		assert.ok(!result.includes("oauth-secret-value"), "Should not leak the client secret");
		assert.ok(!result.includes("tok-value"), "Should not leak the access token");
		assert.ok(result.includes('"expires_in": 3600'), "Non-secret fields survive");
	});

	test("redactSecrets consumes escaped quotes inside JSON-encoded secrets", () => {
		const json =
			'{"Authorization": "Bearer to\\"ken-TAIL", "client_secret": "ab\\"cd-TAIL-\\\\ef", "access_token": "to\\"k-TAIL", "expires_in": 3600}';
		const result = redactSecrets(json);
		assert.ok(!result.includes("TAIL"), `An escaped quote ended the match early and leaked the suffix: ${result}`);
		assert.ok(result.includes('"expires_in": 3600'), "Non-secret fields survive");
	});

	test("redactSecrets over-redacts bare token mentions, deliberately erring toward safety", () => {
		// "endpoint" here is prose, not a secret; the bare patterns cannot tell
		// and redact it anyway. That is the accepted trade-off: never weaken the
		// patterns to preserve prose.
		assert.equal(redactSecrets("access_token endpoint failed"), "access_token [REDACTED] failed");
	});
});
