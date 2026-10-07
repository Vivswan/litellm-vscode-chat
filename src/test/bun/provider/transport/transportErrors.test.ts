/**
 * Pinned under bun so an expected string is checked before a push. The pins that need vscode (CancellationError
 * identity, LanguageModelError construction, mapSdkError's routing) stay in the host suite
 * src/test/provider/transport/errorMapping.test.ts.
 */
import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	type MapErrorContext,
	RequestError,
	socketFailureRequestError,
	streamErrorFrame,
	TRANSPORT_ERROR_SURFACES,
	thrownErrorDisplayText,
	timeoutRequestError,
	twoPartTexts,
} from "../../../../provider/transport/transportErrors";
import { transportClassificationOf } from "../../../../shared/errorClassification";
import { Logger } from "../../../../shared/logger";
import { MirroredError } from "../../../../shared/mirroredError";
import { assertStartsWith } from "../../../pureHelpers";

const chatCtx: MapErrorContext = { surface: "chat", baseUrl: "http://litellm.test", timeoutMs: 5000 };

describe("provider/transport/transportErrors", () => {
	describe("socket failures at the OAuth token endpoint", () => {
		test("the OAuth token endpoint gets neither the suggestion nor the hint", () => {
			const mapped = socketFailureRequestError(
				Object.assign(new Error("getaddrinfo ENOTFOUND www.localhost"), { code: "ENOTFOUND" }),
				undefined,
				{ endpoint: "oauthToken", surface: "chat", url: "http://www.localhost:8080/token" },
				() => timeoutRequestError(chatCtx, undefined)
			);
			assert.strictEqual(mapped.setupHint, undefined);
			assert.ok(!mapped.message.includes("Try "), mapped.message);
			assert.strictEqual(mapped.oauthTokenEndpoint, true);
		});
	});

	describe("stream error frames and the display door", () => {
		test("a value astride the stream detail's 300-character cap is masked before the cut", () => {
			// 275 x's put the 40-character key across the cap: cut first, "sk-live-AAAAAAAAAAAAAAAAA" would stay.
			const key = `sk-live-${"A".repeat(32)}`;
			Logger.registerSecrets([key]);
			const err = streamErrorFrame({ message: `${"x".repeat(275)}${key}` });
			const expected =
				"The server reported an error while it was streaming this reply, so the response was interrupted. This is often temporary - trying again may work; if it repeats, the detail below shows what the server said." +
				`\n\nDetails: LiteLLM stream error: ${"x".repeat(275)}sk-liv...`;
			assert.deepStrictEqual(
				{ message: err.message, english: err.englishMessage },
				{ message: expected, english: expected }
			);
		});

		test("masking is idempotent across the doors: a value inside a marker is no match, so no exit writes [[redacted]]", () => {
			// "acted]" stands in for a registered word that is also inside the marker (the fixture avoids registering
			// "redacted" itself, which would blank the word across every later test).
			Logger.registerSecrets(["acted]"]);
			const err = streamErrorFrame({ message: "Denied acted]" });
			assert.ok(err.message.endsWith("\n\nDetails: LiteLLM stream error: Denied [redacted]"), err.message);
			assert.ok(
				err.englishMessage?.endsWith("\n\nDetails: LiteLLM stream error: Denied [redacted]"),
				err.englishMessage ?? "no English mirror"
			);
			assert.strictEqual(
				thrownErrorDisplayText(new MirroredError("Denied acted]", { englishMessage: "Denied acted]" })),
				"Denied [redacted]"
			);
		});

		test("thrownErrorDisplayText renders a raw throw through the door whole, and a MirroredError's text as built", () => {
			const key = `sk-live-${"A".repeat(32)}`;
			Logger.registerSecrets([key]);
			assert.deepStrictEqual(
				[
					thrownErrorDisplayText(new Error(`failed for ${key} at http://bob:pw@hub.test/v1`)),
					thrownErrorDisplayText(`failed for ${key}`),
					thrownErrorDisplayText(new MirroredError(`failed for ${key}`, { englishMessage: `failed for ${key}` })),
				],
				["failed for sk-liv... at http://[redacted]@hub.test/v1", "failed for sk-liv...", "failed for sk-liv..."]
			);
		});

		test("a message-less stream error frame still surfaces its type and code", () => {
			const err = streamErrorFrame({ type: "rate_limit_error", code: 429 });
			// A known class swaps in that class's headline: "trying again may work" would be wrong advice for a rate
			// limit or a blown budget.
			assert.ok(err.message.startsWith("The server is handling too many requests"), err.message);
			assert.ok(err.message.endsWith("\n\nDetails: LiteLLM stream error rate_limit_error (429)"), err.message);
			assert.strictEqual(err.status, undefined, "no status may be derived from the envelope's code");
		});

		test("an empty stream error frame says the server provided no detail", () => {
			const err = streamErrorFrame({});
			assert.ok(
				err.message.endsWith("\n\nDetails: LiteLLM stream error (no detail provided by the server)"),
				err.message
			);
		});
	});

	describe("classification for status surfaces", () => {
		test("a RequestError's classification carries its present fields only", () => {
			const withHint = transportClassificationOf(
				new RequestError("guidance", "http", { status: 404, setupHint: "check-base-url", englishMessage: "guidance" })
			);
			assert.deepStrictEqual(withHint, { kind: "http", status: 404, setupHint: "check-base-url" });

			const bare = transportClassificationOf(new RequestError("timed out", "timeout", { englishMessage: "timed out" }));
			assert.deepStrictEqual(bare, { kind: "timeout" });
			assert.ok(
				!("status" in (bare ?? {})) && !("setupHint" in (bare ?? {})),
				"absent fields stay absent, not present-as-undefined"
			);
		});

		test("a plain Error has no classification; its display text is its message", () => {
			assert.strictEqual(thrownErrorDisplayText(new Error("boom")), "boom");
			assert.strictEqual(transportClassificationOf(new Error("boom")), undefined);
		});
	});

	describe("statusless frame classification", () => {
		test("a mid-stream context-window frame gives the conversation-too-long advice, never the generic retry advice", () => {
			const frame = streamErrorFrame({
				message: "litellm.ContextWindowExceededError: input is too long",
				type: "context_window_exceeded",
			});
			assertStartsWith(frame.message, "The conversation is too long for this model");
			assert.ok(!frame.message.includes("trying again may work"), frame.message);
		});

		test("a statusless frame merely mentioning the context window keeps the generic interrupted-stream headline", () => {
			// No status vouches for the frame, so a bare mention proves nothing: "trim the conversation" would be wrong
			// advice for an upstream that died for another reason while talking about its context window.
			const frame = streamErrorFrame({
				message: "The upstream provider failed while preparing the model's context window",
			});
			assertStartsWith(frame.message, "The server reported an error while it was streaming this reply");
			assert.strictEqual(frame.logClassification, "RequestError(http, in-band stream error frame)");
		});

		test("a statusless frame naming the maximum context length without a limit figure stays generic too", () => {
			// The signature is the exceedance, not the word "maximum": a message describing the limit without
			// overrunning it proves nothing.
			const frame = streamErrorFrame({
				message: "The upstream failed while reading the model's maximum context length",
			});
			assertStartsWith(frame.message, "The server reported an error while it was streaming this reply");
			assert.strictEqual(frame.logClassification, "RequestError(http, in-band stream error frame)");
		});

		test("a statusless frame whose message proves the exceedance classifies without the structured marks", () => {
			const frame = streamErrorFrame({
				message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9021 tokens.",
			});
			assertStartsWith(frame.message, "The conversation is too long for this model");
			assert.strictEqual(
				frame.logClassification,
				"RequestError(http, in-band stream error frame, context_window_exceeded)"
			);
		});
	});

	describe("twoPartTexts (the one headline+detail join)", () => {
		test("joins per surface and applies the identical join to the English mirror", () => {
			const headline = { display: "AFFICHAGE", english: "HEADLINE" };
			const chat = twoPartTexts("chat", headline, "detail line");
			assert.strictEqual(chat.message, "AFFICHAGE\n\nDetails: detail line");
			assert.strictEqual(chat.englishMessage, "HEADLINE\n\nDetails: detail line");
			// Commit errors reach a VS Code notification, which flattens newlines: the "Details:" lead-in is the
			// visible boundary there, like chat.
			const commit = twoPartTexts("commitGeneration", headline, "detail line");
			assert.strictEqual(commit.message, "AFFICHAGE\n\nDetails: detail line");
			assert.strictEqual(commit.englishMessage, "HEADLINE\n\nDetails: detail line");
			const discovery = twoPartTexts("discovery", headline, "detail line");
			assert.strictEqual(discovery.message, "AFFICHAGE\ndetail line");
			assert.strictEqual(discovery.englishMessage, "HEADLINE\ndetail line");
			// Completion errors serve the dashboard's test probe, which splits on the discovery-style "\n".
			const completion = twoPartTexts("completion", headline, "detail line");
			assert.strictEqual(completion.message, "AFFICHAGE\ndetail line");
			assert.strictEqual(completion.englishMessage, "HEADLINE\ndetail line");
		});

		test("an English headline yields a byte-identical message and mirror on every surface", () => {
			// Under the test host's English fallback the display headline IS the English headline, so the two products
			// must coincide byte for byte.
			const headline = { display: "same text", english: "same text" };
			for (const surface of TRANSPORT_ERROR_SURFACES) {
				const texts = twoPartTexts(surface, headline, "LiteLLM 500: boom");
				assert.strictEqual(texts.englishMessage, texts.message);
			}
		});

		test("an empty detail renders the headline alone on every surface", () => {
			const headline = { display: "affichage", english: "english" };
			for (const surface of TRANSPORT_ERROR_SURFACES) {
				const texts = twoPartTexts(surface, headline, "");
				assert.strictEqual(texts.message, "affichage");
				assert.strictEqual(texts.englishMessage, "english");
			}
		});
	});
});
