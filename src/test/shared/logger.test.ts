import * as assert from "node:assert";
import { Logger } from "../../shared/logger";
import { expectDefined } from "../testUtils";

function makeSinks() {
	const channelLines: string[] = [];
	const bufferLines: string[] = [];
	const recorded: { source: string; error: unknown }[] = [];
	return {
		channelLines,
		bufferLines,
		recorded,
		channel: { appendLine: (line: string) => channelLines.push(line) },
		recorder: {
			appendLog: (line: string) => bufferLines.push(line),
			recordError: (source: string, error: unknown) => recorded.push({ source, error }),
		},
	};
}

suite("shared/logger", () => {
	test("log writes the same [ISO] line to the channel and the issue-report buffer", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);

		logger.log("hello");
		logger.log("with data", { a: 1 });

		assert.equal(sinks.channelLines.length, 2);
		assert.deepStrictEqual(sinks.bufferLines, sinks.channelLines);
		assert.match(expectDefined(sinks.channelLines[0]), /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] hello$/);
		assert.ok(expectDefined(sinks.channelLines[1]).includes('with data: {\n  "a": 1\n}'));
	});

	test("error writes the ERROR line to both sinks and records the error", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);
		const err = new Error("boom");

		logger.error("Chat request failed", err);

		assert.match(expectDefined(sinks.channelLines[0]), /^\[.+\] ERROR: Chat request failed: boom$/);
		assert.equal(sinks.bufferLines[0], sinks.channelLines[0]);
		assert.equal(sinks.recorded.length, 1);
		const recorded = expectDefined(sinks.recorded[0]);
		assert.equal(recorded.source, "Chat request failed");
		assert.equal(recorded.error, err);
	});

	test("error appends the stack trace to the channel only", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel, sinks.recorder);

		logger.error("failed", new Error("boom"));

		assert.equal(sinks.channelLines.length, 2);
		assert.ok(expectDefined(sinks.channelLines[1]).startsWith("Stack trace: "));
		assert.equal(sinks.bufferLines.length, 1, "The stack line must not enter the issue-report buffer");
	});

	test("non-Error values are stringified and works without a recorder", () => {
		const sinks = makeSinks();
		const logger = new Logger(sinks.channel);

		logger.error("failed", "string reason");

		assert.equal(sinks.channelLines.length, 1);
		assert.ok(expectDefined(sinks.channelLines[0]).endsWith("ERROR: failed: string reason"));
	});
});
