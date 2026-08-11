import * as assert from "node:assert";
import { errorMessageText, Logger, publicErrorStack, publicErrorText } from "../../shared/logger";
import { expectDefined } from "../testUtils";

function makeSinks() {
	const infoLines: string[] = [];
	const errorLines: string[] = [];
	const bufferLines: string[] = [];
	const recorded: { source: string; error: unknown }[] = [];
	return {
		infoLines,
		errorLines,
		bufferLines,
		recorded,
		channel: {
			info: (line: string) => infoLines.push(line),
			error: (line: string) => errorLines.push(line),
		},
		recorder: {
			appendLog: (line: string) => bufferLines.push(line),
			recordError: (source: string, error: unknown) => recorded.push({ source, error }),
		},
	};
}

suite("shared/logger", () => {
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
		// The buffer is the issue reporter's small ring; recurring informational
		// notes (open capability fields applied as-is) must not evict the real
		// errors it exists to carry.
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

	test("error routes to the channel's error level and records the error", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = new Error("boom");

		logger.error("Chat request failed", err);

		assert.equal(sinks.errorLines[0], "Chat request failed: boom");
		assert.equal(sinks.infoLines.length, 0);
		assert.match(expectDefined(sinks.bufferLines[0]), /^\[.+\] ERROR: Chat request failed: boom$/);
		assert.equal(sinks.recorded.length, 1);
		const recorded = expectDefined(sinks.recorded[0]);
		assert.equal(recorded.source, "Chat request failed");
		assert.equal(recorded.error, err);
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
			/^\[\d{4}-\d{2}-\d{2}T.+\] ERROR: failed: string reason$/,
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
		// The seam every localized transport error rides: the display message
		// (possibly translated) reaches only the chat UI; the output channel
		// renders the full English mirror, and the issue-report buffer records
		// the terse classification when one exists.
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
		// The Stack trace: print is channel output too, and V8 bakes the
		// (possibly localized) message into the stack's first line; the same
		// length-strip publicErrorStack uses keeps the channel English.
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
		assert.ok(expectDefined(sinks.bufferLines[0]).endsWith("ERROR: failed: boom"));
	});

	test("a hostile logClassification getter falls back to the message text", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = new Error("boom");
		Object.defineProperty(err, "logClassification", {
			get() {
				throw new Error("hostile getter");
			},
		});

		logger.error("failed", err);

		assert.ok(expectDefined(sinks.bufferLines[0]).endsWith("ERROR: failed: boom"));
	});

	test("Logger.error never throws on a fully hostile proxy", () => {
		// The same throwing-getPrototypeOf proxy the helper tests use: the
		// instanceof and stack reads inside error() must be guarded too, since
		// a logging call must never throw.
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

		assert.deepStrictEqual(sinks.errorLines, ["failed: [unrenderable value]"]);
		assert.ok(expectDefined(sinks.bufferLines[0]).endsWith("ERROR: failed: [unrenderable value]"));
		assert.equal(sinks.recorded.length, 1, "the recorder still gets the raw value");
	});
});

suite("shared/logger errorMessageText", () => {
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

		// A proxy that also throws on property reads defeats the tag too (it
		// reads Symbol.toStringTag); the literal is the last resort.
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

suite("shared/logger public renderings", () => {
	test("publicErrorText prefers the classification and falls back to the message", () => {
		const classified = Object.assign(new Error("secret body"), { logClassification: "RequestError(http, status 502)" });
		assert.strictEqual(publicErrorText(classified), "RequestError(http, status 502)");
		assert.strictEqual(publicErrorText(new Error("template text")), "template text");
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
		// An http body can contain lines shaped like stack frames; a shape
		// filter alone would keep them. The exact `${name}: ${message}` prefix
		// strip removes the whole message before any line filtering runs.
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

	test("publicErrorStack leaves unclassified errors' stacks alone", () => {
		const err = new Error("plain");
		assert.strictEqual(publicErrorStack(err), err.stack);
		assert.strictEqual(publicErrorStack("not an error"), undefined);
	});
});
