import * as assert from "node:assert";
import * as vscode from "vscode";
import { dataPartWireForm } from "../../../shared/conversion/dataPartForm";
import { CHARS_PER_TOKEN } from "../../../shared/conversion/textTokens";
import {
	AUDIO_TOKEN_ESTIMATE,
	estimateMessagesTokens,
	estimateToolTokens,
	IMAGE_TOKEN_ESTIMATE,
	PDF_TOKEN_ESTIMATE,
} from "../../../shared/conversion/tokenEstimation";

const fullMultimodal = { imageInput: true, audioInput: true };
const visionOnly = { imageInput: true, audioInput: false };
const audioOnly = { imageInput: false, audioInput: true };
const textOnly = { imageInput: false, audioInput: false };

/** Chars/4 of one transmitted text, the heuristic mode every host test runs under. */
const textTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * The synthesized image message's fixed lead-in (messages.ts). The estimate
 * prices the converted request, so this constant is priced with it; the
 * literal is restated here so a reworded lead-in shows up as a count change.
 */
const LEAD_IN_TOKENS = textTokens("Images returned by the tool calls above:");

function message(role: vscode.LanguageModelChatMessageRole, content: unknown[]): vscode.LanguageModelChatMessage {
	return { role, content, name: undefined } as vscode.LanguageModelChatMessage;
}

const userMessage = (...content: unknown[]) => message(vscode.LanguageModelChatMessageRole.User, content);
const assistantMessage = (...content: unknown[]) => message(vscode.LanguageModelChatMessageRole.Assistant, content);

suite("shared/conversion/dataPartForm", () => {
	test("user position follows the capability gates for images and audio, and audio carries its wire format", () => {
		assert.deepStrictEqual(dataPartWireForm("image/png", "user", fullMultimodal), { form: "image" });
		assert.deepStrictEqual(dataPartWireForm("image/png", "user", textOnly), { form: "none" });
		assert.deepStrictEqual(dataPartWireForm("audio/wav", "user", fullMultimodal), { form: "audio", format: "wav" });
		assert.deepStrictEqual(dataPartWireForm("audio/mpeg", "user", fullMultimodal), { form: "audio", format: "mp3" });
		assert.deepStrictEqual(dataPartWireForm("audio/mpeg", "user", visionOnly), { form: "none" });
	});

	test("PDF converts unconditionally and text decodes regardless of gates on user messages", () => {
		assert.deepStrictEqual(dataPartWireForm("application/pdf", "user", textOnly), { form: "pdf" });
		assert.deepStrictEqual(dataPartWireForm("application/pdf", "user", fullMultimodal), { form: "pdf" });
		assert.deepStrictEqual(dataPartWireForm("text/plain", "user", textOnly), { form: "text" });
		assert.deepStrictEqual(dataPartWireForm("application/json", "user", textOnly), { form: "text" });
	});

	test("payloads with no wire mapping are none whatever the gates say", () => {
		assert.deepStrictEqual(
			dataPartWireForm("audio/ogg", "user", fullMultimodal),
			{ form: "none" },
			"the wire takes only wav and mp3"
		);
		assert.deepStrictEqual(dataPartWireForm("video/mp4", "user", fullMultimodal), { form: "none" });
	});

	test("mime casing is normalized inside the seam", () => {
		assert.deepStrictEqual(dataPartWireForm("IMAGE/PNG", "user", fullMultimodal), { form: "image" });
		assert.deepStrictEqual(dataPartWireForm("Application/PDF", "user", textOnly), { form: "pdf" });
	});

	test("assistant position keeps only the text decode", () => {
		assert.deepStrictEqual(dataPartWireForm("image/png", "assistant", fullMultimodal), { form: "none" });
		assert.deepStrictEqual(dataPartWireForm("application/pdf", "assistant", fullMultimodal), { form: "none" });
		assert.deepStrictEqual(dataPartWireForm("audio/wav", "assistant", fullMultimodal), { form: "none" });
		assert.deepStrictEqual(dataPartWireForm("text/plain", "assistant", textOnly), { form: "text" });
	});

	test("tool-result position drops pdf and audio, gates images, and keeps text", () => {
		assert.deepStrictEqual(dataPartWireForm("application/pdf", "toolResult", fullMultimodal), { form: "none" });
		assert.deepStrictEqual(dataPartWireForm("audio/wav", "toolResult", fullMultimodal), { form: "none" });
		assert.deepStrictEqual(dataPartWireForm("image/png", "toolResult", fullMultimodal), { form: "image" });
		assert.deepStrictEqual(dataPartWireForm("image/png", "toolResult", textOnly), { form: "none" });
		assert.deepStrictEqual(dataPartWireForm("text/plain", "toolResult", textOnly), { form: "text" });
	});

	test("an image mime that is also text-decodable follows each position's conversion order", () => {
		// User messages try the image block first, so the vision gate decides;
		// with it off, conversion falls back to the text decode. Tool results
		// decode text first, so the mime is text there even for vision models.
		assert.deepStrictEqual(dataPartWireForm("image/foo+json", "user", fullMultimodal), { form: "image" });
		assert.deepStrictEqual(dataPartWireForm("image/foo+json", "user", textOnly), { form: "text" });
		assert.deepStrictEqual(dataPartWireForm("image/foo+json", "toolResult", fullMultimodal), { form: "text" });
	});
});

