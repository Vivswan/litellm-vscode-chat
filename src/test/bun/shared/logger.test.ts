import { describe, test } from "bun:test";
import * as assert from "node:assert";
import type { RecordedError } from "../../../shared/logger";
import { errorMessageText, Logger, publicErrorStack, publicErrorText, recordedError } from "../../../shared/logger";
import { expectDefined } from "../../pureHelpers";

/** A Logger over registered values, with the channel setting as a live flag; the store is the Logger's own. */
function loggerWith(
	values: readonly string[],
	enabled: () => boolean,
	sinks: ReturnType<typeof makeSinks>,
	recorder: ReturnType<typeof makeSinks>["recorder"] | undefined
): Logger {
	Logger.registerSecrets(values);
	return new Logger(sinks.channel, recorder, enabled);
}

function makeSinks() {
	const infoLines: string[] = [];
	const errorLines: string[] = [];
	/** Every channel write in order, level first: the per-level arrays cannot show interleaving. */
	const events: [level: "info" | "error", line: string][] = [];
	const bufferLines: string[] = [];
	const recorded: { source: string; error: RecordedError }[] = [];
	return {
		infoLines,
		errorLines,
		events,
		bufferLines,
		recorded,
		channel: {
			info: (line: string) => {
				infoLines.push(line);
				events.push(["info", line]);
			},
			error: (line: string) => {
				errorLines.push(line);
				events.push(["error", line]);
			},
		},
		recorder: {
			appendLog: (line: string) => bufferLines.push(line),
			recordError: (source: string, error: RecordedError) => recorded.push({ source, error }),
		},
	};
}

