import { describe, expect, test } from "bun:test";
import { type ToolCallSlot, ToolCallSlots } from "../../../../../provider/transport/streaming/toolCallSlots";
import type { StreamedToolCall, ToolCallBuffer } from "../../../../../provider/transport/wire";

function start(id: string | undefined, name: string, args: string, index?: number | string): StreamedToolCall {
	return {
		...(index === undefined ? {} : { index }),
		...(id === undefined ? {} : { id }),
		function: { name, arguments: args },
	};
}

function more(id: string | undefined, args: string, index?: number | string): StreamedToolCall {
	return {
		...(index === undefined ? {} : { index }),
		...(id === undefined ? {} : { id }),
		function: { arguments: args },
	};
}

interface SlotCase {
	shape: string;
	deltas: StreamedToolCall[];
	slots: Array<ToolCallSlot | undefined>;
	buffers: Array<[ToolCallSlot, ToolCallBuffer]>;
}

describe("provider/transport/streaming ToolCallSlots", () => {
	test.each<SlotCase>([
		{
			shape: "indexed deltas keep their wire index, numeric string included",
			deltas: [start("call_a", "alpha", '{"n":', 0), more(undefined, "1}", "0"), start("call_b", "bravo", "{}", 1)],
			slots: [0, 0, 1],
			buffers: [
				[0, { id: "call_a", name: "alpha", args: '{"n":1}' }],
				[1, { id: "call_b", name: "bravo", args: "{}" }],
			],
		},
		{
			// Keyed to index 0 together, two parallel index-less calls shared one buffer and only the first emitted.
			shape: "index-less deltas with distinct ids each own a slot",
			deltas: [
				start("call_a", "alpha", '{"n":'),
				start("call_b", "bravo", '{"n":'),
				more("call_a", "1}"),
				more("call_b", "2}"),
			],
			slots: ["call_a", "call_b", "call_a", "call_b"],
			buffers: [
				["call_a", { id: "call_a", name: "alpha", args: '{"n":1}' }],
				["call_b", { id: "call_b", name: "bravo", args: '{"n":2}' }],
			],
		},
		{
			shape: "a delta with neither index nor id continues the call the last id opened",
			deltas: [start("call_a", "alpha", '{"n":'), more(undefined, "1}")],
			slots: ["call_a", "call_a"],
			buffers: [["call_a", { id: "call_a", name: "alpha", args: '{"n":1}' }]],
		},
	])("$shape", ({ deltas, slots, buffers }) => {
		const subject = new ToolCallSlots();

		const accepted = deltas.map((delta) => subject.accept(delta));

		expect(accepted).toEqual(slots);
		expect([...subject.entries()]).toEqual(buffers);
	});

	test("a refused trailing frame for an emitted call does not redirect the bare continuations of the call in flight", () => {
		// Some servers close every call with an empty-arguments frame. One for call_a after call_a emitted is refused,
		// and the refusal must leave call_b the call in flight, or call_b's bare "2}" would be refused with it.
		const subject = new ToolCallSlots();
		subject.accept(start("call_a", "alpha", "{}"));
		subject.retire("call_a");
		subject.accept(start("call_b", "bravo", '{"n":'));

		expect(subject.accept(more("call_a", ""))).toBeUndefined();
		expect(subject.accept(more(undefined, "2}"))).toBe("call_b");
		expect([...subject.entries()]).toEqual([["call_b", { id: "call_b", name: "bravo", args: '{"n":2}' }]]);
	});
});
