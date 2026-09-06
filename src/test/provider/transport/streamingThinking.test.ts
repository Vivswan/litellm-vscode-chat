/**
 * StreamProcessor's thinking channel: reasoning deltas as thinking parts and the
 * pass-through of already-shaped thinking parts.
 */
import * as assert from "node:assert";
import type * as vscode from "vscode";
import { StreamProcessor } from "../../../provider/transport/streaming";
import type { ThinkingPartCtor } from "../../../shared/conversion/thinkingPart";
import { resetThinkingPartLogOnce } from "../../../shared/conversion/thinkingPart";
import { expectDefined } from "../../pureHelpers";
import { collector, idSource, visibleTextOf } from "./streamingHelpers";

suite("provider/streaming thinking parts", () => {
	class FakeThinkingPart {
		constructor(
			public text: string,
			public id?: string,
			public metadata?: unknown
		) {}
	}
	const fakeCtor = FakeThinkingPart as unknown as ThinkingPartCtor;

	test("structured thinking object emits a thinking part", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { thinking: { text: "deep", id: "t1" } } }] }, progress);

		assert.equal(parts.length, 1);
		const part = parts[0] as unknown as FakeThinkingPart;
		assert.ok(part instanceof FakeThinkingPart);
		assert.equal(part.text, "deep");
		assert.equal(part.id, "t1");
	});

	test("reasoning_content string emits a thinking part", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "steps" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "steps");
	});

	test("reasoning string emits a thinking part", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning: "why" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "why");
	});

	test("a throwing thinking constructor is logged and text in the same delta still emits", async () => {
		const logs: string[] = [];
		const throwingCtor = class {
			constructor() {
				throw new Error("boom");
			}
		} as unknown as ThinkingPartCtor;
		const stream = new StreamProcessor(idSource(), (msg) => logs.push(msg), throwingCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { thinking: "x", content: "visible" } }] }, progress);

		assert.ok(
			logs.some((l) => l.includes("Failed to construct thinking part")),
			"Constructor failure must be logged"
		);
		assert.equal(visibleTextOf(parts), "visible");
	});

	test("no thinking part is emitted when the constructor is unavailable", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, null);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "hidden" } }] }, progress);

		assert.equal(parts.length, 0);
	});

	test("thinking_blocks emit one part per block and suppress the duplicate reasoning_content", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{
				choices: [
					{
						delta: {
							reasoning_content: "step one",
							thinking_blocks: [{ type: "thinking", thinking: "step one", signature: "sig-1" }],
						},
					},
				],
			},
			progress
		);

		assert.equal(parts.length, 1, "The block and reasoning_content carry the same text; only the block may emit");
		const part = parts[0] as unknown as FakeThinkingPart;
		assert.equal(part.text, "step one");
		assert.deepEqual(part.metadata, { type: "thinking", signature: "sig-1" });
	});

	test("a redacted thinking block emits an empty-text part carrying the opaque data", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "redacted_thinking", data: "opaque" }] } }] },
			progress
		);

		assert.equal(parts.length, 1);
		const part = parts[0] as unknown as FakeThinkingPart;
		assert.equal(part.text, "");
		assert.deepEqual(part.metadata, { type: "redacted_thinking", data: "opaque" });
	});

	test("an empty choice-level thinking string does not suppress populated delta thinking", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ thinking: "", delta: { thinking: "deep" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "deep");
	});

	test("an empty reasoning_content does not suppress populated reasoning", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "", reasoning: "why" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "why");
	});

	test("contentless thinking_blocks do not suppress populated reasoning_content", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { thinking_blocks: [{}], reasoning_content: "steps" } }] }, progress);

		assert.equal(parts.length, 1);
		assert.equal((parts[0] as unknown as FakeThinkingPart).text, "steps");
	});
});

suite("provider/streaming thinking part pass-through", () => {
	class FakeThinkingPart {
		constructor(
			public text: string,
			public id?: string,
			public metadata?: unknown
		) {}
	}
	const fakeCtor = FakeThinkingPart as unknown as ThinkingPartCtor;

	setup(() => resetThinkingPartLogOnce());
	teardown(() => resetThinkingPartLogOnce());

	function thinkingPartsOf(parts: vscode.LanguageModelResponsePart[]): FakeThinkingPart[] {
		return parts.filter((p) => p instanceof FakeThinkingPart) as unknown as FakeThinkingPart[];
	}

	test("wire-provided ids pass through untouched", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { thinking: { text: "a1", id: "wire-a" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { thinking: { text: "a2", id: "wire-a" } } }] }, progress);
		stream.processDelta({ choices: [{ delta: { thinking: { text: "b1", id: "wire-b" } } }] }, progress);

		assert.deepEqual(
			thinkingPartsOf(parts).map((p) => p.id),
			["wire-a", "wire-a", "wire-b"]
		);
	});

	test("id-less thinking deltas emit with no id; the host mints its own unique one", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta({ choices: [{ delta: { reasoning_content: "step one " } }] }, progress);
		stream.processDelta({ choices: [{ delta: { reasoning: "step two " } }] }, progress);
		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "thinking", thinking: "three" }] } }] },
			progress
		);

		assert.deepEqual(
			thinkingPartsOf(parts).map((p) => p.id),
			[undefined, undefined, undefined]
		);
	});

	test("an empty-text signature part is emitted, not dropped: the host treats empty chunks as thinking separators", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "thinking", signature: "sig-2" }] } }] },
			progress
		);

		const emitted = thinkingPartsOf(parts);
		assert.equal(emitted.length, 1);
		assert.equal(expectDefined(emitted[0]).text, "");
		assert.equal(expectDefined(emitted[0]).id, undefined);
		assert.deepEqual(expectDefined(emitted[0]).metadata, { type: "thinking", signature: "sig-2" });
	});

	test("signature and redacted metadata pass through emission byte-identical, with no minted id", async () => {
		const stream = new StreamProcessor(idSource(), () => {}, fakeCtor);
		const { parts, progress } = collector();

		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "thinking", thinking: "final", signature: "sig-1" }] } }] },
			progress
		);
		stream.processDelta(
			{ choices: [{ delta: { thinking_blocks: [{ type: "redacted_thinking", data: "opaque" }] } }] },
			progress
		);

		const emitted = thinkingPartsOf(parts);
		assert.equal(emitted.length, 2);
		assert.deepEqual(
			emitted.map((p) => ({ id: p.id, metadata: p.metadata })),
			[
				{ id: undefined, metadata: { type: "thinking", signature: "sig-1" } },
				{ id: undefined, metadata: { type: "redacted_thinking", data: "opaque" } },
			]
		);
	});

	test("a missing thinking class is logged once across processors and reasoning is dropped", async () => {
		const logs: string[] = [];
		const first = new StreamProcessor(idSource(), (msg) => logs.push(msg), null);
		const second = new StreamProcessor(idSource(), (msg) => logs.push(msg), null);
		const { parts, progress } = collector();

		first.processDelta({ choices: [{ delta: { reasoning_content: "hidden" } }] }, progress);
		first.processDelta({ choices: [{ delta: { reasoning_content: "still hidden" } }] }, progress);
		second.processDelta({ choices: [{ delta: { reasoning: "also hidden" } }] }, progress);

		assert.equal(parts.length, 0, "Reasoning must be dropped, not emitted as text");
		assert.deepEqual(logs, ["Host does not support thinking parts; reasoning output will not be displayed"]);
	});
});
