import { describe, expect, test } from "bun:test";
import * as assert from "node:assert";
import * as fc from "fast-check";
import {
	assembleConsultPrompt,
	CONSULT_INSTRUCTION,
	CONTEXT_TRUNCATION_MARKER,
	type ConsultPromptFit,
	type ConsultTextPart,
	type ConsultTokenizationOptions,
	type ConsultToolInput,
	EMPTY_REPLY_TEXT,
	fitConsultPrompt,
	fitConsultReply,
	QUESTION_TRUNCATION_MARKER,
	REPLY_TRUNCATION_MARKER,
	readConsultInput,
	shapeConsultResult,
	TRUNCATION_BISECTION_STEPS,
} from "../../../../../extension/features/consultTool/invocation";
import { resolveFuzzSeed } from "../../../../fuzzStream";

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 100;
const SEED = resolveFuzzSeed();

const QUESTION = "Is this cache invalidation sound?";
const CONTEXT = "c".repeat(300);

/** One token per character, so every budget boundary is exact and assertable. */
function lengthCounter(tokenBudget: number): {
	readonly calls: string[];
	readonly options: ConsultTokenizationOptions;
} {
	const calls: string[] = [];
	return {
		calls,
		options: {
			tokenBudget,
			countTokens: (text) => {
				calls.push(text);
				return Promise.resolve(text.length);
			},
		},
	};
}

describe("assembleConsultPrompt", () => {
	test("labels the sections and leads with the instruction", () => {
		const prompt = assembleConsultPrompt(QUESTION, "some context");
		expect(prompt.startsWith(CONSULT_INSTRUCTION)).toBe(true);
		expect(prompt).toContain("Context supplied by the caller:\nsome context");
		expect(prompt.endsWith(`Question:\n${QUESTION}`)).toBe(true);
	});

	test("omits the context section when there is none, blank included", () => {
		const bare = assembleConsultPrompt(QUESTION, undefined);
		expect(bare).not.toContain("Context supplied by the caller:");
		expect(bare.endsWith(`Question:\n${QUESTION}`)).toBe(true);
		expect(assembleConsultPrompt(QUESTION, " \n\t ")).toBe(bare);
	});
});

