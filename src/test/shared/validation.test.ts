import * as assert from "node:assert";
import * as vscode from "vscode";
import { validateRequest } from "../../shared/validation";

suite("shared/validation", () => {
	test("validateRequest enforces tool result pairing", () => {
		const callId = "xyz";
		const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
		const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
		const valid: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
		];
		assert.doesNotThrow(() => validateRequest(valid));

		const invalid: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("missing")],
				name: undefined,
			},
		];
		assert.throws(() => validateRequest(invalid));
	});

	test("validateRequest rejects an empty message list with the mirrored nothing-to-send message", () => {
		assert.throws(
			() => validateRequest([]),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /contained no messages/);
				// Chat-surface shape: the "Details:" lead-in separates headline and
				// detail (Copilot Chat's error block flattens newlines).
				assert.ok(e.message.includes("\n\nDetails: "), e.message);
				// English host: the mirror coincides with the display; a bare
				// localized message from shared/validation.ts would land translated
				// text in the output channel.
				assert.strictEqual((e as Error & { englishMessage?: string }).englishMessage, e.message);
				return true;
			}
		);
	});

	test("tool results may be consumed across consecutive user messages", () => {
		const callA = new vscode.LanguageModelToolCallPart("call-a", "toolA", {});
		const callB = new vscode.LanguageModelToolCallPart("call-b", "toolB", {});
		const resultA = new vscode.LanguageModelToolResultPart("call-a", [new vscode.LanguageModelTextPart("a")]);
		const resultB = new vscode.LanguageModelToolResultPart("call-b", [new vscode.LanguageModelTextPart("b")]);
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [callA, callB], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [resultA], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [resultB], name: undefined },
		];
		assert.doesNotThrow(() => validateRequest(messages));
	});

	test("an empty user content array does not satisfy pending tool calls", () => {
		const toolCall = new vscode.LanguageModelToolCallPart("call-1", "toolA", {});
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [], name: undefined },
		];
		assert.throws(
			() => validateRequest(messages),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /Unpaired tool call IDs: call-1\./);
				assert.ok(e.message.includes("\n\nDetails: "), e.message);
				assert.strictEqual((e as Error & { englishMessage?: string }).englishMessage, e.message);
				// The call IDs are earlier model output (response-derived), so the
				// public log surfaces get a count-only classification instead.
				assert.strictEqual(
					(e as Error & { logClassification?: string }).logClassification,
					"ValidationError(unpaired tool calls: 1)"
				);
				return true;
			}
		);
	});

	test("a non-result part interleaved with pending tool results is rejected naming the offending part", () => {
		const toolCall = new vscode.LanguageModelToolCallPart("call-1", "toolA", {});
		const result = new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("ok")]);
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [result, new vscode.LanguageModelTextPart("extra")],
				name: undefined,
			},
		];
		assert.throws(
			() => validateRequest(messages),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				// The detail embeds the part's constructor name, which is minified
				// in the packaged VS Code API, so only the shape is pinned.
				assert.match(e.message, /Expected a tool result after a tool call, got \S+\./);
				assert.ok(e.message.includes("\n\nDetails: "), e.message);
				// The constructor name is caller-controlled text, so the
				// classification stays a fixed string without it.
				assert.strictEqual(
					(e as Error & { logClassification?: string }).logClassification,
					"ValidationError(non-tool-result part after tool call)"
				);
				return true;
			}
		);
	});

	test("an empty-id call with an empty-id result passes: the pair is minted, not rejected", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [new vscode.LanguageModelToolCallPart("", "toolA", {})],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolResultPart("", [new vscode.LanguageModelTextPart("ok")])],
				name: undefined,
			},
		];
		assert.doesNotThrow(() => validateRequest(messages));
	});

	test("two empty-id calls with one empty-id result no longer collapse into a passing pair", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [
					new vscode.LanguageModelToolCallPart("", "toolA", {}),
					new vscode.LanguageModelToolCallPart("", "toolB", {}),
				],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolResultPart("", [new vscode.LanguageModelTextPart("ok")])],
				name: undefined,
			},
		];
		assert.throws(
			() => validateRequest(messages),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				// The unanswered half surfaces under its minted wire id, never "".
				assert.match(e.message, /Unpaired tool call IDs: call_synth_1\./);
				assert.strictEqual(
					(e as Error & { logClassification?: string }).logClassification,
					"ValidationError(unpaired tool calls: 1)"
				);
				return true;
			}
		);
	});

	test("a tool result answering no tool call is rejected instead of shipping an unreferenced tool message", () => {
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolResultPart("call-9", [new vscode.LanguageModelTextPart("orphan")])],
				name: undefined,
			},
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("hi")],
				name: undefined,
			},
		];
		assert.throws(
			() => validateRequest(messages),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /Tool results with no matching tool call: call-9\./);
				assert.ok(e.message.includes("\n\nDetails: "), e.message);
				assert.strictEqual((e as Error & { englishMessage?: string }).englishMessage, e.message);
				// The ids are response-derived, so the classification carries counts only.
				assert.strictEqual(
					(e as Error & { logClassification?: string }).logClassification,
					"ValidationError(tool pairing: 0 unpaired, 1 stray, 0 duplicate)"
				);
				return true;
			}
		);
	});

	test("a second result for an already-answered call is rejected as stray", () => {
		const call = new vscode.LanguageModelToolCallPart("call-1", "toolA", {});
		const result = (): vscode.LanguageModelToolResultPart =>
			new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("ok")]);
		const messages: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [call], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [result()], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [result()], name: undefined },
		];
		assert.throws(
			() => validateRequest(messages),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /Tool results with no matching tool call: call-1\./);
				return true;
			}
		);
	});

	test("a call id reused while still awaiting its result is rejected; reuse after the answer is fine", () => {
		const call = (): vscode.LanguageModelToolCallPart => new vscode.LanguageModelToolCallPart("call-1", "toolA", {});
		const result = (): vscode.LanguageModelToolResultPart =>
			new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("ok")]);
		// Some backends mint the same id every turn; consumed-then-reused stays legal.
		const reuseAcrossTurns: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [call()], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [result()], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [call()], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [result()], name: undefined },
		];
		assert.doesNotThrow(() => validateRequest(reuseAcrossTurns));

		const duplicateLive: vscode.LanguageModelChatMessage[] = [
			{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [call(), call()], name: undefined },
			{ role: vscode.LanguageModelChatMessageRole.User, content: [result(), result()], name: undefined },
		];
		assert.throws(
			() => validateRequest(duplicateLive),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /Tool call IDs reused while still awaiting a result: call-1\./);
				return true;
			}
		);
	});

	test("a tool call outside an assistant message still needs its result", () => {
		// Conversion ships tool-call parts wherever they sit, so an unanswered
		// call in a user message would reach the wire unreferenced.
		const messages: vscode.LanguageModelChatMessage[] = [
			{
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelToolCallPart("call-7", "toolA", {})],
				name: undefined,
			},
		];
		assert.throws(
			() => validateRequest(messages),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /Unpaired tool call IDs: call-7\./);
				assert.strictEqual(
					(e as Error & { logClassification?: string }).logClassification,
					"ValidationError(tool pairing: 1 unpaired, 0 stray, 0 duplicate)"
				);
				return true;
			}
		);
	});
});
