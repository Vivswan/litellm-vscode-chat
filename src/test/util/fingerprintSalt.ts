/**
 * Unit-label bootstrap, loaded via mocha.require before any test file: unit
 * suites compute fingerprints without running activation's salt load, so the
 * process-wide salt is pinned up front. The dev-mode extension activating in
 * the same host then finds the salt taken and downgrades itself to
 * session-only, which persists nothing.
 */
import { initFingerprintSalt } from "../../shared/util/fingerprint";
import { catalogOff } from "../hostApiHelpers";
import { FIXED_TEST_SALT } from "./testSalt";

initFingerprintSalt(FIXED_TEST_SALT);

/**
 * Awaited by the @vscode/test-cli runner before any test file loads. The
 * dev-mode extension arms an OpenRouter catalog refresh 60 seconds in, and a
 * unit pass crosses that line: whichever fetch stub is live at that moment
 * would see the request, and a live snapshot could persist into the label's
 * globalStorage. Turning the catalog off disables the refresh at the source;
 * the msw baseline handler is the second line of defense.
 */
export async function mochaGlobalSetup(): Promise<void> {
	await catalogOff();
}