describe("fitConsultPrompt", () => {
	test("a prompt within budget goes out untouched, measured exactly once", async () => {
		const full = assembleConsultPrompt(QUESTION, CONTEXT);
		const { calls, options } = lengthCounter(full.length);
		const fit = await fitConsultPrompt({ question: QUESTION, context: CONTEXT }, options);
		expect(fit).toEqual({ prompt: full, contextTruncated: false, questionTruncated: false, withinBudget: true });
		expect(calls).toEqual([full]);
	});

	test("blank context reads as absent", async () => {
		const base = assembleConsultPrompt(QUESTION, undefined);
		const { calls, options } = lengthCounter(base.length);
		const fit = await fitConsultPrompt({ question: QUESTION, context: " \n\t " }, options);
		expect(fit).toEqual({ prompt: base, contextTruncated: false, questionTruncated: false, withinBudget: true });
		expect(calls).toEqual([base]);
	});

	test("context is cut first, to the exact budget, with the question intact", async () => {
		const markerOnly = assembleConsultPrompt(QUESTION, CONTEXT_TRUNCATION_MARKER);
		const keptChars = 120;
		const budget = markerOnly.length + 1 + keptChars;
		const { calls, options } = lengthCounter(budget);
		const fit = await fitConsultPrompt({ question: QUESTION, context: CONTEXT }, options);
		expect(fit.prompt).toBe(
			assembleConsultPrompt(QUESTION, `${CONTEXT.slice(0, keptChars)}\n${CONTEXT_TRUNCATION_MARKER}`)
		);
		expect(fit.prompt.length).toBe(budget);
		expect(fit.prompt).toContain(`Question:\n${QUESTION}`);
		expect(fit.prompt).not.toContain(QUESTION_TRUNCATION_MARKER);
		expect(fit.contextTruncated).toBe(true);
		expect(fit.questionTruncated).toBe(false);
		expect(fit.withinBudget).toBe(true);
		expect(calls.length).toBeLessThanOrEqual(2 + TRUNCATION_BISECTION_STEPS);
	});

	test("context is dropped wholesale when not even the marker fits beside the question", async () => {
		const base = assembleConsultPrompt(QUESTION, undefined);
		const { options } = lengthCounter(base.length);
		const fit = await fitConsultPrompt({ question: QUESTION, context: CONTEXT }, options);
		expect(fit).toEqual({ prompt: base, contextTruncated: true, questionTruncated: false, withinBudget: true });
	});

	test("the question is cut only after the context is gone, again to the exact budget", async () => {
		const longQuestion = "q".repeat(240);
		const markerOnly = assembleConsultPrompt(QUESTION_TRUNCATION_MARKER, undefined);
		const keptChars = 25;
		const budget = markerOnly.length + 1 + keptChars;
		const { options } = lengthCounter(budget);
		const fit = await fitConsultPrompt({ question: longQuestion, context: "c".repeat(100) }, options);
		expect(fit.prompt).toBe(
			assembleConsultPrompt(`${longQuestion.slice(0, keptChars)}\n${QUESTION_TRUNCATION_MARKER}`, undefined)
		);
		expect(fit.prompt.length).toBe(budget);
		expect(fit.prompt).not.toContain("Context supplied by the caller:");
		expect(fit.contextTruncated).toBe(true);
		expect(fit.questionTruncated).toBe(true);
		expect(fit.withinBudget).toBe(true);
	});

	test("question truncation without context leaves contextTruncated false", async () => {
		const longQuestion = "q".repeat(240);
		const markerOnly = assembleConsultPrompt(QUESTION_TRUNCATION_MARKER, undefined);
		const budget = markerOnly.length + 1 + 60;
		const { options } = lengthCounter(budget);
		const fit = await fitConsultPrompt({ question: longQuestion }, options);
		expect(fit.prompt.length).toBe(budget);
		expect(fit.prompt).toContain(QUESTION_TRUNCATION_MARKER);
		expect(fit.contextTruncated).toBe(false);
		expect(fit.questionTruncated).toBe(true);
		expect(fit.withinBudget).toBe(true);
	});

	test("a below-floor budget keeps the intact question when it is the smaller candidate", async () => {
		const base = assembleConsultPrompt(QUESTION, undefined);
		const { calls, options } = lengthCounter(1);
		const fit = await fitConsultPrompt({ question: QUESTION }, options);
		expect(fit).toEqual({ prompt: base, contextTruncated: false, questionTruncated: false, withinBudget: false });
		expect(calls.length).toBe(2);
	});

	test("a below-floor budget cuts a huge question down to the marker", async () => {
		const { calls, options } = lengthCounter(1);
		const fit = await fitConsultPrompt({ question: "q".repeat(500) }, options);
		expect(fit).toEqual({
			prompt: assembleConsultPrompt(QUESTION_TRUNCATION_MARKER, undefined),
			contextTruncated: false,
			questionTruncated: true,
			withinBudget: false,
		});
		expect(calls.length).toBe(2);
	});

	test("a tie between the floors keeps the intact question", async () => {
		// With the one-token-per-character counter, a question exactly as long as
		// the marker makes both below-floor candidates measure identically.
		const question = "x".repeat(QUESTION_TRUNCATION_MARKER.length);
		const base = assembleConsultPrompt(question, undefined);
		expect(base.length).toBe(assembleConsultPrompt(QUESTION_TRUNCATION_MARKER, undefined).length);
		const { options } = lengthCounter(1);
		const fit = await fitConsultPrompt({ question }, options);
		expect(fit).toEqual({ prompt: base, contextTruncated: false, questionTruncated: false, withinBudget: false });
	});

	test("an empty question is never reported truncated", async () => {
		const base = assembleConsultPrompt("", undefined);
		const { options } = lengthCounter(1);
		const fit = await fitConsultPrompt({ question: "" }, options);
		expect(fit).toEqual({ prompt: base, contextTruncated: false, questionTruncated: false, withinBudget: false });
	});

	test("a below-floor budget with context measures each rung exactly once", async () => {
		const { calls, options } = lengthCounter(1);
		const fit = await fitConsultPrompt({ question: QUESTION, context: CONTEXT }, options);
		expect(fit).toEqual({
			prompt: assembleConsultPrompt(QUESTION, undefined),
			contextTruncated: true,
			questionTruncated: false,
			withinBudget: false,
		});
		// Full prompt, marker-only context, dropped context, marker-only question.
		expect(calls.length).toBe(4);
	});

	test("every count is awaited in turn: a slow Thenable counter never overlaps and agrees with the sync result", async () => {
		const markerOnly = assembleConsultPrompt(QUESTION, CONTEXT_TRUNCATION_MARKER);
		const budget = markerOnly.length + 1 + 120;
		const sync = await fitConsultPrompt({ question: QUESTION, context: CONTEXT }, lengthCounter(budget).options);
		let pending = 0;
		let maxPending = 0;
		const slow: ConsultTokenizationOptions = {
			tokenBudget: budget,
			countTokens: (text) => {
				pending += 1;
				maxPending = Math.max(maxPending, pending);
				return new Promise<number>((resolve) => {
					setTimeout(() => {
						pending -= 1;
						resolve(text.length);
					}, 0);
				});
			},
		};
		const fit: ConsultPromptFit = await fitConsultPrompt({ question: QUESTION, context: CONTEXT }, slow);
		expect(fit).toEqual(sync);
		expect(maxPending).toBe(1);
	});

	test("a rejecting countTokens propagates unchanged", async () => {
		const boom = new Error("cancelled");
		const options: ConsultTokenizationOptions = { tokenBudget: 10, countTokens: () => Promise.reject(boom) };
		let caught: unknown;
		try {
			await fitConsultPrompt({ question: QUESTION }, options);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(boom);
	});

	test("a cut never strands half a surrogate pair", async () => {
		const emojiContext = "\u{1F600}".repeat(120);
		const markerOnly = assembleConsultPrompt(QUESTION, CONTEXT_TRUNCATION_MARKER);
		const budget = markerOnly.length + 1 + 121;
		const { options } = lengthCounter(budget);
		const fit = await fitConsultPrompt({ question: QUESTION, context: emojiContext }, options);
		expect(fit.contextTruncated).toBe(true);
		expect(fit.withinBudget).toBe(true);
		expect(fit.prompt.isWellFormed()).toBe(true);
		expect(fit.prompt.length).toBeLessThanOrEqual(budget);
	});

	test("a NaN budget fails closed to the best-effort floor, never to a false fit", async () => {
		const { options } = lengthCounter(Number.NaN);
		const fit = await fitConsultPrompt({ question: QUESTION, context: CONTEXT }, options);
		expect(fit.withinBudget).toBe(false);
		expect(fit.prompt).toBe(assembleConsultPrompt(QUESTION, undefined));
	});

	test("a field beyond the step cap still lands within the documented shortfall", async () => {
		// Big enough that the bisection stops short of the exact boundary: the
		// bound must bite, not pass vacuously at a zero shortfall.
		const bigContext = "c".repeat(1_000_000);
		const markerOnly = assembleConsultPrompt(QUESTION, CONTEXT_TRUNCATION_MARKER);
		const budget = markerOnly.length + 1 + 700_000;
		const { options } = lengthCounter(budget);
		const fit = await fitConsultPrompt({ question: QUESTION, context: bigContext }, options);
		expect(fit.withinBudget).toBe(true);
		expect(fit.prompt.length).toBeLessThanOrEqual(budget);
		expect(budget - fit.prompt.length).toBeLessThanOrEqual(
			Math.ceil(bigContext.length / 2 ** TRUNCATION_BISECTION_STEPS)
		);
	});

	test("the input shape is exactly question plus optional context", async () => {
		const input: ConsultToolInput = { question: QUESTION };
		const base = assembleConsultPrompt(QUESTION, undefined);
		const fit = await fitConsultPrompt(input, lengthCounter(base.length).options);
		expect(fit.withinBudget).toBe(true);
	});
});

describe("fitConsultPrompt properties", () => {
	const promptText = fc.string({ unit: fc.constantFrom("a", "Q", " ", "\n", "\u{1F600}", "汉"), maxLength: 400 });

	test("every fit is a measured candidate, well-formed, honestly flagged, and cuts context before the question", async () => {
		await fc.assert(
			fc.asyncProperty(
				promptText,
				fc.option(promptText, { nil: undefined }),
				fc.integer({ min: 0, max: 1200 }),
				async (question, context, tokenBudget) => {
					const { calls, options } = lengthCounter(tokenBudget);
					const fit = await fitConsultPrompt({ question, context }, options);
					assert.ok(calls.includes(fit.prompt), "the returned prompt must itself have been measured");
					assert.ok(fit.prompt.isWellFormed(), "the prompt must never carry a severed surrogate");
					assert.strictEqual(
						fit.withinBudget,
						fit.prompt.length <= tokenBudget,
						"withinBudget must state the measured truth"
					);
					if (!fit.questionTruncated) {
						assert.ok(fit.prompt.endsWith(`Question:\n${question}`), "an uncut question must ride verbatim");
					}
					if (fit.questionTruncated) {
						assert.ok(question.length > 0, "an empty question cannot be cut");
						const hadContext = context !== undefined && context.trim() !== "";
						assert.ok(!hadContext || fit.contextTruncated, "the question is only cut once the context is gone");
					}
					if (!fit.withinBudget) {
						const intact = assembleConsultPrompt(question, undefined);
						assert.ok(fit.prompt.length <= intact.length, "the below-floor pick must be the smaller candidate");
						assert.strictEqual(
							fit.questionTruncated,
							fit.prompt.length < intact.length,
							"a below-floor tie must keep the question intact"
						);
					}
				}
			),
			{ numRuns: NUM_RUNS, seed: SEED }
		);
	});
});

describe("shapeConsultResult", () => {
	test("trims the reply and keeps its body verbatim", () => {
		const part: ConsultTextPart = shapeConsultResult("  **Yes**, with one caveat.\n\n- races remain\n  ");
		expect(part.value).toBe("**Yes**, with one caveat.\n\n- races remain");
	});

	test("an empty reply becomes the stated stand-in text", () => {
		expect(shapeConsultResult("   \n\t ").value).toBe(EMPTY_REPLY_TEXT);
	});
});

describe("fitConsultReply", () => {
	// tokenBudget governs what the tool EMITS - the reply is the only thing it
	// adds to the calling model's context - so this is where the host's budget
	// is spent, not on the outgoing prompt.
	test("a reply within budget travels whole, measured exactly once", async () => {
		const counter = lengthCounter(100);
		const fit = await fitConsultReply("short answer", counter.options);
		expect(fit).toEqual({ text: "short answer", truncated: false });
		expect(counter.calls.length).toBe(1);
	});

	test("an oversized reply is cut from the end to the exact budget, marked, keeping its opening", async () => {
		const reply = "A".repeat(4000);
		const fit = await fitConsultReply(reply, lengthCounter(200).options);
		expect(fit.truncated).toBe(true);
		expect(fit.text.length).toBeLessThanOrEqual(200);
		expect(fit.text.endsWith(REPLY_TRUNCATION_MARKER)).toBe(true);
		expect(fit.text.startsWith("AAA")).toBe(true);
		// Exactly at the boundary: one more code unit would not have fit.
		expect(fit.text.length).toBe(200);
	});

	test("the budget is a maximum: every finite budget is respected, the marker included", async () => {
		// Below the marker's own length there is nothing left to say that fits,
		// so the tool emits nothing rather than breaking the bound it was given.
		const reply = "A".repeat(500);
		for (let budget = 0; budget <= REPLY_TRUNCATION_MARKER.length + 4; budget += 1) {
			const fit = await fitConsultReply(reply, lengthCounter(budget).options);
			expect(fit.truncated).toBe(true);
			expect(fit.text.length).toBeLessThanOrEqual(budget);
			if (budget < REPLY_TRUNCATION_MARKER.length) {
				expect(fit.text).toBe("");
			} else {
				expect(fit.text.endsWith(REPLY_TRUNCATION_MARKER)).toBe(true);
			}
		}
	});

	test("a NaN budget fails closed to the empty result, never to a false fit", async () => {
		const fit = await fitConsultReply("A".repeat(500), lengthCounter(Number.NaN).options);
		expect(fit).toEqual({ text: "", truncated: true });
	});

	test("a cut never strands half a surrogate pair", async () => {
		const reply = "\u{1F600}".repeat(400);
		// Budgets straddling the marker's own length, so both the marker-only
		// floor and real cuts of the emoji run are exercised.
		const marker = REPLY_TRUNCATION_MARKER.length;
		for (let budget = marker; budget <= marker + 8; budget += 1) {
			const fit = await fitConsultReply(reply, lengthCounter(budget).options);
			expect(fit.text.endsWith(REPLY_TRUNCATION_MARKER)).toBe(true);
			expect(fit.text.length).toBeLessThanOrEqual(budget);
			// withMarker joins a non-empty prefix with "\n"; the floor is the bare marker.
			const body = fit.text === REPLY_TRUNCATION_MARKER ? "" : fit.text.slice(0, -(marker + 1));
			expect(body.length % 2).toBe(0);
			expect([...body].every((ch) => ch === "\u{1F600}")).toBe(true);
		}
	});

	test("a rejecting countTokens propagates unchanged, so cancellation rides the counter", async () => {
		const boom = new Error("counter down");
		const options: ConsultTokenizationOptions = { tokenBudget: 10, countTokens: () => Promise.reject(boom) };
		let caught: unknown;
		try {
			await fitConsultReply("anything", options);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(boom);
	});
});

describe("readConsultInput", () => {
	// The contributed JSON schema is documentation for the calling model, not a
	// host guarantee: VS Code forwards an input missing a `required` property
	// as-is (proven in the wiring's live-host suite), so everything below is
	// what actually stands between a malformed agent call and the prompt.
	test("a well-formed input passes through, context included", () => {
		expect(readConsultInput({ question: QUESTION, context: CONTEXT })).toEqual({
			question: QUESTION,
			context: CONTEXT,
		});
	});

	test("the question rides verbatim: no trimming of text a model is meant to read", () => {
		expect(readConsultInput({ question: "  padded  " })).toEqual({ question: "  padded  " });
	});

	test("no question means no call: missing, blank, and non-string alike", () => {
		for (const raw of [
			{},
			{ context: "context but no question" },
			{ question: undefined },
			{ question: "" },
			{ question: "   \n\t " },
			{ question: 42 },
			{ question: null },
			{ question: ["a"] },
		]) {
			expect(readConsultInput(raw)).toBeUndefined();
		}
	});

	test("a non-object input is refused rather than read through", () => {
		for (const raw of [undefined, null, "question", 7, ["question"]]) {
			expect(readConsultInput(raw)).toBeUndefined();
		}
	});

	test("a context that is not a string reads as absent, so the question is still asked", () => {
		expect(readConsultInput({ question: QUESTION, context: 42 })).toEqual({ question: QUESTION });
		expect(readConsultInput({ question: QUESTION, context: null })).toEqual({ question: QUESTION });
		// Absent, not present-and-undefined: the key must not reach the wire shape.
		expect("context" in (readConsultInput({ question: QUESTION, context: {} }) ?? {})).toBe(false);
	});

	test("a prototype-polluting key is inert: only the two declared fields are read", () => {
		const parsed = readConsultInput(JSON.parse('{"question":"q","__proto__":{"context":"injected"}}'));
		expect(parsed).toEqual({ question: "q" });
	});
});
