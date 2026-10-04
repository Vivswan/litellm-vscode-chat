/**
 * The pre-commit hook's one staging run over the generators registered below; the contract they run under is
 * scripts/dev/staging.ts. Always targets the checkout this script lives in, so the dirty-input refusal and the staged
 * outputs name the same repository. The generator CLIs keep `--check` and plain generation for CI and manual use.
 */
import * as path from "node:path";
import { SETTINGS_REFERENCE_GENERATOR } from "../docs/lib";
import { MANIFEST_GENERATOR } from "./manifest/generator";
import { stageAll } from "./staging";

/** The checkout these scripts belong to: two levels above scripts/dev. */
const SOURCE_CHECKOUT = path.resolve(__dirname, "..", "..");

try {
	stageAll(SOURCE_CHECKOUT, [MANIFEST_GENERATOR, SETTINGS_REFERENCE_GENERATOR]);
} catch (error) {
	// The message first: the hook's opening stderr line should be the actionable text, not a code frame.
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
