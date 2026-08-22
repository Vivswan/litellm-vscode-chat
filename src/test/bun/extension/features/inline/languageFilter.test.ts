import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { languageAllowed } from "../../../../../extension/features/inline/languageFilter";

describe("extension/features/inline/languageFilter", () => {
	test("block mode with the empty list allows every language", () => {
		assert.strictEqual(languageAllowed("typescript", { mode: "block", languages: [] }), true);
		assert.strictEqual(languageAllowed("plaintext", { mode: "block", languages: [] }), true);
	});

	test("block mode blocks exactly its members and nothing else", () => {
		const filter = { mode: "block", languages: ["markdown"] } as const;
		assert.strictEqual(languageAllowed("markdown", filter), false);
		assert.strictEqual(languageAllowed("typescript", filter), true);
	});

	test("allow mode admits exactly its members", () => {
		const filter = { mode: "allow", languages: ["typescript", "python"] } as const;
		assert.strictEqual(languageAllowed("typescript", filter), true);
		assert.strictEqual(languageAllowed("python", filter), true);
		assert.strictEqual(languageAllowed("go", filter), false);
	});

	test("allow mode with the empty list admits nothing", () => {
		assert.strictEqual(languageAllowed("typescript", { mode: "allow", languages: [] }), false);
		assert.strictEqual(languageAllowed("plaintext", { mode: "allow", languages: [] }), false);
	});

	test("IDs match exactly: no substrings, no globs, case-sensitive", () => {
		assert.strictEqual(languageAllowed("typescriptreact", { mode: "allow", languages: ["typescript"] }), false);
		assert.strictEqual(languageAllowed("typescript", { mode: "allow", languages: ["type*"] }), false);
		assert.strictEqual(languageAllowed("TypeScript", { mode: "allow", languages: ["typescript"] }), false);
		assert.strictEqual(languageAllowed("c", { mode: "allow", languages: ["cpp"] }), false);
		assert.strictEqual(languageAllowed("cpp", { mode: "block", languages: ["c"] }), true);
	});
});