describe("shared/logger", () => {
	test("log routes to the channel's info level without a hand-rolled timestamp", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);

		logger.log("hello");
		logger.log("with data", { a: 1 });

		assert.deepStrictEqual(sinks.infoLines, ["hello", 'with data: {\n  "a": 1\n}']);
		assert.equal(sinks.errorLines.length, 0);
	});

	test("log writes the [ISO]-prefixed line to the issue-report buffer", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);

		logger.log("hello");
		logger.log("with data", { a: 1 });

		assert.equal(sinks.bufferLines.length, 2);
		assert.match(expectDefined(sinks.bufferLines[0]), /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] hello$/);
		assert.ok(expectDefined(sinks.bufferLines[1]).includes('with data: {\n  "a": 1\n}'));
	});

	test("advisory writes the channel only: the issue-report buffer's budget is never consumed", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);

		logger.advisory("open field applied", { key: "my_custom_field" });
		logger.advisory("bare note");

		assert.deepStrictEqual(sinks.infoLines, ['open field applied: {\n  "key": "my_custom_field"\n}', "bare note"]);
		assert.equal(sinks.errorLines.length, 0);
		assert.equal(sinks.bufferLines.length, 0, "advisory lines must never reach the buffer");
		assert.equal(sinks.recorded.length, 0);
	});

	test("log with unserializable data does not throw: circular and JSON-invisible values take the object tag", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		logger.log("circular", circular);
		// JSON.stringify returns undefined for a bare function; the tag covers that too.
		logger.log("function", () => {});

		assert.deepStrictEqual(sinks.infoLines, ["circular: [object Object]", "function: [object Function]"]);
	});

	test("error routes to the channel's error level and records the error as unclassified", () => {
		// The channel keeps the message; the buffer and the recorded error (both prefill public issues) carry only the
		// fact that an unclassified value was thrown, with the frames under it.
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = new Error("boom");

		logger.error("Chat request failed", err);

		assert.equal(sinks.errorLines[0], "Chat request failed: boom");
		assert.equal(sinks.infoLines.length, 0);
		assert.match(expectDefined(sinks.bufferLines[0]), /^\[.+\] ERROR: Chat request failed: unclassified$/);
		assert.equal(sinks.recorded.length, 1);
		const recorded = expectDefined(sinks.recorded[0]);
		assert.equal(recorded.source, "Chat request failed");
		assert.strictEqual(recorded.error.message, "unclassified");
		const recordedStack = expectDefined(recorded.error.stack);
		assert.ok(recordedStack.startsWith("unclassified\n"), recordedStack);
		assert.ok(!recordedStack.includes("boom"), "the message line is off the recorded stack");
	});

	test("error appends the stack trace to the channel only", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);

		logger.error("failed", new Error("boom"));

		assert.equal(sinks.errorLines.length, 2);
		assert.ok(expectDefined(sinks.errorLines[1]).startsWith("Stack trace: "));
		assert.equal(sinks.bufferLines.length, 1, "The stack line must not enter the issue-report buffer");
	});

	test("non-Error values keep the buffer's hand-timestamped format", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);

		logger.error("failed", "string reason");

		assert.equal(sinks.bufferLines.length, 1);
		assert.match(
			expectDefined(sinks.bufferLines[0]),
			/^\[\d{4}-\d{2}-\d{2}T.+\] ERROR: failed: unclassified$/,
			"The issue-report buffer keeps its hand-timestamped format for non-Error values"
		);
	});

	test("non-Error values are stringified and works without a recorder", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel);

		logger.error("failed", "string reason");

		assert.deepStrictEqual(sinks.errorLines, ["failed: string reason"]);
	});

	test("a value whose String() coercion throws still logs, via the object tag", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);

		logger.error("failed", { toString: null, valueOf: null });

		assert.deepStrictEqual(sinks.errorLines, ["failed: [object Object]"]);
		assert.equal(sinks.recorded.length, 1);
	});

	test("an error carrying a logClassification keeps its message out of the buffer, not the channel", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = Object.assign(new Error("LiteLLM API error: 503\n<html>response body</html>"), {
			logClassification: "RequestError(http, status 503)",
		});
		delete err.stack;

		logger.error("Chat request failed", err);

		assert.deepStrictEqual(sinks.errorLines, [
			"Chat request failed: LiteLLM API error: 503\n<html>response body</html>",
		]);
		assert.match(
			expectDefined(sinks.bufferLines[0]),
			/^\[.+\] ERROR: Chat request failed: RequestError\(http, status 503\)$/,
			"the issue-report buffer takes the classification, never the response-derived message"
		);
	});

	test("a localized message defers to its English mirror on the channel, and to the classification in the buffer", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = Object.assign(new Error("LOCALIZED"), {
			englishMessage: "ENGLISH",
			logClassification: "RequestError(http, status 503)",
		});
		delete err.stack;

		logger.error("Chat request failed", err);

		assert.deepStrictEqual(sinks.errorLines, ["Chat request failed: ENGLISH"], "the channel line stays English");
		assert.match(
			expectDefined(sinks.bufferLines[0]),
			/^\[.+\] ERROR: Chat request failed: RequestError\(http, status 503\)$/,
			"the buffer keeps its classification-first behavior"
		);
	});

	test("a localized message without a classification lands its English mirror in both the channel and the buffer", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = Object.assign(new Error("LOCALIZED"), { englishMessage: "ENGLISH" });
		delete err.stack;

		logger.error("Chat request failed", err);

		assert.deepStrictEqual(sinks.errorLines, ["Chat request failed: ENGLISH"]);
		assert.match(expectDefined(sinks.bufferLines[0]), /^\[.+\] ERROR: Chat request failed: ENGLISH$/);
	});

	test("the channel's stack line swaps a mirrored error's message prefix for the English form, keeping the frames", () => {
		// The Stack trace: print is channel output too, and V8 bakes the (possibly localized) message into the stack's
		// first line; the same length-strip publicErrorStack uses keeps the channel English.
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = Object.assign(new Error("LOCALIZED"), { englishMessage: "ENGLISH" });

		logger.error("Chat request failed", err);

		const stackLine = expectDefined(sinks.errorLines[1]);
		assert.ok(stackLine.startsWith("Stack trace: Error: ENGLISH"), stackLine);
		assert.ok(!stackLine.includes("LOCALIZED"), "the localized message must not reach the channel's stack print");
		assert.match(stackLine, /\n\s+at /, "the real call frames must be kept");
	});

	test("a mirrored stack without the exact message prefix fails closed to the English line alone", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = Object.assign(new Error("LOCALIZED"), { englishMessage: "ENGLISH" });
		err.stack = "Mangled: LOCALIZED elsewhere\n    at real (x.ts:1:1)";

		logger.error("Chat request failed", err);

		assert.strictEqual(
			expectDefined(sinks.errorLines[1]),
			"Stack trace: Error: ENGLISH",
			"an unrecognized stack shape must not leak a possibly-localized first line"
		);
	});

	test("a hostile englishMessage getter falls back to the message text", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = new Error("boom");
		Object.defineProperty(err, "englishMessage", {
			get() {
				throw new Error("hostile getter");
			},
		});

		logger.error("failed", err);

		assert.deepStrictEqual(sinks.errorLines.slice(0, 1), ["failed: boom"]);
		assert.ok(expectDefined(sinks.bufferLines[0]).endsWith("ERROR: failed: unclassified"));
	});

	test("a hostile logClassification getter reads as unclassified in the buffer", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = new Error("boom");
		Object.defineProperty(err, "logClassification", {
			get() {
				throw new Error("hostile getter");
			},
		});

		logger.error("failed", err);

		assert.ok(expectDefined(sinks.bufferLines[0]).endsWith("ERROR: failed: unclassified"));
	});

	test("failure writes an unclassified throw's message and stack to the channel alone", () => {
		// The data line (the failure's kind) reaches every sink; the thrown text reaches the private channel, so the
		// user can diagnose, and no public sink: the buffer keeps the data line, the recorded error the word.
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = new Error("一次性错误");
		err.stack = "Error: 一次性错误\n    at real (x.ts:1:1)";

		logger.failure("failed", { kind: "unclassified" }, err);

		assert.deepStrictEqual(sinks.errorLines, [
			'failed: {\n  "kind": "unclassified"\n}',
			"failed: 一次性错误",
			"Stack trace: Error: 一次性错误\n    at real (x.ts:1:1)",
		]);
		assert.deepStrictEqual(
			sinks.bufferLines.map((line) => line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]/, "[T]")),
			['[T] ERROR: failed: {\n  "kind": "unclassified"\n}']
		);
		assert.deepStrictEqual(sinks.recorded, [
			{ source: "failed", error: { message: "unclassified", stack: "unclassified\n    at real (x.ts:1:1)" } },
		]);
	});

	test("failure keeps a publicly rendered error's text off the channel: the data line and the rendering name it", () => {
		// A classification (or an English mirror) names the failure; its message may be the response body, which no
		// sink needs.
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = Object.assign(new Error("LiteLLM API error: 502 <html>body</html>"), {
			logClassification: "RequestError(http, status 502)",
		});

		logger.failure("failed", { kind: "http", status: 502 }, err);

		assert.deepStrictEqual(sinks.errorLines, ['failed: {\n  "kind": "http",\n  "status": 502\n}']);
		assert.deepStrictEqual(
			sinks.recorded.map((entry) => entry.error.message),
			["RequestError(http, status 502)"]
		);
	});

	test("Logger.error never throws on a fully hostile proxy", () => {
		// The same throwing-getPrototypeOf proxy the helper tests use: the instanceof and stack reads inside error()
		// must be guarded too, since a logging call must never throw.
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("no proto");
				},
				get() {
					throw new Error("no reads");
				},
			}
		);

		logger.error("failed", hostile);

		assert.deepStrictEqual(
			{
				error: sinks.errorLines,
				buffer: sinks.bufferLines.map((line) => line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]/, "[T]")),
				recorded: sinks.recorded,
			},
			{
				error: ["failed: [unrenderable value]"],
				buffer: ["[T] ERROR: failed: unclassified"],
				recorded: [{ source: "failed", error: { message: "unclassified" } }],
			}
		);
	});

	test("the mask applies to the channel alone: the buffer and the recorder hold every line raw", () => {
		const sinks = makeSinks();
		const logger = loggerWith(["sk-live-Q7"], () => true, sinks, sinks.recorder);
		const baseUrl = "http://user:pass@host:4000";
		const err = new Error(`connect ECONNREFUSED ${baseUrl} for key sk-live-Q7`);
		err.stack = `Error: connect ECONNREFUSED ${baseUrl} for key sk-live-Q7\n    at real (x.ts:1:1)`;
		const stamp = (line: string): string => line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]/, "[T]");

		logger.log("Fetching models for provider group", { baseUrl, key: "sk-live-Q7" });
		logger.advisory("MCP server resolved", { uri: baseUrl });
		logger.error(`Failed to fetch models for provider group at ${baseUrl}`, err);

		const masked = "connect ECONNREFUSED http://[redacted]@host:4000 for key [redacted]";
		// The buffer and the recorded error are public: an unclassified throw leaves them its frames and the word.
		const publicLine = `Failed to fetch models for provider group at ${baseUrl}: unclassified`;
		assert.deepStrictEqual(
			{
				info: sinks.infoLines,
				error: sinks.errorLines,
				buffer: sinks.bufferLines.map(stamp),
				recorded: sinks.recorded,
			},
			{
				info: [
					'Fetching models for provider group: {\n  "baseUrl": "http://[redacted]@host:4000",\n  "key": "[redacted]"\n}',
					'MCP server resolved: {\n  "uri": "http://[redacted]@host:4000"\n}',
				],
				error: [
					`Failed to fetch models for provider group at http://[redacted]@host:4000: ${masked}`,
					`Stack trace: Error: ${masked}\n    at real (x.ts:1:1)`,
				],
				buffer: [
					`[T] Fetching models for provider group: {\n  "baseUrl": "${baseUrl}",\n  "key": "sk-live-Q7"\n}`,
					`[T] ERROR: ${publicLine}`,
				],
				recorded: [
					{
						source: `Failed to fetch models for provider group at ${baseUrl}`,
						error: { message: "unclassified", stack: "unclassified\n    at real (x.ts:1:1)" },
					},
				],
			}
		);
	});

	test("replay writes the channel's own history again, in order, under the mask of the moment, through both flips", () => {
		// The logs.redactSecrets flip: the channel showed masked lines; after the flip the same lines come back raw, in
		// the order they were written and at their levels, from the channel's history rather than the issue report's
		// ring (which has no advisory lines and no stack prints); a second flip replays them masked again.
		let masking = true;
		const sinks = makeSinks();
		const logger = loggerWith(["sk-live-Q7"], () => masking, sinks, sinks.recorder);
		const err = new Error("403 for sk-live-Q7");
		err.stack = "Error: 403 for sk-live-Q7\n    at real (x.ts:1:1)";
		logger.log("key sk-live-Q7 accepted");
		logger.error("key refused", err);
		logger.advisory("MCP server resolved", { key: "sk-live-Q7" });
		const masked: [level: "info" | "error", line: string][] = [
			["info", "key [redacted] accepted"],
			["error", "key refused: 403 for [redacted]"],
			["error", "Stack trace: Error: 403 for [redacted]\n    at real (x.ts:1:1)"],
			["info", 'MCP server resolved: {\n  "key": "[redacted]"\n}'],
		];
		const raw: [level: "info" | "error", line: string][] = [
			["info", "key sk-live-Q7 accepted"],
			["error", "key refused: 403 for sk-live-Q7"],
			["error", "Stack trace: Error: 403 for sk-live-Q7\n    at real (x.ts:1:1)"],
			["info", 'MCP server resolved: {\n  "key": "sk-live-Q7"\n}'],
		];
		assert.deepStrictEqual(sinks.events, masked);

		masking = false;
		sinks.events.length = 0;
		logger.replay();
		assert.deepStrictEqual(sinks.events, raw);

		masking = true;
		sinks.events.length = 0;
		logger.replay();
		assert.deepStrictEqual({ events: sinks.events, buffer: sinks.bufferLines.length }, { events: masked, buffer: 2 });
	});

	test("the issue report reads the newest 50 report lines of the same history the channel showed", () => {
		// One history, two readers: a line the channel shows is the line the report sees (stamped), minus the advisory
		// and stack lines that have no report rendering, and the report keeps only the newest 50 of them.
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		logger.advisory("note before");
		for (let i = 0; i < 60; i++) {
			logger.log(`line ${i}`);
		}
		const err = new Error("boom");
		err.stack = "Error: boom\n    at real (x.ts:1:1)";
		logger.error("failed", err);
		const stamp = (line: string): string => line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]/, "[T]");
		const report = logger.reportLines().map(stamp);
		assert.deepStrictEqual(
			{ count: report.length, first: report[0], last: report.at(-1), channelLast: sinks.errorLines },
			{
				count: 50,
				first: "[T] line 11",
				last: "[T] ERROR: failed: unclassified",
				channelLast: ["failed: boom", "Stack trace: Error: boom\n    at real (x.ts:1:1)"],
			}
		);
		assert.deepStrictEqual(report, sinks.bufferLines.slice(-50).map(stamp), "the tee sees the same lines");
		// The report's cap drops renderings, never channel lines: the 60 log lines, the advisory, the error and its
		// stack all replay.
		sinks.events.length = 0;
		logger.replay();
		assert.strictEqual(sinks.events.length, 63);
	});

	test("channel-only traffic never evicts a report line, and an oversized line is cut once at write", () => {
		// One error, its 2 MiB stack print, then advisories: the report line survives both bounds, the stack is cut to
		// CHANNEL_LINE_CHARS with a marker, and replay shows it once while the history has room; past the line bound
		// the oldest channel-only entries go first and the report line still stands.
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel);
		const err = new Error("boom");
		err.stack = `Error: boom\n${"    at frame (x.ts:1:1)\n".repeat(90_000)}`;
		assert.ok((err.stack?.length ?? 0) > 2 * 1_048_576, "the fixture stack is over 2 MiB");
		logger.error("failed", err);
		for (let i = 0; i < 150; i++) {
			logger.advisory(`serve pass ${i}`);
		}
		const stamp = (line: string): string => line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]/, "[T]");
		const stackLines = sinks.errorLines.filter((line) => line.startsWith("Stack trace: "));
		sinks.events.length = 0;
		logger.replay();
		const replayedStacks = sinks.events.filter(([, line]) => line.startsWith("Stack trace: "));
		assert.deepStrictEqual(
			{
				report: logger.reportLines().map(stamp),
				written: stackLines.length,
				cut: stackLines[0]?.length,
				marker: stackLines[0]?.slice(stackLines[0].lastIndexOf(" [")),
				replayed: replayedStacks.length,
				replayedSame: replayedStacks[0]?.[1] === stackLines[0],
			},
			{
				report: ["[T] ERROR: failed: unclassified"],
				written: 1,
				cut: 262_144 + ` [${(err.stack?.length ?? 0) + "Stack trace: ".length - 262_144} more characters cut]`.length,
				marker: ` [${(err.stack?.length ?? 0) + "Stack trace: ".length - 262_144} more characters cut]`,
				replayed: 1,
				replayedSame: true,
			}
		);

		for (let i = 150; i < 400; i++) {
			logger.advisory(`serve pass ${i}`);
		}
		assert.deepStrictEqual(logger.reportLines().map(stamp), ["[T] ERROR: failed: unclassified"]);
	});
});

