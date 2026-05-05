import * as assert from "assert";
import { IssueReporter, redactSecrets } from "../issueReporter";
import type { DiagnosticsSnapshot } from "../issueReporter";

suite("IssueReporter", () => {
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
});
