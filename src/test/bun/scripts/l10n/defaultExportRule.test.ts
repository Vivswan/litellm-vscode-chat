import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { defaultExportOffenses } from "../../../../../scripts/l10n/defaultExportRule";
import { DEFAULT_EXPORT_FIXTURES } from "./defaultExportRuleFixture";

/**
 * A default export lets every importer rename a helper out from under the name-following walks, so a shape the ban
 * stops seeing is a hole the gate reports nothing about; each fixture pins one shape's verdict.
 */
describe("l10n default-export ban per fixture", () => {
	for (const fixture of DEFAULT_EXPORT_FIXTURES) {
		test(fixture.name, () => {
			assert.strictEqual(defaultExportOffenses(fixture.source, "fixture.ts").length > 0, fixture.flagged);
		});
	}
});