describe("shared/logger redact: the one output door", () => {
	test("every registered value goes in each spelling a line can carry, with a six-character reveal from 20 characters", () => {
		const rows: readonly { text: string; values: readonly string[]; expected: string; title: string }[] = [
			{
				title: "a 40-character key keeps its first six characters, so the user can tell which key a message is about",
				text: "answered 401 for sk-reveal-K9abcdefghijklmnopqrstuvwxyz",
				values: ["sk-reveal-K9abcdefghijklmnopqrstuvwxyz"],
				expected: "answered 401 for sk-rev...",
			},
			{
				title: "a 19-character value is masked whole",
				text: "key nineteen-chars-v19x sent",
				values: ["nineteen-chars-v19x"],
				expected: "key [redacted] sent",
			},
			{
				title: "a short value is masked whole",
				text: "key abcd1234 sent",
				values: ["abcd1234"],
				expected: "key [redacted] sent",
			},
			{
				title: "URL userinfo is masked whole, whatever its length",
				text: "GET http://alice:pw-0123456789-0123456789-0123456789@host.test/v1",
				values: [],
				expected: "GET http://[redacted]@host.test/v1",
			},
			{
				title: "the percent-encoded spelling the parser writes into a URL, either hex case",
				text: "GET http://host/?token=pa%20ss%2f1",
				values: ["pa ss/1"],
				expected: "GET http://host/?token=[redacted]",
			},
			{
				title: "the form-encoded spelling URLSearchParams sends (a + per space)",
				text: "the secret pa+ss%2F1 does not match",
				values: ["pa ss/1"],
				expected: "the secret [redacted] does not match",
			},
			{
				title: "the JSON-escaped spelling a serialized data field carries",
				text: '{"note": "line\\nbreak \\"quoted\\""}',
				values: ['line\nbreak "quoted"'],
				expected: '{"note": "[redacted]"}',
			},
			{
				title: "a value that is also a word blanks that word: the accepted cost of no parsing",
				text: "https://u:pw@proxy.zq7w.host answered",
				values: ["zq7w"],
				expected: "https://[redacted]@proxy.[redacted].host answered",
			},
			{
				title: "a lone surrogate has no percent form (encodeURIComponent throws); the raw spelling still masks",
				text: "key \ud800abc sent",
				values: ["\ud800abc"],
				expected: "key [redacted] sent",
			},
			{
				title: "overlapping values merge into one span and lose the reveal, so no character of either shows",
				text: "key abc123xyz0123456789abcdefQQ sent",
				values: ["abc123xyz0123456789abcdef", "123xyz0123456789abcdefQQ"],
				expected: "key [redacted] sent",
			},
			{
				title:
					"a value repeated across a very long line masks to one span (a spread of every span overflowed the stack)",
				text: "a".repeat(200_000),
				values: ["aaaa"],
				expected: "[redacted]",
			},
			{
				title: "a known value that eats the @ cannot hide the userinfo: both are spans on the original text",
				text: "GET http://alice:pw@host.test/v1",
				values: ["@host"],
				expected: "GET http://[redacted].test/v1",
			},
			{
				title: "a password holding an @ goes whole; an address in a query or fragment is no userinfo",
				text: "GET http://alice:p@ss@hub.test/ and https://host.test?email=admin@example.com#x@y",
				values: [],
				expected: "GET http://[redacted]@hub.test/ and https://host.test?email=admin@example.com#x@y",
			},
			{
				title: "a double quote ends a userinfo run: a serialized URL and a later field's address are two strings",
				text: 'after: {"webhook":"https://host.test","owner":"admin@example.com"}',
				values: [],
				expected: 'after: {"webhook":"https://host.test","owner":"admin@example.com"}',
			},
			{
				title: "the reveal shows raw characters only where the raw spelling stands: an escaped spelling masks whole",
				text: '{"k":"ab\\"cdefghijklmnopqrstuvwxyz"} and ab"cdefghijklmnopqrstuvwxyz',
				values: ['ab"cdefghijklmnopqrstuvwxyz'],
				expected: '{"k":"[redacted]"} and ab"cde...',
			},
			{
				title:
					"percent-escape case folds in the encoded spellings only; a raw value with a percent sign matches literally",
				text: "raw key%ABcd-zq7 goes, key%abcd-zq7 stays, pa%20ss%2f1 goes",
				values: ["key%ABcd-zq7", "pa ss/1"],
				expected: "raw [redacted] goes, key%abcd-zq7 stays, [redacted] goes",
			},
			{
				title: "a value inside an existing marker is no match, so no exit can write [[redacted]]",
				text: "value acted] here, marker [redacted] here",
				values: ["acted]"],
				expected: "value [redacted] here, marker [redacted] here",
			},
		];
		for (const { title, text, values, expected } of rows) {
			Logger.registerSecrets(values);
			const masked = Logger.redact(text);
			assert.strictEqual(masked, expected, title);
			assert.strictEqual(Logger.redact(masked), masked, `idempotent: ${title}`);
		}
	});

	test("the documented cases of @zapier/secret-scrubber mask through this door too, with this door's marker", () => {
		// Conformance against the README of the library the owner weighed and declined: a quoted password, a
		// percent-encoded query value, the form-encoded + spelling, and a JSON-escaped value.
		Logger.registerSecrets(["very-secret-password", "this is my key", "tab\tseparated"]);
		assert.deepStrictEqual(
			[
				Logger.redact('Hey there! The password is "very-secret-password"'),
				Logger.redact("https://site.com?api_key=this%20is%20my%20key"),
				Logger.redact("https://site.com?api_key=this+is+my+key"),
				Logger.redact(JSON.stringify({ text: "tab\tseparated" })),
			],
			[
				'Hey there! The password is "very-s..."',
				"https://site.com?api_key=[redacted]",
				"https://site.com?api_key=[redacted]",
				'{"text":"[redacted]"}',
			]
		);
	});
});