suite("shared/conversion/tokenEstimation", () => {
	test("text parts count characters divided by CHARS_PER_TOKEN under any gates", () => {
		const messages = [userMessage(new vscode.LanguageModelTextPart("hello world"))];
		assert.strictEqual(estimateMessagesTokens(messages, fullMultimodal), textTokens("hello world"));
		assert.strictEqual(estimateMessagesTokens(messages, textOnly), textTokens("hello world"));
	});

	test("image parts use the fixed estimate only when the model takes image input", () => {
		const messages = [
			userMessage(new vscode.LanguageModelDataPart(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png")),
		];
		assert.strictEqual(estimateMessagesTokens(messages, visionOnly), IMAGE_TOKEN_ESTIMATE);
		assert.strictEqual(estimateMessagesTokens(messages, audioOnly), 0, "the audio gate must not admit images");
		assert.strictEqual(estimateMessagesTokens(messages, textOnly), 0);
	});

	test("pdf parts use the fixed estimate unconditionally, matching conversion", () => {
		const messages = [
			userMessage(new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf")),
		];
		assert.strictEqual(estimateMessagesTokens(messages, fullMultimodal), PDF_TOKEN_ESTIMATE);
		assert.strictEqual(
			estimateMessagesTokens(messages, textOnly),
			PDF_TOKEN_ESTIMATE,
			"conversion sends the file block whatever the gates say, so the estimate must count it"
		);
	});

	test("audio parts use the fixed estimate only with audio input, over the wire's mime vocabulary", () => {
		for (const mime of ["audio/wav", "audio/mpeg"]) {
			const messages = [userMessage(new vscode.LanguageModelDataPart(new Uint8Array([0x52, 0x49, 0x46, 0x46]), mime))];
			assert.strictEqual(estimateMessagesTokens(messages, audioOnly), AUDIO_TOKEN_ESTIMATE, mime);
			assert.strictEqual(estimateMessagesTokens(messages, visionOnly), 0, mime);
		}
		const unmapped = [userMessage(new vscode.LanguageModelDataPart(new Uint8Array(4), "audio/ogg"))];
		assert.strictEqual(
			estimateMessagesTokens(unmapped, fullMultimodal),
			0,
			"audio the wire cannot carry never reaches the server and must not inflate the estimate"
		);
	});

	test("text-mime data parts price the decoded text conversion transmits, not their byte count", () => {
		// 12 Han characters: 36 UTF-8 bytes but a 12-character wire string. The
		// estimate prices the converted request, so the character figure is the
		// right one; the old bytes/4 walk priced 9 here.
		const decoded = "把这个函数重构成纯函数呀";
		const payload = new TextEncoder().encode(decoded);
		const messages = [userMessage(new vscode.LanguageModelDataPart(payload, "text/plain"))];
		assert.strictEqual(estimateMessagesTokens(messages, fullMultimodal), textTokens(decoded));
		assert.strictEqual(estimateMessagesTokens(messages, textOnly), textTokens(decoded));
	});

	test("tool call parts count name plus the exact arguments string the wire carries", () => {
		const messages = [assistantMessage(new vscode.LanguageModelToolCallPart("call-1", "toolA", { foo: 1 }))];
		const expected = textTokens(`toolA${JSON.stringify({ foo: 1 })}`);
		assert.strictEqual(estimateMessagesTokens(messages, textOnly), expected);
	});

	test("a tool-call input with no JSON rendering prices the {} fallback instead of throwing", () => {
		const throwing = {
			toJSON: (): never => {
				throw new Error("no rendering");
			},
		};
		const silent = { toJSON: (): undefined => undefined };
		for (const input of [throwing, silent]) {
			const messages = [assistantMessage(new vscode.LanguageModelToolCallPart("call-1", "toolA", input as object))];
			assert.strictEqual(
				estimateMessagesTokens(messages, textOnly),
				textTokens("toolA{}"),
				"conversion ships arguments {} for this input, so the estimate prices exactly that"
			);
		}
	});

	test("unknown parts count as zero", () => {
		assert.strictEqual(estimateMessagesTokens([userMessage({ some: "object" })], fullMultimodal), 0);
	});

	test("tool results price their flattened text plus the synthesized image message they trigger", () => {
		const text = "terminal output ".repeat(20);
		const part = new vscode.LanguageModelToolResultPart("call-1", [
			new vscode.LanguageModelTextPart(text),
			new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png"),
		]);
		// With vision, the image rides a synthesized user message whose fixed
		// lead-in ships too, so the estimate includes it.
		assert.strictEqual(
			estimateMessagesTokens([userMessage(part)], visionOnly),
			textTokens(text) + IMAGE_TOKEN_ESTIMATE + LEAD_IN_TOKENS
		);
		assert.strictEqual(
			estimateMessagesTokens([userMessage(part)], textOnly),
			textTokens(text),
			"the image gate applies inside too"
		);
	});

	test("consecutive tool-image turns share one synthesized message, and the estimate prices exactly that", () => {
		const image = (): vscode.LanguageModelDataPart => new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png");
		const messages = [
			userMessage(new vscode.LanguageModelToolResultPart("call-1", [image()])),
			userMessage(new vscode.LanguageModelToolResultPart("call-2", [image()])),
		];
		assert.strictEqual(
			estimateMessagesTokens(messages, visionOnly),
			2 * IMAGE_TOKEN_ESTIMATE + LEAD_IN_TOKENS,
			"one lead-in per flush, not per tool result"
		);
	});

	test("audio and PDF inside a tool result count zero: conversion never forwards them from that path", () => {
		const text = "recording saved";
		const part = new vscode.LanguageModelToolResultPart("call-1", [
			new vscode.LanguageModelTextPart(text),
			new vscode.LanguageModelDataPart(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "audio/wav"),
			new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf"),
		]);
		assert.strictEqual(
			estimateMessagesTokens([userMessage(part)], fullMultimodal),
			textTokens(text),
			"collectToolResultContent drops tool-result audio and PDF unconditionally, so they must not inflate the budget"
		);
	});

	test("bare strings and unknown objects in a tool result price the text conversion transmits", () => {
		const raw = "raw tool output ".repeat(8);
		const unknown = { status: "ok", rows: [1, 2, 3] };
		const content: unknown[] = [raw, unknown];
		const part = new vscode.LanguageModelToolResultPart("call-1", content as vscode.LanguageModelTextPart[]);
		assert.strictEqual(
			estimateMessagesTokens([userMessage(part)], fullMultimodal),
			textTokens(raw) + textTokens(JSON.stringify(unknown))
		);
	});

	test('an entry with no JSON rendering prices the "undefined" literal conversion transmits', () => {
		// JSON.stringify returns undefined for a bare function; conversion's
		// `text +=` coerces that to the literal "undefined" on the wire.
		const content: unknown[] = [() => {}];
		const part = new vscode.LanguageModelToolResultPart("call-1", content as vscode.LanguageModelTextPart[]);
		assert.strictEqual(estimateMessagesTokens([userMessage(part)], fullMultimodal), textTokens("undefined"));
	});

	test("prompt-tsx parts count what conversion transmits, object values included", () => {
		const objectValue = { node: { text: "rendered prompt fragment" } };
		const tsx = new vscode.LanguageModelPromptTsxPart(objectValue);
		const expected = textTokens(JSON.stringify(objectValue));
		assert.strictEqual(estimateMessagesTokens([userMessage(tsx)], fullMultimodal), expected);

		const inToolResult = new vscode.LanguageModelToolResultPart("call-1", [tsx]);
		assert.strictEqual(
			estimateMessagesTokens([userMessage(inToolResult)], fullMultimodal),
			expected,
			"and inside tool results"
		);

		const stringValue = new vscode.LanguageModelPromptTsxPart("plain text value");
		assert.strictEqual(
			estimateMessagesTokens([userMessage(stringValue)], fullMultimodal),
			textTokens("plain text value")
		);
	});

	test("prompt-tsx values with no JSON rendering price zero without throwing", () => {
		// JSON.stringify returns undefined for these; conversion transmits
		// nothing, so the estimate must not throw on the missing rendering.
		const fnValue = new vscode.LanguageModelPromptTsxPart(() => {});
		assert.strictEqual(estimateMessagesTokens([userMessage(fnValue)], fullMultimodal), 0);

		const toJsonUndefined = new vscode.LanguageModelPromptTsxPart({ toJSON: () => undefined });
		assert.strictEqual(estimateMessagesTokens([userMessage(toJsonUndefined)], fullMultimodal), 0);

		const inToolResult = new vscode.LanguageModelToolResultPart("call-1", [fnValue]);
		assert.strictEqual(
			estimateMessagesTokens([userMessage(inToolResult)], fullMultimodal),
			0,
			"and inside tool results"
		);
	});

	test("an empty or malformed tool result content still counts as zero without throwing", () => {
		assert.strictEqual(
			estimateMessagesTokens([userMessage(new vscode.LanguageModelToolResultPart("call-1", []))], fullMultimodal),
			0
		);
		const noContent = new vscode.LanguageModelToolResultPart("call-1", []);
		(noContent as unknown as { content: undefined }).content = undefined;
		assert.strictEqual(estimateMessagesTokens([userMessage(noContent)], fullMultimodal), 0);
	});

	test("thinking history prices exactly the replayed blocks: signed text and redacted payloads", () => {
		const signed = { value: "x".repeat(8), metadata: { type: "thinking", signature: "s".repeat(4) } };
		assert.strictEqual(estimateMessagesTokens([assistantMessage(signed)], fullMultimodal), textTokens("x".repeat(12)));

		const redacted = { value: "", metadata: { type: "redacted_thinking", data: "d".repeat(9) } };
		assert.strictEqual(estimateMessagesTokens([assistantMessage(redacted)], fullMultimodal), textTokens("d".repeat(9)));
	});

	test("thinking that never replays prices zero: unsigned text, and thinking outside assistant turns", () => {
		// A plain value-bearing object is not a thinking part (no replay
		// metadata, not the host's class); conversion drops it, so it counts 0.
		const plain = { value: "just thinking text" };
		assert.strictEqual(estimateMessagesTokens([assistantMessage(plain)], fullMultimodal), 0);
		// Conversion reads thinking out of assistant history only.
		const signed = { value: "x".repeat(8), metadata: { signature: "s".repeat(4) } };
		assert.strictEqual(estimateMessagesTokens([userMessage(signed)], fullMultimodal), 0);
	});

	test("a redacted payload prices even without a text value: it ships whatever the value field holds", () => {
		// The old part walk required a string value before pricing anything, so
		// a value-less redacted part undercounted to zero - the direction that
		// skips host trimming and overflows server-side.
		const redacted = { metadata: { type: "redacted_thinking", data: "d".repeat(40) } };
		assert.strictEqual(
			estimateMessagesTokens([assistantMessage(redacted)], fullMultimodal),
			textTokens("d".repeat(40))
		);
	});

	test("estimateMessagesTokens sums parts across messages", () => {
		const messages = [
			userMessage(
				new vscode.LanguageModelTextPart("describe"),
				new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png")
			),
		];
		assert.strictEqual(estimateMessagesTokens(messages, visionOnly), textTokens("describe") + IMAGE_TOKEN_ESTIMATE);
		assert.strictEqual(estimateMessagesTokens(messages, textOnly), textTokens("describe"));
	});

	test("assistant-history binary DataParts price as dropped; decoded text still counts", () => {
		const textPayload = new TextEncoder().encode("decoded assistant text");
		const messages = [
			assistantMessage(
				new vscode.LanguageModelTextPart("reply"),
				new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png"),
				new vscode.LanguageModelDataPart(new Uint8Array(4), "application/pdf"),
				new vscode.LanguageModelDataPart(new Uint8Array(4), "audio/wav"),
				new vscode.LanguageModelDataPart(textPayload, "text/plain")
			),
		];
		// The message's text parts join into one wire string, so the estimate
		// prices "reply" + the decoded payload as one text, not two ceils.
		const expected = textTokens("reply" + "decoded assistant text");
		assert.strictEqual(
			estimateMessagesTokens(messages, fullMultimodal),
			expected,
			"assistant turns have no wire shape for binary content, so it never ships and must price zero"
		);
	});

	test("system-role binary DataParts price as dropped too: only user messages carry binary blocks", () => {
		const textPayload = new TextEncoder().encode("system attachment text");
		// VS Code sends role 3 for system messages via a proposed API; the
		// stable enum only declares User and Assistant.
		const messages = [
			message(3 as vscode.LanguageModelChatMessageRole, [
				new vscode.LanguageModelTextPart("policy"),
				new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png"),
				new vscode.LanguageModelDataPart(new Uint8Array(4), "application/pdf"),
				new vscode.LanguageModelDataPart(new Uint8Array(4), "audio/wav"),
				new vscode.LanguageModelDataPart(textPayload, "text/plain"),
			]),
		];
		const expected = textTokens("policy" + "system attachment text");
		assert.strictEqual(
			estimateMessagesTokens(messages, fullMultimodal),
			expected,
			"conversion sends binary blocks only for user messages, so a system image, pdf, or audio clip never ships"
		);
	});

	test("estimateToolTokens counts serialized definitions and handles absence", () => {
		assert.strictEqual(estimateToolTokens(undefined), 0);
		assert.strictEqual(estimateToolTokens([]), 0);
		const tools = [{ type: "function" as const, function: { name: "toolA", description: "does a thing" } }];
		assert.strictEqual(estimateToolTokens(tools), textTokens(JSON.stringify(tools)));
	});
});
