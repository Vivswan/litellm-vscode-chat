import { describe, expect, test } from "bun:test";
import {
	MAX_TOOL_CALL_HEADER_LENGTH,
	type TextParseEvent,
	TextToolCallParser,
} from "../../../../provider/transport/textToolCallParser";

const BEGIN = "<|tool_call_begin|>";
const ARG_BEGIN = "<|tool_call_argument_begin|>";
const END = "<|tool_call_end|>";

function textOf(events: TextParseEvent[]): string {
	return events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");
}

function pieces(text: string, size: number): string[] {
	return text.match(new RegExp(`.{1,${size}}`, "gs")) ?? [];
}

describe("provider/transport textToolCallParser: a begin sigil that no header follows", () => {
	test("a lone begin sigil in prose releases the text behind it once no header can follow, instead of holding the rest of the reply", () => {
		// A model writing about the format. The parser used to buffer everything after the sigil waiting for a header
		// token, rescanning the growing buffer on every push, and flush handed it all back as truncated-token text.
		const parser = new TextToolCallParser();
		const prose = "The name comes next, then the arguments. ".repeat(Math.ceil(MAX_TOOL_CALL_HEADER_LENGTH / 20));

		let streamed = textOf(parser.push(`write ${BEGIN} before the name. `).events);
		for (const piece of pieces(prose, 13)) {
			streamed += textOf(parser.push(piece).events);
		}
		const rest = parser.flush();

		expect(streamed).toBe(`write  before the name. ${prose}`);
		expect(rest).toEqual({ events: [], provisionalCall: undefined });
	});

	test("a header split across pushes under the bound still opens its call", () => {
		// The control for the bound: a real header arriving in pieces is held, never released as prose.
		const parser = new TextToolCallParser();

		const events = [
			...parser.push(`${BEGIN}get_weat`).events,
			...parser.push(`her:3${ARG_BEGIN}{"city":"oslo"}`).events,
			...parser.push(`${END} done`).events,
		];

		expect(events).toEqual([
			{ type: "call", call: { seq: 1, name: "get_weather", index: 3, args: '{"city":"oslo"}' } },
			{ type: "text", text: " done" },
		]);
	});

	test.each([
		["at the bound", MAX_TOOL_CALL_HEADER_LENGTH, "call"],
		["one past the bound", MAX_TOOL_CALL_HEADER_LENGTH + 1, "text"],
	])("a header %s (%i characters) followed by a split argument token reads as a %s", (_label, length, outcome) => {
		// The bound is inclusive, and a partial argument-begin token at the end of a push is not header text.
		const parser = new TextToolCallParser();
		const name = "n".repeat(length);

		const events = [
			...parser.push(`${BEGIN}${name}${ARG_BEGIN.slice(0, 9)}`).events,
			...parser.push(`${ARG_BEGIN.slice(9)}{}${END}`).events,
		];

		if (outcome === "call") {
			expect(events).toEqual([{ type: "call", call: { seq: 1, name, index: undefined, args: "{}" } }]);
		} else {
			expect(textOf(events)).toBe(`${name}{}`);
			expect(events.some((event) => event.type === "call")).toBe(false);
		}
	});
});