describe("shared/logger channel history bounds", () => {
	test("the masked channel rendering masks before the bound: a 300000-character value shows as its marker, not a cut", () => {
		// Cut first, safeCut would move the cut to the span's start and the channel would show the cut marker alone.
		const sinks = makeSinks();
		const logger = loggerWith(["aaaa"], () => true, sinks, undefined);
		logger.advisory("a".repeat(300_000));
		assert.deepStrictEqual(sinks.infoLines, ["[redacted]"]);
	});

	test("an oversized line is cut before a value astride the bound, so a flip cannot replay a prefix of it", () => {
		// Written with redaction OFF, replayed after turning it ON: the raw prefix kept in the history holds whole
		// values or none, so the mask of the moment applies to it as to any line.
		let enabled = false;
		const sinks = makeSinks();
		const logger = loggerWith(["secret-long-Q7"], () => enabled, sinks, undefined);
		const line = `${"x".repeat(262_144 - 5)}secret-long-Q7${"y".repeat(100)}`;
		logger.advisory(line);
		enabled = true;
		logger.replay();
		const [written, replayed] = sinks.infoLines;
		assert.deepStrictEqual(
			{
				written: written === `${"x".repeat(262_144 - 5)} [${"secret-long-Q7".length + 100} more characters cut]`,
				replayedSame: replayed === written,
			},
			{ written: true, replayedSame: true }
		);
	});

	test("a report rendering is cut the same way and charged to the budget, so a huge payload cannot pin memory", () => {
		const sinks = makeSinks();
		const logger = loggerWith(["sk-live-Q7"], () => false, sinks, sinks.recorder);
		logger.log("payload", "x".repeat(100_000_000));
		const [report] = logger.reportLines();
		sinks.infoLines.length = 0;
		logger.replay();
		assert.deepStrictEqual(
			{
				bounded: (report?.length ?? 0) < 262_144 + 64,
				cut: report?.endsWith(" more characters cut]"),
				teeSame: sinks.bufferLines[0] === report,
				replayedBounded: (sinks.infoLines[0]?.length ?? 0) < 262_144 + 64,
			},
			{ bounded: true, cut: true, teeSame: true, replayedBounded: true }
		);
	});

	test("the history drops its oldest channel-only lines past the character bound, so a run of large stacks cannot pin memory", () => {
		// Five 600 KB advisory lines: each is cut to CHANNEL_LINE_CHARS at write, four of them exceed the character
		// bound, so the oldest channel-only entries go and replay shows the newest three, each cut once.
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel);
		const big = "x".repeat(600_000);
		logger.advisory("first");
		for (let i = 0; i < 5; i++) {
			logger.advisory(big);
		}
		sinks.infoLines.length = 0;
		logger.replay();
		const cut = `${"x".repeat(262_144)} [${600_000 - 262_144} more characters cut]`;
		assert.deepStrictEqual(sinks.infoLines, [cut, cut, cut]);
	});
});

