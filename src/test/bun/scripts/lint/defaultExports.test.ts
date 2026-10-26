import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { DEFAULT_EXPORT_BAN } from "../../../../../eslint.config";
import { DEFAULT_EXPORT_FIXTURES } from "./defaultExportsFixture";

// The gate fails green, not red, when it goes blind: a default-export shape a selector stops matching is a helper every
// importer may rename with no signal anywhere, so each fixture pins one shape's verdict under the lint run's selectors.
const linter = new Linter();

const config: Linter.Config[] = [
	{
		files: ["**/*.ts"],
		languageOptions: { parser: tseslint.parser },
		rules: { "no-restricted-syntax": ["error", ...DEFAULT_EXPORT_BAN] },
	},
];

describe("default-export ban per fixture", () => {
	for (const fixture of DEFAULT_EXPORT_FIXTURES) {
		test(fixture.name, () => {
			// A parse failure reports under a null rule id, so it fails a flagged and an unflagged fixture alike.
			const reports = linter.verify(fixture.source, config, { filename: "fixture.ts" }).map((report) => report.ruleId);
			assert.deepStrictEqual(reports, fixture.flagged ? ["no-restricted-syntax"] : []);
		});
	}
});
