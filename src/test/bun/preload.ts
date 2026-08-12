/**
 * Preload for the bun test tree (wired via bunfig.toml), loaded before any
 * test module. The tree's rule: suites that need no extension host live here
 * - the pure logic and property suites and the DOM component tests; real
 * network machinery (msw) stays host-side in the Mocha suites.
 * Three process-global concerns live here so no suite can forget them:
 * happy-dom registration, the fixed fingerprint salt (suites here compute
 * fingerprints without running activation's salt load), and the
 * acquireVsCodeApi stub (vscodeApi.ts calls acquireVsCodeApi() at module top
 * level, so a component import without the stub is an import-time crash;
 * harmless for non-DOM suites). The harness is imported dynamically so the
 * DOM registration above runs first (static imports would hoist past it).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { initFingerprintSalt } from "../../shared/util/fingerprint";
import { FIXED_TEST_SALT } from "../util/testSalt";

GlobalRegistrator.register();
initFingerprintSalt(FIXED_TEST_SALT);

const { installAcquireVsCodeApi } = await import("./webview/harness");
installAcquireVsCodeApi();