describe("shared/logger errorMessageText", () => {
	test("an Error yields its message", () => {
		assert.strictEqual(errorMessageText(new Error("boom")), "boom");
	});

	test("plain values go through String()", () => {
		assert.strictEqual(errorMessageText("string reason"), "string reason");
		assert.strictEqual(errorMessageText(42), "42");
		assert.strictEqual(errorMessageText(undefined), "undefined");
		assert.strictEqual(errorMessageText(null), "null");
	});

	test("a value whose String() coercion throws falls back to the object tag", () => {
		assert.strictEqual(errorMessageText({ toString: null, valueOf: null }), "[object Object]");
		assert.strictEqual(
			errorMessageText(
				Object.create(null, {
					[Symbol.toPrimitive]: {
						value: () => {
							throw new Error("hostile");
						},
					},
				})
			),
			"[object Object]"
		);
	});

	test("hostile proxies cannot break the coercion: every step degrades to the next fallback", () => {
		// A proxy whose getPrototypeOf trap throws breaks the instanceof check;
		// the object tag still works because the get trap is honest.
		const throwingProto = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("no proto for you");
				},
			}
		);
		assert.strictEqual(errorMessageText(throwingProto), "[object Object]");

		// A proxy that also throws on property reads defeats the tag too (it reads Symbol.toStringTag); the literal is
		// the last resort.
		const fullyHostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("no proto");
				},
				get() {
					throw new Error("no reads");
				},
			}
		);
		assert.strictEqual(errorMessageText(fullyHostile), "[unrenderable value]");
	});
});

