import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { vscodeL10nOffenses } from "../../../../../scripts/l10n/vscodeL10nRule";
import { VSCODE_L10N_FIXTURES } from "./vscodeL10nRuleFixture";

/**
 * A laundering form the rule stops seeing is a second l10n API in shipped source that the gate reports nothing about,
 * and a sanctioned form it starts flagging blocks every commit; each fixture pins one form's verdict.
 */
describe("l10n one-API rule per fixture", () => {
	for (const fixture of VSCODE_L10N_FIXTURES) {
		test(fixture.name, () => {
			const options = {
				allowBundleReads: fixture.allowBundleReads === true,
				allowVscodeValueUse: fixture.allowVscodeValueUse === true,
			};
			const offenses = vscodeL10nOffenses(fixture.source, fixture.fileName ?? "fixture.ts", options);
			assert.strictEqual(offenses.length > 0, fixture.flagged);
		});
	}
});
