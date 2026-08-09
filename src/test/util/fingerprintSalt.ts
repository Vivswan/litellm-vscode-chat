/**
 * Unit-label bootstrap, loaded via mocha.require (.vscode-test.mjs) before
 * any test file: unit suites compute fingerprints without running
 * activation's salt load, so the process-wide salt is pinned to this fixed,
 * public value up front. The dev-mode extension activating in the same host
 * finds the salt taken and downgrades itself to session-only (see
 * extension/fingerprintSalt.ts), which persists nothing.
 */
import { initFingerprintSalt } from "../../shared/util/fingerprint";

export const FIXED_TEST_SALT = "litellm-vscode-chat unit-test fingerprint salt (fixed, not a secret)";

initFingerprintSalt(FIXED_TEST_SALT);