describe("shared/logger public renderings", () => {
	test("publicErrorText prefers the classification and reads an unclassified throw as the word alone", () => {
		const classified = Object.assign(new Error("secret body"), { logClassification: "RequestError(http, status 502)" });
		assert.strictEqual(publicErrorText(classified), "RequestError(http, status 502)");
		assert.strictEqual(publicErrorText(new Error("template text")), "unclassified");
		assert.strictEqual(publicErrorText("a thrown string"), "unclassified");
	});

	test("an unclassified throw's message reaches no public rendering, whatever its script", () => {
		// The message may be localized text or a response body; the public surfaces (buffer, latest-error snapshot,
		// status window) carry the fact of the throw and the frames, never the sentence.
		const thrown = new Error("一次性错误");
		assert.strictEqual(publicErrorText(thrown), "unclassified");
		const recorded = recordedError(thrown);
		assert.strictEqual(recorded.message, "unclassified");
		assert.ok(!JSON.stringify(recorded).includes("一次性"), JSON.stringify(recorded));
		const recordedStack = expectDefined(recorded.stack);
		assert.ok(recordedStack.startsWith("unclassified\n"), recordedStack);
		assert.match(recordedStack, /\n\s+at /, "the frames stay");
	});

	test("publicErrorText ranks classification over English mirror over message", () => {
		const both = Object.assign(new Error("LOCALIZED"), {
			logClassification: "RequestError(http, status 502)",
			englishMessage: "ENGLISH",
		});
		assert.strictEqual(publicErrorText(both), "RequestError(http, status 502)");
		const mirrorOnly = Object.assign(new Error("LOCALIZED"), { englishMessage: "ENGLISH" });
		assert.strictEqual(publicErrorText(mirrorOnly), "ENGLISH");
	});

	test("publicErrorStack replaces a mirrored error's message line with the English form, keeping the frames", () => {
		const err = Object.assign(new Error("LOCALIZED"), { englishMessage: "ENGLISH" });
		const stack = expectDefined(publicErrorStack(err));
		assert.ok(stack.startsWith("Error: ENGLISH"), stack);
		assert.ok(!stack.includes("LOCALIZED"), "the localized display message must not reach the public stack");
		assert.match(stack, /\n\s+at /, "the real call frames must be kept");
	});

	test("publicErrorStack strips the message BY LENGTH: frame-shaped body lines never survive", () => {
		// An http body can contain lines shaped like stack frames; a shape filter alone would keep them. The exact
		// `${name}: ${message}` prefix strip removes the whole message before any line filtering runs.
		const err = Object.assign(
			new Error("LiteLLM API error: 502\n\tat com.acme.internal.BillingService.charge(BillingService.java:42)"),
			{ logClassification: "RequestError(http, status 502)" }
		);
		const stack = expectDefined(publicErrorStack(err));
		assert.ok(!stack.includes("com.acme.internal"), `the body's frame-shaped line survived: ${stack}`);
		assert.ok(stack.startsWith("RequestError(http, status 502)"), stack);
		assert.match(stack, /\n\s+at /, "the real call frames must be kept");
	});

	test("publicErrorStack fails closed to the classification when the stack lacks the message prefix", () => {
		const err = Object.assign(new Error("boom"), { logClassification: "RequestError(http, status 502)" });
		err.stack = "\tat com.acme.internal.Evil.line(Evil.java:1)\n    at real (x.ts:1:1)";
		assert.strictEqual(publicErrorStack(err), "RequestError(http, status 502)");
	});

	test("publicErrorStack drops an unclassified error's message line, keeping the frames", () => {
		const err = new Error("plain");
		const stack = expectDefined(publicErrorStack(err));
		assert.ok(stack.startsWith("unclassified\n"), stack);
		assert.ok(!stack.includes("plain"), "the message must not reach the public stack");
		assert.match(stack, /\n\s+at /, "the real call frames must be kept");
		assert.strictEqual(publicErrorStack("not an error"), undefined);
	});
});

