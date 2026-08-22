import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { languageAllowed } from "../../../../extension/inline/languageFilter";

describe("extension/inline/languageFilter", () => {
	test("empty lists allow every language", () => {
		assert.strictEqual(languageAllowed("typescript", [], []), true);
		assert.strictEqual(languageAllowed("plaintext", [], []), true);
	});

	test("a non-empty allow list admits exactly its members", () => {
		const allowed = ["typescript", "python"];
		assert.strictEqual(languageAllowed("typescript", allowed, []), true);
		assert.strictEqual(languageAllowed("python", allowed, []), true);
		assert.strictEqual(languageAllowed("go", allowed, []), false);
	});

	test("the block list blocks its members and nothing else", () => {
		assert.strictEqual(languageAllowed("markdown", [], ["markdown"]), false);
		assert.strictEqual(languageAllowed("typescript", [], ["markdown"]), true);
	});

	test("block beats allow when a language sits in both lists", () => {
		assert.strictEqual(languageAllowed("typescript", ["typescript"], ["typescript"]), false);
	});

	test("IDs match exactly: no substrings, no globs, case-sensitive", () => {
		assert.strictEqual(languageAllowed("typescriptreact", ["typescript"], []), false);
		assert.strictEqual(languageAllowed("typescript", ["type*"], []), false);
		assert.strictEqual(languageAllowed("TypeScript", ["typescript"], []), false);
		assert.strictEqual(languageAllowed("c", ["cpp"], []), false);
		assert.strictEqual(languageAllowed("cpp", [], ["c"]), true);
	});
});
