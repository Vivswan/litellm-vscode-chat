import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages } from "../../shared/messages";

suite("shared/multimodal", () => {
	test("tracks image count correctly", () => {
		const img1 = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png");
		const img2 = new vscode.LanguageModelDataPart(new Uint8Array([4, 5, 6]), "image/jpeg");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Look at these:"), img1, img2],
				name: undefined,
			},
		];
		const result = convertMessages(messages);
		assert.equal(result.multimodalContent.imageCount, 2);
		assert.equal(result.multimodalContent.pdfCount, 0);
	});

	test("tracks PDF count correctly", () => {
		const pdf1 = new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");
		const pdf2 = new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Analyze these PDFs:"), pdf1, pdf2],
				name: undefined,
			},
		];
		const result = convertMessages(messages);
		assert.equal(result.multimodalContent.imageCount, 0);
		assert.equal(result.multimodalContent.pdfCount, 2);
	});

	test("tracks mixed image and PDF content", () => {
		const img = new vscode.LanguageModelDataPart(new Uint8Array([0x89, 0x50]), "image/png");
		const pdf = new vscode.LanguageModelDataPart(new Uint8Array([0x25, 0x50]), "application/pdf");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Compare:"), img, pdf],
				name: undefined,
			},
		];
		const result = convertMessages(messages);
		assert.equal(result.multimodalContent.imageCount, 1);
		assert.equal(result.multimodalContent.pdfCount, 1);
	});

	test("counts across multiple messages", () => {
		const img1 = new vscode.LanguageModelDataPart(new Uint8Array([1]), "image/png");
		const img2 = new vscode.LanguageModelDataPart(new Uint8Array([2]), "image/jpeg");
		const pdf = new vscode.LanguageModelDataPart(new Uint8Array([3]), "application/pdf");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [img1],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("I see one image")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [img2, pdf],
				name: undefined,
			},
		];
		const result = convertMessages(messages);
		assert.equal(result.multimodalContent.imageCount, 2);
		assert.equal(result.multimodalContent.pdfCount, 1);
	});

	test("returns zero counts for text-only messages", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("Hello")],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelTextPart("Hi there")],
				name: undefined,
			},
		];
		const result = convertMessages(messages);
		assert.equal(result.multimodalContent.imageCount, 0);
		assert.equal(result.multimodalContent.pdfCount, 0);
	});

	test("supports all image MIME types", () => {
		const png = new vscode.LanguageModelDataPart(new Uint8Array([1]), "image/png");
		const jpeg = new vscode.LanguageModelDataPart(new Uint8Array([2]), "image/jpeg");
		const gif = new vscode.LanguageModelDataPart(new Uint8Array([3]), "image/gif");
		const webp = new vscode.LanguageModelDataPart(new Uint8Array([4]), "image/webp");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [png, jpeg, gif, webp],
				name: undefined,
			},
		];
		const result = convertMessages(messages);
		assert.equal(result.multimodalContent.imageCount, 4);
		const content = result.messages[0].content as Array<{ type: string }>;
		assert.equal(content.length, 4);
		assert.ok(content.every((block) => block.type === "image_url"));
	});

	test("case-insensitive MIME type detection", () => {
		const img1 = new vscode.LanguageModelDataPart(new Uint8Array([1]), "IMAGE/PNG");
		const img2 = new vscode.LanguageModelDataPart(new Uint8Array([2]), "Image/Jpeg");
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [img1, img2],
				name: undefined,
			},
		];
		const result = convertMessages(messages);
		assert.equal(result.multimodalContent.imageCount, 2);
	});
});
