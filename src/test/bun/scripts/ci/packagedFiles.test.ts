import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { listingProblems, REQUIRED_PACKAGED_FILES } from "../../../../../scripts/ci/packagedFiles";

/**
 * Repo-tooling files once shipped in a VSIX because the check was a denylist nobody had extended; the allowlist judge
 * refuses any file it was not told about and names it.
 */
describe("packaged file listing", () => {
	test("tooling files are refused by name; the allowed shapes pass", () => {
		const listing = [
			...REQUIRED_PACKAGED_FILES,
			"package.json",
			"assets/icon.png",
			"l10n/bundle.l10n.zh-cn.json",
			"package.nls.zh-tw.json",
			"dist/chunks/o200k_base-ab12.js",
			"biome.json",
			".github/workflows/ci.yml",
		];
		assert.deepStrictEqual(listingProblems(listing, REQUIRED_PACKAGED_FILES), [
			"vsce would package files outside the allowed set: biome.json, .github/workflows/ci.yml",
		]);
	});
});
