/**
 * Unit-label bootstrap, loaded via mocha.require (.vscode-test.mjs) before
 * any test file: unit suites compute fingerprints without running
 * activation's salt load, so the process-wide salt is pinned to this fixed,
 * public value up front. The dev-mode extension activating in the same host
 * finds the salt taken and downgrades itself to session-only (see
 * extension/fingerprintSalt.ts), which persists nothing.
 */
import { initFingerprintSalt } from "../../shared/util/fingerprint";
import { catalogOff } from "../hostApiHelpers";
import { FIXED_TEST_SALT } from "./testSalt";

initFingerprintSalt(FIXED_TEST_SALT);

/**
 * Awaited by the @vscode/test-cli runner before any test file loads. The
 * dev-mode extension activating in this shared host arms an OpenRouter
 * catalog refresh 60 seconds in, and a unit pass crosses that line: whichever
 * fetch stub is live at that moment (msw between listen/close, a withFetch
 * replacement) would see the request, and a live snapshot could persist into
 * the label's globalStorage. Turning the catalog off disables the refresh at
 * the source; the msw baseline handler in mocks/handlers.ts stays as the
 * second line of defense.
 */
export async function mochaGlobalSetup(): Promise<void> {
	await catalogOff();
}
