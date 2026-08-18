import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { Logger, publicErrorStack } from "../../../shared/logger";

// Both public stack surfaces - the issue-report buffer's publicErrorStack and
// the output channel's Stack trace line (the channel feeds issue reports too) -
// sanitize through one helper. These tests drive the helper through BOTH
// surfaces with the same hostile inputs, so hardening can never split.

/** The channel's error lines from one Logger.error call. */
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
		// The message embeds a frame-shaped body line; a shape filter alone would
		// keep it. The length strip removes the whole message on both surfaces.
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
		// The by-length property: when the first line is not the exact
		// `${name}: ${message}` prefix, nothing marks where the message ends, so
		// even genuine-looking frames could be message text. Both surfaces drop
		// everything but their replacement line.
		const err = Object.assign(new Error("response body secret"), {
			logClassification: "RequestError(http, status 502)",
			englishMessage: "The server returned an error.",
		});
		err.stack = "Error: innocent\n    at real (x.ts:1:1)\n    at response body secret (evil.ts:2:2)";

		assert.strictEqual(publicErrorStack(err), "RequestError(http, status 502)");
		assert.strictEqual(channelErrorLines(err)[1], "Stack trace: Error: The server returned an error.");
	});

	test("a stack getter that turns hostile after its first read cannot inject frames on either surface", () => {
		// The old code re-read error.stack between the check and the strip, so a
		// getter could pass the check with an honest value and hand the strip an
		// attacker one. Each surface now narrows the stack once and sanitizes
		// that exact value.
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
		// The shared helper may throw on hostile name/message reads; the public
		// surface falls back to the classification, the channel prints no stack
		// line at all, and neither throws.
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