// Both public stack surfaces - the issue-report buffer's publicErrorStack and the output channel's Stack trace line
// (the channel feeds issue reports too) - sanitize through one helper. These tests drive the helper through BOTH
// surfaces with the same hostile inputs, so hardening can never split.

function channelErrorLines(error: unknown): string[] {
	const errorLines: string[] = [];
	const logger = new Logger({ info: () => {}, error: (line: string) => errorLines.push(line) });
	logger.error("failed", error);
	return errorLines;
}

const RESPONSE_BODY =
	"LiteLLM API error: 502\n\tat com.acme.internal.BillingService.charge(BillingService.java:42)\nresponse body secret";

describe("shared/logger stack sanitization (both surfaces)", () => {
	test("response-derived message text never survives either surface: stripped BY LENGTH, real frames kept", () => {
		// The message embeds a frame-shaped body line; a shape filter alone would keep it. The length strip removes the
		// whole message on both surfaces.
		const err = Object.assign(new Error(RESPONSE_BODY), {
			logClassification: "RequestError(http, status 502)",
			englishMessage: "The server returned an error.",
		});

		const publicStack = publicErrorStack(err);
		assert.ok(publicStack !== undefined);
		assert.ok(!publicStack.includes("com.acme.internal"), publicStack);
		assert.ok(!publicStack.includes("response body secret"), publicStack);
		assert.ok(publicStack.startsWith("RequestError(http, status 502)"), publicStack);
		assert.match(publicStack, /\n\s+at /, "the real call frames must be kept");

		const channelStack = channelErrorLines(err)[1];
		assert.ok(channelStack !== undefined, "the channel must print a Stack trace line");
		assert.ok(channelStack.startsWith("Stack trace: Error: The server returned an error."), channelStack);
		assert.ok(!channelStack.includes("com.acme.internal"), channelStack);
		assert.ok(!channelStack.includes("response body secret"), channelStack);
		assert.match(channelStack, /\n\s+at /, "the real call frames must be kept");
	});

	test("a stack that lies about its message fails closed on both surfaces: no frames, no message", () => {
		// The by-length property: when the first line is not the exact `${name}: ${message}` prefix, nothing marks
		// where the message ends, so even genuine-looking frames could be message text.
		const err = Object.assign(new Error("response body secret"), {
			logClassification: "RequestError(http, status 502)",
			englishMessage: "The server returned an error.",
		});
		err.stack = "Error: innocent\n    at real (x.ts:1:1)\n    at response body secret (evil.ts:2:2)";

		assert.strictEqual(publicErrorStack(err), "RequestError(http, status 502)");
		assert.strictEqual(channelErrorLines(err)[1], "Stack trace: Error: The server returned an error.");
	});

	test("a stack getter that turns hostile after its first read cannot inject frames on either surface", () => {
		// The old code re-read error.stack between the check and the strip, so a getter could pass the check with an
		// honest value and hand the strip an attacker one. Each surface now narrows the stack once and sanitizes that
		// exact value.
		const makeErr = () => {
			const err = Object.assign(new Error("response body secret"), {
				logClassification: "RequestError(http, status 502)",
				englishMessage: "The server returned an error.",
			});
			let read = false;
			Object.defineProperty(err, "stack", {
				get() {
					const stack = read
						? "Error: response body secret\n    at attacker-injected (evil.ts:1:1)"
						: "Error: response body secret\n    at real (x.ts:1:1)";
					read = true;
					return stack;
				},
			});
			return err;
		};

		assert.strictEqual(publicErrorStack(makeErr()), "RequestError(http, status 502)\n    at real (x.ts:1:1)");
		assert.strictEqual(
			channelErrorLines(makeErr())[1],
			"Stack trace: Error: The server returned an error.\n    at real (x.ts:1:1)"
		);
	});

	test("a hostile name getter keeps each surface's own catch fallback", () => {
		// The shared helper may throw on hostile name/message reads; the public surface falls back to the
		// classification, the channel prints no stack line at all, and neither throws.
		const err = Object.assign(new Error("response body secret"), {
			logClassification: "RequestError(http, status 502)",
			englishMessage: "The server returned an error.",
		});
		Object.defineProperty(err, "name", {
			get() {
				throw new Error("hostile getter");
			},
		});

		assert.strictEqual(publicErrorStack(err), "RequestError(http, status 502)");
		const lines = channelErrorLines(err);
		assert.strictEqual(lines.length, 1, "a lost stack must not become a Stack trace line");
		assert.ok(!lines.some((line) => line.includes("response body secret")), lines.join("\n"));
	});
});
