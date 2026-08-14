import * as assert from "node:assert";
import * as vscode from "vscode";
import { dataPartWireForm } from "../../../shared/conversion/dataPartForm";
import { CHARS_PER_TOKEN } from "../../../shared/conversion/textTokens";
import {
	AUDIO_TOKEN_ESTIMATE,
	estimateMessagesTokens,
	estimatePartTokens,
	estimateToolTokens,
	IMAGE_TOKEN_ESTIMATE,
	PDF_TOKEN_ESTIMATE,
} from "../../../shared/conversion/tokenEstimation";

const fullMultimodal = { imageInput: true, audioInput: true };
const visionOnly = { imageInput: true, audioInput: false };
const audioOnly = { imageInput: false, audioInput: true };
const textOnly = { imageInput: false, audioInput: false };

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
		const part = new vscode.LanguageModelTextPart("hello world");
		const expected = Math.ceil("hello world".length / CHARS_PER_TOKEN);
		assert.strictEqual(estimatePartTokens(part, fullMultimodal), expected);
		assert.strictEqual(estimatePartTokens(part, textOnly), expected);
	});

	test("image parts use the fixed estimate only when the model takes image input", () => {
		const part = new vscode.LanguageModelDataPart(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
		assert.strictEqual(estimatePartTokens(part, visionOnly), IMAGE_TOKEN_ESTIMATE);
		assert.strictEqual(estimatePartTokens(part, audioOnly), 0, "the audio gate must not admit images");
		assert.strictEqual(estimatePartTokens(part, textOnly), 0);
	});

	test("pdf parts use the fixed estimate unconditionally, matching conversion", () => {
		const part = new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");
		assert.strictEqual(estimatePartTokens(part, fullMultimodal), PDF_TOKEN_ESTIMATE);
		assert.strictEqual(
			estimatePartTokens(part, textOnly),
			PDF_TOKEN_ESTIMATE,
			"conversion sends the file block whatever the gates say, so the estimate must count it"
		);
	});

	test("audio parts use the fixed estimate only with audio input, over the wire's mime vocabulary", () => {
		for (const mime of ["audio/wav", "audio/mpeg"]) {
			const part = new vscode.LanguageModelDataPart(new Uint8Array([0x52, 0x49, 0x46, 0x46]), mime);
			assert.strictEqual(estimatePartTokens(part, audioOnly), AUDIO_TOKEN_ESTIMATE, mime);
			assert.strictEqual(estimatePartTokens(part, visionOnly), 0, mime);
		}
		const unmapped = new vscode.LanguageModelDataPart(new Uint8Array(4), "audio/ogg");
		assert.strictEqual(
			estimatePartTokens(unmapped, fullMultimodal),
			0,
			"audio the wire cannot carry never reaches the server and must not inflate the estimate"
		);
	});

	test("JSON data parts count byte length divided by CHARS_PER_TOKEN under any gates", () => {
		const payload = new TextEncoder().encode(JSON.stringify({ answer: 42 }));
		const part = new vscode.LanguageModelDataPart(payload, "application/json");
		const expected = Math.ceil(payload.length / CHARS_PER_TOKEN);
		assert.strictEqual(estimatePartTokens(part, fullMultimodal), expected);
		assert.strictEqual(estimatePartTokens(part, textOnly), expected);
	});

	test("tool call parts count name plus serialized input", () => {
		const part = new vscode.LanguageModelToolCallPart("call-1", "toolA", { foo: 1 });
		const expected = Math.ceil(("toolA".length + JSON.stringify({ foo: 1 }).length) / CHARS_PER_TOKEN);
		assert.strictEqual(estimatePartTokens(part, textOnly), expected);
	});

	test("unknown parts count as zero", () => {
		assert.strictEqual(estimatePartTokens({ some: "object" }, fullMultimodal), 0);
	});

	test("tool result parts recurse over their content with the same per-part estimates", () => {
		const text = "terminal output ".repeat(20);
		const part = new vscode.LanguageModelToolResultPart("call-1", [
			new vscode.LanguageModelTextPart(text),
			new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png"),
		]);
		const textTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
		assert.strictEqual(estimatePartTokens(part, visionOnly), textTokens + IMAGE_TOKEN_ESTIMATE);
		assert.strictEqual(estimatePartTokens(part, textOnly), textTokens, "the image gate applies inside too");
	});

	test("audio and PDF inside a tool result count zero: conversion never forwards them from that path", () => {
		const text = "recording saved";
		const part = new vscode.LanguageModelToolResultPart("call-1", [
			new vscode.LanguageModelTextPart(text),
			new vscode.LanguageModelDataPart(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "audio/wav"),
			new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf"),
		]);
		const textTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
		assert.strictEqual(
			estimatePartTokens(part, fullMultimodal),
			textTokens,
			"collectToolResultContent drops tool-result audio and PDF unconditionally, so they must not inflate the budget"
		);
	});

	test("bare strings and unknown objects in a tool result price the text conversion transmits", () => {
		// collectToolResultContent appends a bare string verbatim and
		// JSON-stringifies entries no other branch recognizes; both ship as
		// tool-result text, so both price by the chars/4 rule instead of zero.
		const raw = "raw tool output ".repeat(8);
		const unknown = { status: "ok", rows: [1, 2, 3] };
		const content: unknown[] = [raw, unknown];
		const part = new vscode.LanguageModelToolResultPart("call-1", content as vscode.LanguageModelTextPart[]);
		assert.strictEqual(
			estimatePartTokens(part, fullMultimodal),
			Math.ceil(raw.length / CHARS_PER_TOKEN) + Math.ceil(JSON.stringify(unknown).length / CHARS_PER_TOKEN)
		);
	});

	test('an entry with no JSON rendering prices the "undefined" literal conversion transmits', () => {
		// JSON.stringify returns undefined for a bare function; conversion's
		// `text +=` coerces that to the literal "undefined" on the wire.
		const content: unknown[] = [() => {}];
		const part = new vscode.LanguageModelToolResultPart("call-1", content as vscode.LanguageModelTextPart[]);
		assert.strictEqual(estimatePartTokens(part, fullMultimodal), Math.ceil("undefined".length / CHARS_PER_TOKEN));
	});

	test("prompt-tsx parts count what conversion transmits, object values included", () => {
		const objectValue = { node: { text: "rendered prompt fragment" } };
		const tsx = new vscode.LanguageModelPromptTsxPart(objectValue);
		const expected = Math.ceil(JSON.stringify(objectValue).length / CHARS_PER_TOKEN);
		assert.strictEqual(estimatePartTokens(tsx, fullMultimodal), expected);

		const inToolResult = new vscode.LanguageModelToolResultPart("call-1", [tsx]);
		assert.strictEqual(estimatePartTokens(inToolResult, fullMultimodal), expected, "and inside tool results");

		const stringValue = new vscode.LanguageModelPromptTsxPart("plain text value");
		assert.strictEqual(
			estimatePartTokens(stringValue, fullMultimodal),
			Math.ceil("plain text value".length / CHARS_PER_TOKEN)
		);
	});

	test("prompt-tsx values with no JSON rendering price zero without throwing", () => {
		// JSON.stringify returns undefined for these; conversion transmits
		// nothing, so the estimate must not throw on the missing rendering.
		const fnValue = new vscode.LanguageModelPromptTsxPart(() => {});
		assert.strictEqual(estimatePartTokens(fnValue, fullMultimodal), 0);

		const toJsonUndefined = new vscode.LanguageModelPromptTsxPart({ toJSON: () => undefined });
		assert.strictEqual(estimatePartTokens(toJsonUndefined, fullMultimodal), 0);

		const inToolResult = new vscode.LanguageModelToolResultPart("call-1", [fnValue]);
		assert.strictEqual(estimatePartTokens(inToolResult, fullMultimodal), 0, "and inside tool results");
	});

	test("an empty or malformed tool result content still counts as zero without throwing", () => {
		assert.strictEqual(estimatePartTokens(new vscode.LanguageModelToolResultPart("call-1", []), fullMultimodal), 0);
		const noContent = new vscode.LanguageModelToolResultPart("call-1", []);
		(noContent as unknown as { content: undefined }).content = undefined;
		assert.strictEqual(estimatePartTokens(noContent, fullMultimodal), 0);
	});

	test("thinking parts count their text plus replayed signature and redacted data", () => {
		const signed = { value: "x".repeat(8), metadata: { type: "thinking", signature: "s".repeat(4) } };
		assert.strictEqual(estimatePartTokens(signed, fullMultimodal), Math.ceil(12 / CHARS_PER_TOKEN));

		const redacted = { value: "", metadata: { type: "redacted_thinking", data: "d".repeat(9) } };
		assert.strictEqual(estimatePartTokens(redacted, fullMultimodal), Math.ceil(9 / CHARS_PER_TOKEN));

		const plain = { value: "just thinking text" };
		assert.strictEqual(
			estimatePartTokens(plain, fullMultimodal),
			Math.ceil("just thinking text".length / CHARS_PER_TOKEN)
		);
	});

	test("estimateMessagesTokens sums parts across messages", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [
					new vscode.LanguageModelTextPart("describe"),
					new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png"),
				],
				name: undefined,
			},
		];
		const textTokens = Math.ceil("describe".length / CHARS_PER_TOKEN);
		assert.strictEqual(estimateMessagesTokens(messages, visionOnly), textTokens + IMAGE_TOKEN_ESTIMATE);
		assert.strictEqual(estimateMessagesTokens(messages, textOnly), textTokens);
	});

	test("assistant-history binary DataParts price as dropped; decoded text still counts", () => {
		const textPayload = new TextEncoder().encode("decoded assistant text");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [
					new vscode.LanguageModelTextPart("reply"),
					new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png"),
					new vscode.LanguageModelDataPart(new Uint8Array(4), "application/pdf"),
					new vscode.LanguageModelDataPart(new Uint8Array(4), "audio/wav"),
					new vscode.LanguageModelDataPart(textPayload, "text/plain"),
				],
				name: undefined,
			},
		];
		const expected = Math.ceil("reply".length / CHARS_PER_TOKEN) + Math.ceil(textPayload.length / CHARS_PER_TOKEN);
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
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: 3 as vscode.LanguageModelChatMessageRole,
				content: [
					new vscode.LanguageModelTextPart("policy"),
					new vscode.LanguageModelDataPart(new Uint8Array(4), "image/png"),
					new vscode.LanguageModelDataPart(new Uint8Array(4), "application/pdf"),
					new vscode.LanguageModelDataPart(new Uint8Array(4), "audio/wav"),
					new vscode.LanguageModelDataPart(textPayload, "text/plain"),
				],
				name: undefined,
			},
		];
		const expected = Math.ceil("policy".length / CHARS_PER_TOKEN) + Math.ceil(textPayload.length / CHARS_PER_TOKEN);
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
		assert.strictEqual(estimateToolTokens(tools), Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN));
	});
});
