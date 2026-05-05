import * as assert from "assert";
import * as vscode from "vscode";
import { StreamProcessor } from "../../provider/streaming";

suite("provider/streaming", () => {
	test("processDelta emits text content from string delta", async () => {
		const stream = new StreamProcessor(0, () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		const emitted = await stream.processDelta({ choices: [{ delta: { content: "Hello world" } }] }, progress);

		assert.ok(emitted, "Should report emitted = true");
		assert.ok(parts.length > 0, "Should emit at least one part");
		const textPart = parts.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
		assert.ok(textPart, "Should emit a text part");
		assert.ok(textPart.value.includes("Hello world"), "Text should contain the content");
	});

	test("processDelta handles tool calls in delta", async () => {
		const stream = new StreamProcessor(0, () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		await stream.processDelta(
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: "call_123", function: { name: "test_tool", arguments: '{"key":"value"}' } }],
						},
					},
				],
			},
			progress
		);

		assert.ok(parts.length > 0, "Should emit tool call part");
		const toolPart = parts.find(
			(p) => p instanceof vscode.LanguageModelToolCallPart
		) as vscode.LanguageModelToolCallPart;
		assert.ok(toolPart, "Should emit a LanguageModelToolCallPart");
		assert.equal(toolPart.name, "test_tool");
	});

	test("processDelta logs token usage", async () => {
		const logs: string[] = [];
		const stream = new StreamProcessor(0, (msg, data) => {
			logs.push(data !== undefined ? `${msg}: ${JSON.stringify(data)}` : msg);
		});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		await stream.processDelta(
			{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
			progress
		);

		assert.ok(
			logs.some((l) => l.includes("Token usage")),
			"Should log token usage"
		);
	});

	test("processTextContent strips control tokens", async () => {
		const stream = new StreamProcessor(0, () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		const result = stream.processTextContent(
			"Hello <|tool_calls_section_begin|>world<|tool_calls_section_end|>",
			progress
		);

		assert.ok(result.emittedText, "Should emit text");
		const textPart = parts.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart;
		assert.ok(textPart, "Should emit a text part");
		assert.ok(!textPart.value.includes("<|"), "Should not contain control tokens");
		assert.ok(textPart.value.includes("Hello"), "Should preserve visible text");
		assert.ok(textPart.value.includes("world"), "Should preserve visible text");
	});

	test("processTextContent parses inline tool calls", async () => {
		const stream = new StreamProcessor(0, () => {});
		const parts: vscode.LanguageModelResponsePart[] = [];
		const progress = { report: (p: vscode.LanguageModelResponsePart) => parts.push(p) };

		stream.processTextContent(
			'<|tool_call_begin|>my_tool<|tool_call_argument_begin|>{"arg":"val"}<|tool_call_end|>',
			progress
		);

		const toolPart = parts.find(
			(p) => p instanceof vscode.LanguageModelToolCallPart
		) as vscode.LanguageModelToolCallPart;
		assert.ok(toolPart, "Should emit a tool call from inline control tokens");
		assert.equal(toolPart.name, "my_tool");
	});
});
