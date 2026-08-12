/**
 * Preload for the bun test tree (wired via bunfig.toml), loaded before any
 * test module. The tree's rule: suites that need no extension host live here
 * - the pure logic and property suites and the DOM component tests; real
 * network machinery (msw) stays host-side in the Mocha suites.
 * Four process-global concerns live here so no suite can forget them:
 * happy-dom registration, the fixed fingerprint salt (suites here compute
 * fingerprints without running activation's salt load), the acquireVsCodeApi
 * stub (vscodeApi.ts calls acquireVsCodeApi() at module top level, so a
 * component import without the stub is an import-time crash; harmless for
 * non-DOM suites), and the console.error gate below. The harness is imported
 * dynamically so the DOM registration above runs first (static imports would
 * hoist past it).
 */
import { afterEach, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { initFingerprintSalt } from "../../shared/util/fingerprint";
import { FIXED_TEST_SALT } from "../util/testSalt";

GlobalRegistrator.register();
// React refuses to flush act()-wrapped work outside a declared test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
initFingerprintSalt(FIXED_TEST_SALT);

// React reports real defects - duplicate keys, act() violations, controlled/
// uncontrolled flips - through console.error and nothing else, so a warning
// the runner discards is a defect the suite cannot see. The gate fails the
// test that emitted one; a test that expects an error must stub console.error
// itself (none does today).
const reportedErrors: string[] = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
	reportedErrors.push(args.map(String).join(" "));
	originalConsoleError(...args);
};
beforeEach(() => {
	reportedErrors.length = 0;
});
afterEach(() => {
	if (reportedErrors.length > 0) {
		const report = reportedErrors.splice(0).join("\n---\n");
		throw new Error(`console.error during this test (fix the cause or stub console.error):\n${report}`);
	}
});

const { installAcquireVsCodeApi } = await import("./webview/harness");
installAcquireVsCodeApi();
