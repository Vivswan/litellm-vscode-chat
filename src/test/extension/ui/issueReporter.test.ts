import * as assert from "node:assert";
import { APIError } from "openai";
import * as vscode from "vscode";
import type { DiagnosticsSnapshot } from "../../../extension/ui/issueReporter";
import {
	IssueReporter,
	readLastIssueReport,
	rememberIssueReport,
	reportFingerprint,
} from "../../../extension/ui/issueReporter";
import { mapSdkError } from "../../../provider/transport/errorMapping";
import { RequestError } from "../../../provider/transport/transportErrors";
import { Logger, recordedError } from "../../../shared/logger";
import { GITHUB_REPO_URL } from "../../../shared/util/links";
import { assertContains, assertOmits, assertStartsWith, expectDefined } from "../../pureHelpers";
import { makeExtensionStorage } from "../../testUtils";

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
			featureFlags: {
				inlineCompletions: { enabled: false, modelConfigured: false },
				commitGeneration: { enabled: false, modelConfigured: false },
				prGeneration: { enabled: false, modelConfigured: false },
				consultTool: { enabled: false, modelConfigured: false },
				quickFix: { enabled: false, modelConfigured: false },
				reviewComments: { enabled: false, modelConfigured: false },
				chatParticipant: { enabled: true },
				agentTools: { enabled: false },
			},
			mcpEntryCount: 0,
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
		assertStartsWith(url, `${GITHUB_REPO_URL}/issues/new?`);
		assert.ok(url.includes("labels=bug"));
		assert.ok(url.includes("title="));
		assert.ok(url.includes("body="));
	});

	test("an unknown key state renders as an open verdict instead of a false no", () => {
		const reporter = new IssueReporter();
		const body = reporter.buildBody(makeSnapshot({ apiKeyConfigured: "unknown" }));
		assert.ok(body.includes("API key configured: Unknown (key presence not yet determined)"), body);
	});

	test("buildTitle keeps the host: only credential values and URL userinfo are redacted anywhere", () => {
		const reporter = new IssueReporter();
		const snapshot = makeSnapshot({
			latestError: {
				source: "fetchModels",
				message: "Failed to connect to https://user:pass@internal.corp.com:4000/v1/models",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
		});
		assert.strictEqual(
			reporter.buildTitle(snapshot),
			"[Bug] fetchModels: Failed to connect to https://[redacted]@internal.corp.com:4000/v1/models"
		);
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

	test("the feature-flag loop reproduces the two shipped features' lines byte-for-byte", () => {
		// The loop replaced hand-written per-feature lines; these strings are the old renderer's exact output, so a
		// prose or casing drift in the loop's composition fails here instead of silently rewording public reports.
		const reporter = new IssueReporter();
		const body = reporter.buildBody(
			makeSnapshot({
				featureFlags: {
					inlineCompletions: { enabled: true, modelConfigured: false },
					commitGeneration: { enabled: false, modelConfigured: true },
					prGeneration: { enabled: false, modelConfigured: false },
					consultTool: { enabled: false, modelConfigured: false },
					quickFix: { enabled: false, modelConfigured: false },
					reviewComments: { enabled: false, modelConfigured: false },
					chatParticipant: { enabled: true },
					agentTools: { enabled: false },
				},
			})
		);
		for (const line of [
			"- Commit generation enabled: no",
			"- Commit generation model configured: yes",
			"- Inline completions enabled: yes",
			"- Inline completions model configured: no",
		]) {
			assert.ok(body.includes(`\n${line}\n`), `body must carry the exact line: ${line}`);
		}
		assert.ok(body.includes("\n- Chat participant enabled: yes\n"));
		assert.ok(!body.includes("Chat participant model configured"));
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

	test("buildBody keeps a multi-line error message inside its Message bullet", () => {
		// Chat-surface messages separate headline and detail with a blank line;
		// rendered raw, that blank line would end the markdown list.
		const reporter = new IssueReporter();
		const body = reporter.buildBody(
			makeSnapshot({
				latestError: {
					source: "chat",
					message: "Headline text.\n\nDetails: LiteLLM 500: boom",
					timestamp: "2026-01-01T00:00:00.000Z",
				},
			})
		);
		assert.ok(body.includes("- Message: Headline text.\n  Details: LiteLLM 500: boom"), body);
		assert.ok(!body.includes("Headline text.\n\n"), "a blank line would end the markdown list");
	});

	test("an http RequestError's response body never reaches the issue prefill", () => {
		const reporter = new IssueReporter();
		// Through the real mapping: a non-JSON body carrying both a marker and a line SHAPED like a stack frame -
		// prefix-stripping by length must remove it, where a frame-shape filter alone would keep it.
		const sdkError = new APIError(
			422,
			undefined,
			"422 BODY-MARKER-422\n\tat com.example.Foo.bar(Foo.java:1)",
			new Headers()
		);
		const mapped = mapSdkError(sdkError, { surface: "chat", baseUrl: "http://litellm.test", timeoutMs: 5000 });
		reporter.recordError("Chat request failed", recordedError(mapped));
		const snapshot = makeSnapshot({ latestError: reporter.getLatestError() });

		const body = reporter.buildBody(snapshot);
		assert.ok(!body.includes("BODY-MARKER-422"), "the response body leaked into the issue prefill");
		assertOmits(body, "com.example.Foo.bar", "the body's frame-shaped line leaked into the issue prefill");
		assert.ok(body.includes("RequestError(http, status 422)"), "the classification replaces the message");
		assert.ok(!reporter.buildTitle(snapshot).includes("BODY-MARKER-422"), "the title must not leak the body either");

		const stack = expectDefined(expectDefined(reporter.getLatestError()).stack);
		assert.ok(!stack.includes("BODY-MARKER-422"), "the stack's message line leaked the body");
		assertOmits(stack, "com.example.Foo.bar", "the stack kept the body's frame-shaped line");
		assert.match(stack, /^RequestError\(http, status 422\)\n\s+at /);
	});

	test("non-http RequestErrors keep their English mirror in the prefill", () => {
		const reporter = new IssueReporter();
		reporter.recordError(
			"Chat request failed",
			recordedError(
				new RequestError("LiteLLM request timed out after 3000ms.", "timeout", {
					englishMessage: "LiteLLM request timed out after 3000ms.",
				})
			)
		);
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
		reporter.recordError("discovery", recordedError(mapped));
		assert.deepStrictEqual(expectDefined(reporter.getLatestError()).classification, {
			kind: "http",
			status: 404,
			setupHint: "check-base-url",
		});

		reporter.recordError("discovery", recordedError(new Error("plain failure")));
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

	test("the latest error's source passes through the output door in the title and both bodies", () => {
		// The Logger names the failing server in the recorder's source ("Failed to fetch models for provider group at
		// <baseUrl>"), and the title, the Source line, and the clipboard fallback rendered it raw.
		const reporter = new IssueReporter();
		const latestError = {
			source: "Failed at http://user:pass@private.example:4000",
			message: "failed",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const shown = "Failed at http://[redacted]@private.example:4000";
		assert.strictEqual(reporter.buildTitle(makeSnapshot({ latestError })), `[Bug] ${shown}: failed`);
		assertContains(reporter.buildBody(makeSnapshot({ latestError })), `- Source: ${shown}\n`);
		const fallback = getIssueBody(
			reporter.buildIssueUrl(makeSnapshot({ latestError: { ...latestError, message: `failed ${"x".repeat(30000)}` } }))
		);
		assertContains(fallback, "Full redacted diagnostics were too large to prefill in GitHub");
		assertContains(fallback, `- Source: ${shown}\n`);
	});

	test("the registered values and URL userinfo are masked in the title, the error, the logs, and the stack", () => {
		// The buffer and the recorder hold every line raw (the Logger masks the channel by its setting), so the report
		// is where the registered values go, once over the whole snapshot before the title's first-line cut (a value
		// may span lines). Hosts and paths stay; a value that is also a word blanks that word.
		Logger.registerSecrets(["sk-live-Q7", "zq7w", "two\nlines"]);
		const reporter = new IssueReporter();
		const latestError = {
			source: "Failed at http://user:pass@localhost:4000 for sk-live-Q7",
			message: "connect ECONNREFUSED http://user:pass@localhost:4000 for key sk-live-Q7 two\nlines",
			stack: "Error: for key sk-live-Q7\n    at real (x.ts:1:1)",
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const snapshot = makeSnapshot({
			latestError,
			recentLogs: ["[T] GET http://user:pa%20ss@localhost/ sent sk-live-Q7", "[T] GET https://proxy.zq7w.host.test/v1"],
		});
		const body = reporter.buildBody(snapshot);
		const published = `${reporter.buildTitle(snapshot)}\n${body}\n${getIssueBody(reporter.buildIssueUrl(snapshot))}`;
		for (const value of ["sk-live-Q7", "user:pass", "pa%20ss", "proxy.zq7w", "two\nlines"]) {
			assertOmits(published, value);
		}
		// The title cuts the message's first line at 80 characters AFTER the mask, so its cut may fall inside a marker
		// ("[redact"), never inside a value.
		assert.ok(
			reporter
				.buildTitle(snapshot)
				.startsWith(
					"[Bug] Failed at http://[redacted]@localhost:4000 for [redacted]: connect ECONNREFUSED http://[redacted]@localhost:4000 for key [redacted] "
				),
			reporter.buildTitle(snapshot)
		);
		assert.deepStrictEqual(
			{
				source: /- Source: .*/.exec(body)?.[0],
				message: /- Message: .*/.exec(body)?.[0],
				logs: body.match(/\[T\] GET .*/g),
				stack: /Error: for key .*/.exec(body)?.[0],
			},
			{
				source: "- Source: Failed at http://[redacted]@localhost:4000 for [redacted]",
				message: "- Message: connect ECONNREFUSED http://[redacted]@localhost:4000 for key [redacted] [redacted]",
				logs: ["[T] GET http://[redacted]@localhost/ sent [redacted]", "[T] GET https://proxy.[redacted].host.test/v1"],
				stack: "Error: for key [redacted]",
			}
		);
	});

	test("the whole title and body equal those of a snapshot masked by hand", () => {
		// Every field passes the door once over the whole snapshot: the report of the raw snapshot is byte for byte the
		// report of the snapshot with each value replaced by hand, so no field and no section is left out of the mask.
		const key = `sk-live-${"A".repeat(32)}`;
		Logger.registerSecrets([key]);
		const raw = makeSnapshot({
			latestError: {
				source: `Failed at http://user:pass@localhost:4000 for ${key}`,
				message: `connect ECONNREFUSED http://user:pass@localhost:4000 for key ${key}`,
				stack: `Error: for key ${key}\n    at real (x.ts:1:1)`,
				timestamp: "2026-01-01T00:00:00.000Z",
			},
			recentLogs: [`[T] GET http://user:pa%20ss@localhost/ sent ${key}`, "[T] GET https://proxy.host.test/v1"],
		});
		const masked = makeSnapshot({
			latestError: {
				source: "Failed at http://[redacted]@localhost:4000 for sk-liv...",
				message: "connect ECONNREFUSED http://[redacted]@localhost:4000 for key sk-liv...",
				stack: "Error: for key sk-liv...\n    at real (x.ts:1:1)",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
			recentLogs: ["[T] GET http://[redacted]@localhost/ sent sk-liv...", "[T] GET https://proxy.host.test/v1"],
		});
		const reporter = new IssueReporter();
		const rendered = {
			title: reporter.buildTitle(raw),
			body: reporter.buildBody(raw),
			url: getIssueBody(reporter.buildIssueUrl(raw)),
		};
		assert.deepStrictEqual(rendered, {
			title: reporter.buildTitle(masked),
			body: reporter.buildBody(masked),
			url: getIssueBody(reporter.buildIssueUrl(masked)),
		});
		assert.ok(rendered.body.includes("sk-liv..."), "the masked snapshot's own rendering carries the marker");
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

	test("a classified error keeps its Classification line and its host; the door masks the userinfo alone", () => {
		const reporter = new IssueReporter();
		const snapshot = makeSnapshot({
			latestError: {
				source: "discovery",
				message: "Failed to connect to https://user:pass@internal.corp.com:4000/v1/models",
				timestamp: "2026-01-01T00:00:00.000Z",
				classification: { kind: "connection", setupHint: "proxy-not-running" },
			},
		});
		const body = reporter.buildBody(snapshot);
		assertContains(body, "- Message: Failed to connect to https://[redacted]@internal.corp.com:4000/v1/models");
		assertContains(body, "- Classification: connection (proxy-not-running)");
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

	test("recordError captures an unclassified error as the word and its frames, never its message", () => {
		// The latest error prefills public issues: a plain throw's message (localized text, a response body) stays
		// off it.
		const reporter = new IssueReporter();
		const err = new Error("test failure");
		reporter.recordError("testSource", recordedError(err));
		const latest = reporter.getLatestError();
		assert.ok(latest);
		assert.equal(latest.source, "testSource");
		assert.equal(latest.message, "unclassified");
		assert.ok(latest.stack?.startsWith("unclassified\n"), latest.stack ?? "no stack");
		assert.ok(latest.stack?.includes("test failure") !== true, "the message line is off the recorded stack");
		assert.ok(latest.timestamp);
	});

	test("recordError handles string errors as unclassified, with no stack", () => {
		const reporter = new IssueReporter();
		reporter.recordError("src", recordedError("plain string error"));
		const latest = reporter.getLatestError();
		assert.ok(latest);
		assert.equal(latest.message, "unclassified");
		assert.equal(latest.stack, undefined);
	});

	// The repeat-report fingerprint is the diagnostic signature only (enum ids, counts, flags), so nothing
	// response-derived can reach globalState.
	suite("repeat-report fingerprint and ledger", () => {
		test("the fingerprint never carries log lines, error text, stacks, sources, or timestamps", () => {
			const snapshot = makeSnapshot({
				latestError: {
					// Real sources interpolate server labels and base URLs (logError callers), so the source must stay
					// out too.
					source: 'Failed to fetch models from server "corp-label-MARKER"',
					message: "boom resp-body-MARKER",
					stack: "stack-MARKER",
					timestamp: "2026-01-01T00:00:00.000Z",
					classification: { kind: "http", status: 401, setupHint: "configure-api-key" },
				},
				recentLogs: ["log-line-MARKER"],
			});
			const fingerprint = reportFingerprint(snapshot);
			assert.ok(!fingerprint.includes("MARKER"), fingerprint);
			assert.ok(!fingerprint.includes("2026-01-01"), "a timestamp would make every report unique");
		});

		test("a changed classification or count changes the fingerprint; changed logs do not", () => {
			const base = makeSnapshot({ recentLogs: ["one"] });
			assert.strictEqual(reportFingerprint(base), reportFingerprint(makeSnapshot({ recentLogs: ["two", "three"] })));
			assert.notStrictEqual(reportFingerprint(base), reportFingerprint(makeSnapshot({ modelCount: 6 })));
			assert.notStrictEqual(reportFingerprint(base), reportFingerprint(makeSnapshot({ connectionState: "error" })));
			assert.notStrictEqual(
				reportFingerprint(base),
				reportFingerprint(
					makeSnapshot({
						latestError: {
							source: "discovery",
							message: "x",
							timestamp: "t",
							classification: { kind: "http", status: 404, setupHint: "check-base-url" },
						},
					})
				)
			);
		});

		test("the ledger round-trips through the memento and rejects junk shapes on read", async () => {
			const storage = makeExtensionStorage();
			await rememberIssueReport(storage.memento, { fingerprint: "v1|x", openedAt: 123 });
			assert.deepStrictEqual(readLastIssueReport(storage.memento), { fingerprint: "v1|x", openedAt: 123 });

			for (const junk of [undefined, null, "v1|x", 42, {}, { fingerprint: "v1|x" }, { fingerprint: 1, openedAt: 1 }]) {
				const junkStorage = makeExtensionStorage();
				if (junk !== undefined) {
					await junkStorage.memento.update("litellm.lastIssueReport", junk);
				}
				assert.strictEqual(readLastIssueReport(junkStorage.memento), undefined, JSON.stringify(junk) ?? "undefined");
			}
		});
	});
});
