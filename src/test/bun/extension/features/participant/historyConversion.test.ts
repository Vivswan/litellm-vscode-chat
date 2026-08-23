import { describe, expect, test } from "bun:test";
import type * as vscode from "vscode";
import {
	type ChatMessage,
	HISTORY_CHAR_LIMIT,
	type HistoryRequestTurn,
	type HistoryResponseTurn,
	type HistoryTurn,
	historyMessages,
	normalizeForWire,
	requestContent,
} from "../../../../../extension/features/participant/historyConversion";

/** A response part shaped like vscode.ChatResponseMarkdownPart: the value is a MarkdownString. */
function markdownPart(text: string): unknown {
	return { value: { value: text } };
}

/** A response part shaped like a tool invocation: named, but carrying no text value. */
function toolPart(toolName: string): unknown {
	return { toolName, toolCallId: `call-${toolName}` };
}

describe("extension/features/participant historyMessages", () => {
	test("a request turn becomes a user message with the prompt verbatim", () => {
		const request: HistoryRequestTurn = { prompt: "  explain the retry rules  " };
		expect(historyMessages([request])).toEqual([{ role: "user", content: "  explain the retry rules  " }]);
	});

	test("a request turn's slash command rides along in its typed form", () => {
		expect(historyMessages([{ prompt: "the parser", command: "tests" }])).toEqual([
			{ role: "user", content: "/tests the parser" },
		]);
		expect(historyMessages([{ prompt: "", command: "models" }])).toEqual([{ role: "user", content: "/models" }]);
		expect(historyMessages([{ prompt: "   ", command: "models" }])).toEqual([{ role: "user", content: "/models" }]);
	});

	test("an empty command string is treated as no command", () => {
		expect(historyMessages([{ prompt: "plain question", command: "" }])).toEqual([
			{ role: "user", content: "plain question" },
		]);
	});

	test("a whitespace-only request turn without a command is dropped", () => {
		expect(historyMessages([{ prompt: "   \n\t" }])).toEqual([]);
	});

	test("a response turn's markdown fragments concatenate back into the text the user saw", () => {
		const response: HistoryResponseTurn = { response: [markdownPart("The retry "), markdownPart("rules are:")] };
		expect(historyMessages([response])).toEqual([{ role: "assistant", content: "The retry rules are:" }]);
	});

	test("a plain-string part value is progress chatter, not response text, and contributes nothing", () => {
		expect(historyMessages([{ response: [{ value: "Searching workspace..." }, markdownPart("kept")] }])).toEqual([
			{ role: "assistant", content: "kept" },
		]);
	});

	test("a tool-only response turn is dropped rather than sent as an empty message", () => {
		expect(historyMessages([{ response: [toolPart("search"), toolPart("read")] }])).toEqual([]);
	});

	test("a mixed response turn keeps the markdown and skips the tool parts", () => {
		const messages = historyMessages([
			{ response: [toolPart("search"), markdownPart("Found it: "), toolPart("read"), markdownPart("line 42.")] },
		]);
		expect(messages).toEqual([{ role: "assistant", content: "Found it: line 42." }]);
	});

	test("parts with no usable shape contribute nothing", () => {
		const messages = historyMessages([
			{ response: [null, 7, "bare string", { value: 3 }, { value: { value: 9 } }, markdownPart("kept")] },
		]);
		expect(messages).toEqual([{ role: "assistant", content: "kept" }]);
	});

	test("the mirrors accept the host's real history type at compile time", () => {
		// Type-only pin: vscode.ChatContext["history"] must stay assignable to the
		// structural mirrors, so a host shape change fails typecheck, not runtime.
		const accepts = (history: vscode.ChatContext["history"]): readonly HistoryTurn[] => history;
		expect(accepts([])).toEqual([]);
	});

	test("over the char limit, whole oldest messages fall off; wire shape is normalizeForWire's job", () => {
		const big = "x".repeat(HISTORY_CHAR_LIMIT);
		const turns: HistoryTurn[] = [
			{ prompt: "q1" },
			{ response: [markdownPart(big)] },
			{ prompt: "q2" },
			{ response: [markdownPart("a2")] },
			{ prompt: "q3" },
		];
		expect(historyMessages(turns)).toEqual([
			{ role: "user", content: "q2" },
			{ role: "assistant", content: "a2" },
			{ role: "user", content: "q3" },
		]);
	});

	test("a history whose every message is over budget drops to nothing", () => {
		const huge = "y".repeat(HISTORY_CHAR_LIMIT + 100);
		expect(historyMessages([{ prompt: huge }])).toEqual([]);
		expect(historyMessages([{ prompt: "q" }, { response: [markdownPart(huge)] }, { prompt: huge }])).toEqual([]);
	});

	test("turn order is preserved across a whole conversation", () => {
		const turns: HistoryTurn[] = [
			{ prompt: "first question" },
			{ response: [markdownPart("first answer")] },
			{ prompt: "follow-up", command: "docs" },
			{ response: [markdownPart("second answer")] },
		];
		const expected: ChatMessage[] = [
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "/docs follow-up" },
			{ role: "assistant", content: "second answer" },
		];
		expect(historyMessages(turns)).toEqual(expected);
	});

	test("empty history converts to an empty message array", () => {
		expect(historyMessages([])).toEqual([]);
	});
});

describe("extension/features/participant requestContent", () => {
	test("renders the typed command form for every prompt/command combination", () => {
		expect(requestContent({ prompt: "text" })).toBe("text");
		expect(requestContent({ prompt: "text", command: "tests" })).toBe("/tests text");
		expect(requestContent({ prompt: "", command: "models" })).toBe("/models");
		expect(requestContent({ prompt: "text", command: "" })).toBe("text");
	});
});

describe("extension/features/participant normalizeForWire", () => {
	test("merges a same-role run into one message, joined by a blank line", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "first question" },
			{ role: "user", content: "asked again after a cancel" },
			{ role: "assistant", content: "answer" },
		];
		expect(normalizeForWire(messages)).toEqual([
			{ role: "user", content: "first question\n\nasked again after a cancel" },
			{ role: "assistant", content: "answer" },
		]);
	});

	test("drops answers leading without any question before them", () => {
		const messages: ChatMessage[] = [
			{ role: "assistant", content: "a listing the user never asked a question for" },
			{ role: "user", content: "real question" },
		];
		expect(normalizeForWire(messages)).toEqual([{ role: "user", content: "real question" }]);
		expect(normalizeForWire([{ role: "assistant", content: "alone" }])).toEqual([]);
	});

	test("leaves an already-alternating conversation untouched", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "q" },
			{ role: "assistant", content: "a" },
			{ role: "user", content: "q2" },
		];
		expect(normalizeForWire(messages)).toEqual(messages);
		expect(normalizeForWire([])).toEqual([]);
	});
});
