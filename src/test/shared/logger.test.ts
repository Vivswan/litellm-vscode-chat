import * as assert from "node:assert";
import { Logger } from "../../shared/logger";
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
});
