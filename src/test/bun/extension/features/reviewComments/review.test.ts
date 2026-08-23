import { describe, expect, test } from "bun:test";
import type { ReviewPlacement } from "../../../../../extension/features/reviewComments/placements";
import { REVIEW_FILE_LIMIT, type ReviewUnit, runReview } from "../../../../../extension/features/reviewComments/review";

/**
 * The per-file review loop: what it sends, what it applies, what it counts,
 * and where it stops. The transport, the prompts and the threads are all
 * injected, so this suite is the loop alone.
 */

const unit = (target: string, prompt: string, lineCount = 100): ReviewUnit<string> => ({ target, prompt, lineCount });

interface Applied {
	readonly target: string;
	readonly placements: readonly ReviewPlacement[];
}

/** A finished run with nothing surprising in it; tests override only what they are about. */
const clean = { reviewed: 0, findings: 0, unusable: 0, stale: 0, cancelled: false };

function harness(answers: readonly string[], options: { cancelAfter?: number; refuse?: boolean } = {}) {
	const cancelAfter = options.cancelAfter ?? Number.POSITIVE_INFINITY;
	const sent: string[] = [];
	const applied: Applied[] = [];
	const token = { isCancellationRequested: false };
	const deps = {
		send: (prompt: string) => {
			sent.push(prompt);
			if (sent.length >= cancelAfter) {
				token.isCancellationRequested = true;
			}
			return Promise.resolve(answers[sent.length - 1] ?? "");
		},
		apply: (target: string, placements: readonly ReviewPlacement[]) => {
			applied.push({ target, placements });
			return options.refuse !== true;
		},
		token,
	};
	return { sent, applied, deps, token };
}

describe("extension/features/reviewComments review", () => {
	test("sends one request per unit and applies each answer as it lands", async () => {
		const { sent, applied, deps } = harness(["LINE 3: off by one", "LINE 1-2: leaks a handle"]);
		const outcome = await runReview([unit("a.ts", "prompt A"), unit("b.ts", "prompt B")], deps);

		expect(sent).toEqual(["prompt A", "prompt B"]);
		expect(outcome).toEqual({ ...clean, reviewed: 2, findings: 2 });
		expect(applied.map((entry) => entry.target)).toEqual(["a.ts", "b.ts"]);
		expect(applied[0]?.placements).toEqual([{ startLine: 3, endLine: 3, body: "off by one" }]);
		expect(applied[1]?.placements).toEqual([{ startLine: 1, endLine: 2, body: "leaks a handle" }]);
	});

	test("an explicit no-findings reply still applies, so the file's previous review is cleared", async () => {
		const { applied, deps } = harness(["NO FINDINGS"]);
		const outcome = await runReview([unit("a.ts", "prompt A")], deps);

		expect(outcome).toEqual({ ...clean, reviewed: 1 });
		expect(applied).toEqual([{ target: "a.ts", placements: [] }]);
	});

	test("an empty answer is unusable: nothing is applied, so the earlier comments survive", async () => {
		const { applied, deps } = harness(["   \n  "]);
		const outcome = await runReview([unit("a.ts", "prompt A")], deps);

		expect(outcome).toEqual({ ...clean, reviewed: 1, unusable: 1 });
		expect(applied).toEqual([]);
	});

	test("prose with no anchored finding is unusable, not a clean bill of health", async () => {
		// The dangerous case: "Looks good to me!" must never be read as the
		// sentinel, because reading it that way silently deletes real comments.
		const { applied, deps } = harness(["Looks good to me! I did not spot anything."]);
		const outcome = await runReview([unit("a.ts", "prompt A")], deps);

		expect(outcome).toEqual({ ...clean, reviewed: 1, unusable: 1 });
		expect(applied).toEqual([]);
	});

	test("a refused apply counts as stale, and its findings are not counted as placed", async () => {
		// Counting them would render as "1 review comment across 0 files."
		const { applied, deps } = harness(["LINE 2: unchecked cast"], { refuse: true });
		const outcome = await runReview([unit("a.ts", "prompt A")], deps);

		expect(outcome).toEqual({ ...clean, reviewed: 1, stale: 1 });
		expect(applied).toHaveLength(1);
	});

	test("an answer that is only a code fence is unusable: not a clean bill, so nothing is cleared", async () => {
		const { applied, deps } = harness(["```\n```"]);
		const outcome = await runReview([unit("a.ts", "prompt A")], deps);

		expect(outcome).toEqual({ ...clean, reviewed: 1, unusable: 1 });
		expect(applied).toEqual([]);
	});

	test("placements clamp into the reviewed file rather than anchoring past its end", async () => {
		const { applied, deps } = harness(["LINE 900: past the end"]);
		await runReview([unit("a.ts", "prompt A", 10)], deps);

		expect(applied[0]?.placements).toEqual([{ startLine: 10, endLine: 10, body: "past the end" }]);
	});

	test("prose around a well-formed finding is discarded, and the finding still lands", async () => {
		const { applied, deps } = harness(["Here is my review:\nLINE 2: unchecked cast\nHope that helps!"]);
		const outcome = await runReview([unit("a.ts", "prompt A")], deps);

		expect(outcome).toEqual({ ...clean, reviewed: 1, findings: 1 });
		expect(applied[0]?.placements).toEqual([{ startLine: 2, endLine: 2, body: "unchecked cast" }]);
	});

	test("cancellation between files stops the run, reports it, and keeps what already landed", async () => {
		const { sent, applied, deps } = harness(["LINE 1: first", "LINE 1: second"], { cancelAfter: 1 });
		const outcome = await runReview([unit("a.ts", "prompt A"), unit("b.ts", "prompt B")], deps);

		expect(sent).toEqual(["prompt A"]);
		expect(outcome).toEqual({ ...clean, reviewed: 1, findings: 1, cancelled: true });
		expect(applied.map((entry) => entry.target)).toEqual(["a.ts"]);
	});

	test("a token already cancelled sends nothing at all", async () => {
		const { sent, deps, token } = harness(["LINE 1: never asked"]);
		token.isCancellationRequested = true;
		const outcome = await runReview([unit("a.ts", "prompt A")], deps);

		expect(sent).toEqual([]);
		expect(outcome).toEqual({ ...clean, cancelled: true });
	});

	test("a failed call aborts the run instead of reading as nothing to report", async () => {
		const applied: Applied[] = [];
		let caught: unknown;
		try {
			await runReview([unit("a.ts", "prompt A"), unit("b.ts", "prompt B")], {
				send: () => Promise.reject(new Error("boom")),
				apply: (target, placements) => {
					applied.push({ target, placements });
					return true;
				},
				token: { isCancellationRequested: false },
			});
		} catch (error) {
			caught = error;
		}
		expect((caught as Error | undefined)?.message).toBe("boom");
		expect(applied).toEqual([]);
	});

	test("reports progress once per file, with the file's position in the run", async () => {
		const { deps } = harness(["NO FINDINGS", "NO FINDINGS"]);
		const reported: string[] = [];
		await runReview([unit("a.ts", "prompt A"), unit("b.ts", "prompt B")], {
			...deps,
			onFileStart: (index, total) => reported.push(`${index}/${total}`),
		});

		expect(reported).toEqual(["0/2", "1/2"]);
	});

	test("the file cap is a small positive bound the command can report against", () => {
		expect(Number.isSafeInteger(REVIEW_FILE_LIMIT)).toBe(true);
		expect(REVIEW_FILE_LIMIT).toBeGreaterThan(0);
	});
});
