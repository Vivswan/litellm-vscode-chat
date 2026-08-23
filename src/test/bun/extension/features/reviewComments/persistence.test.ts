import { describe, expect, test } from "bun:test";
import {
	type DecodeStoreResult,
	decodeStore,
	encodeStore,
	type PruneResult,
	pruneThreads,
	REVIEW_STORE_VERSION,
	type ReviewCommentAuthor,
	type ReviewCommentStore,
	type ReviewThreadsByUri,
	type StoredReviewComment,
	type StoredReviewThread,
} from "../../../../../extension/features/reviewComments/persistence";

const AUTHORS: readonly ReviewCommentAuthor[] = ["model", "user"];

function comment(author: ReviewCommentAuthor, body: string): StoredReviewComment {
	return { author, body, createdAt: 1_700_000_000_000 };
}

const THREADS_A: readonly StoredReviewThread[] = [
	{
		id: "t1",
		startLine: 3,
		endLine: 5,
		resolved: false,
		comments: AUTHORS.map((author) => comment(author, `by ${author}`)),
	},
];

const THREADS: ReviewThreadsByUri = {
	"file:///a.ts": THREADS_A,
	"file:///b.ts": [{ id: "t2", startLine: 0, endLine: 0, resolved: true, comments: [] }],
};

describe("extension/features/reviewComments/persistence", () => {
	test("the frozen signatures and the store version", () => {
		const encode: (threads: ReviewThreadsByUri) => ReviewCommentStore = encodeStore;
		const decode: (raw: unknown) => DecodeStoreResult = decodeStore;
		const prune: (threads: ReviewThreadsByUri, exists: (uri: string) => Promise<boolean>) => Promise<PruneResult> =
			pruneThreads;
		expect(typeof encode).toBe("function");
		expect(typeof decode).toBe("function");
		expect(typeof prune).toBe("function");
		expect(REVIEW_STORE_VERSION).toBe(1);
	});

	test("a store survives the encode -> JSON -> decode roundtrip byte for byte", () => {
		const raw: unknown = JSON.parse(JSON.stringify(encodeStore(THREADS)));
		expect(decodeStore(raw)).toEqual({ ok: true, threads: THREADS, dropped: 0 });
	});

	test("nothing stored yet reads as an ok empty store", () => {
		for (const raw of [undefined, null]) {
			expect(decodeStore(raw)).toEqual({ ok: true, threads: {}, dropped: 0 });
		}
	});

	test("values that are not a store read as not-a-store with empty threads", () => {
		const cases: unknown[] = [
			"text",
			7,
			true,
			[],
			{},
			{ version: "1", threads: {} },
			{ version: 1 },
			{ version: 1, threads: [] },
			{ version: 1, threads: "x" },
		];
		for (const raw of cases) {
			expect(decodeStore(raw)).toEqual({ ok: false, reason: "not-a-store", threads: {} });
		}
	});

	test("a version stamp this build does not know reads as an empty store with the unknown-version advisory", () => {
		for (const version of [0, 2, 1.5, -1, Number.NaN]) {
			expect(decodeStore({ version, threads: THREADS })).toEqual({ ok: false, reason: "unknown-version", threads: {} });
		}
	});

	test("malformed threads and comments drop individually and are counted while valid siblings survive", () => {
		const valid: StoredReviewThread = { id: "keep", startLine: 1, endLine: 2, resolved: false, comments: [] };
		const raw = {
			version: 1,
			threads: {
				"file:///good.ts": [
					valid,
					{ id: "", startLine: 1, endLine: 2, resolved: false, comments: [] },
					{ id: "reversed", startLine: 5, endLine: 2, resolved: false, comments: [] },
					{ id: "fraction", startLine: 1.5, endLine: 2, resolved: false, comments: [] },
					{ id: "negative", startLine: -1, endLine: 2, resolved: false, comments: [] },
					{ id: "unresolvedFlag", startLine: 1, endLine: 2, resolved: "no", comments: [] },
					"not a thread",
				],
				"file:///comments.ts": [
					{
						id: "mixed",
						startLine: 4,
						endLine: 4,
						resolved: true,
						comments: [
							comment("model", "kept"),
							{ author: "assistant", body: "bad author", createdAt: 1 },
							{ author: "user", body: 42, createdAt: 1 },
							{ author: "user", body: "bad stamp", createdAt: "now" },
							null,
						],
					},
				],
				"file:///notAnArray.ts": { id: "x" },
			},
		};
		const result = decodeStore(raw);
		expect(result).toEqual({
			ok: true,
			threads: {
				"file:///good.ts": [valid],
				"file:///comments.ts": [
					{ id: "mixed", startLine: 4, endLine: 4, resolved: true, comments: [comment("model", "kept")] },
				],
			},
			// 6 threads + 4 comments + 1 non-array entry.
			dropped: 11,
		});
	});

	test("prototype-polluting uri keys are dropped, never assigned", () => {
		const raw = {
			version: 1,
			threads: JSON.parse(`{"__proto__": [], "constructor": [], "prototype": [], "file:///ok.ts": []}`),
		};
		const result = decodeStore(raw);
		expect(result.ok).toBe(true);
		expect(Object.keys(result.threads)).toEqual(["file:///ok.ts"]);
		if (result.ok) {
			expect(result.dropped).toBe(3);
		}
	});

	test("hostile objects that throw on access read as not-a-store instead of throwing", () => {
		const revocable = Proxy.revocable({}, {});
		revocable.revoke();
		const cases: unknown[] = [
			revocable.proxy,
			{
				version: 1,
				get threads(): never {
					throw new Error("boom");
				},
			},
			{
				version: 1,
				threads: {
					"file:///x.ts": [
						{
							get id(): never {
								throw new Error("boom");
							},
						},
					],
				},
			},
		];
		for (const raw of cases) {
			expect(decodeStore(raw)).toEqual({ ok: false, reason: "not-a-store", threads: {} });
		}
	});

	test("prune keeps existing documents, removes missing ones, and reports the removed uris", async () => {
		const result = await pruneThreads(THREADS, async (uri) => uri === "file:///a.ts");
		expect(result).toEqual({ threads: { "file:///a.ts": THREADS_A }, removedUris: ["file:///b.ts"] });
	});

	test("a throwing existence predicate counts as exists: pruning never deletes on a stat error", async () => {
		const result = await pruneThreads(THREADS, async (uri) => {
			if (uri === "file:///a.ts") {
				throw new Error("stat failed");
			}
			return false;
		});
		expect(result).toEqual({ threads: { "file:///a.ts": THREADS_A }, removedUris: ["file:///b.ts"] });
	});

	test("prune of an empty record resolves without calling the predicate", async () => {
		let calls = 0;
		const result = await pruneThreads({}, async () => {
			calls += 1;
			return true;
		});
		expect(result).toEqual({ threads: {}, removedUris: [] });
		expect(calls).toBe(0);
	});

	test("prune round-trips a hostile uri key as own data without touching the prototype", async () => {
		const input = JSON.parse(`{"__proto__": []}`) as ReviewThreadsByUri;
		const result = await pruneThreads(input, async () => true);
		expect(Object.getOwnPropertyNames(result.threads)).toEqual(["__proto__"]);
		expect(Object.getPrototypeOf(result.threads)).toBe(Object.prototype);
	});
});
