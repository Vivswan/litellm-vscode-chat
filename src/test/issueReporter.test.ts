import * as assert from "assert";
import * as vscode from "vscode";
import { IssueReporter, redactSecrets } from "../issueReporter";
import type { DiagnosticsSnapshot } from "../issueReporter";

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

	test("buildIssueUrl produces valid GitHub URL with query params", () => {
		const reporter = new IssueReporter();
		const url = reporter.buildIssueUrl(makeSnapshot());
		assert.ok(url.startsWith("https://github.com/Vivswan/litellm-vscode-chat/issues/new?"));
		assert.ok(url.includes("labels=bug"));
		assert.ok(url.includes("title="));
		assert.ok(url.includes("body="));
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
		assert.ok(!title.includes("internal.corp.com"), "Should not leak hostname");
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
		assert.ok(!body.includes(logs[0]));
		assert.ok(body.includes(logs[49]));
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
			openExternal: async (uri) => {
				openedUri = uri.toString(true);
				return true;
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
		assert.ok(clipboardText?.includes(logs[0]));
		assert.ok(clipboardText?.includes(logs[49]));
		assert.equal(savedText, clipboardText);
		assert.equal(notifiedFile?.toString(), diagnosticsFile.toString());
		assert.ok(getIssueBody(openedUri).includes("saved to a diagnostics file"));
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
		assert.ok(logs[0].includes("line 10"));
		assert.ok(logs[49].includes("line 59"));
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
		assert.ok(!result.includes("my-litellm.internal.corp.com"), "Should not leak hostname");
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

	test("redactSecrets removes the default OAuth virtual-key header value", () => {
		assert.equal(redactSecrets("X-LLM-API-CLIENT-ID: vk-secret123"), "X-LLM-API-CLIENT-ID: [REDACTED]");
	});

	test("redactSecrets removes custom virtual-key header values", () => {
		const result = redactSecrets("X-Custom-Virtual-Key: abc999");
		assert.ok(!result.includes("abc999"), "Should not leak the virtual key");
		assert.ok(result.includes("[REDACTED]"));
	});

	test("redactSecrets handles JSON-encoded virtual-key headers", () => {
		const json = '{"X-LLM-API-CLIENT-ID": "vk-secret123"}';
		const result = redactSecrets(json);
		assert.ok(!result.includes("vk-secret123"), "Should not leak the virtual key");
		assert.ok(result.includes("[REDACTED]"));
	});
});
