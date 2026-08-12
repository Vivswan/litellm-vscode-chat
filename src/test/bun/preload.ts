/**
 * Preload for the bun test tree (wired via bunfig.toml), loaded before any
 * test module. The tree's rule: suites that need no extension host live here
 * - the pure logic and property suites and the DOM component tests; real
 * network machinery (msw) stays host-side in the Mocha suites.
 * The process-global concerns live here so no suite can forget them:
 * happy-dom registration, the fixed fingerprint salt (suites here compute
 * fingerprints without running activation's salt load), the two DOM fidelity
 * patches below (happy-dom disagreeing with browsers about <details>), the
 * acquireVsCodeApi stub (vscodeApi.ts calls acquireVsCodeApi() at module top
 * level, so a component import without the stub is an import-time crash;
 * harmless for non-DOM suites), and the console.error gate below. The harness
 * is imported dynamically so the DOM registration above runs first (static
 * imports would hoist past it).
 */
import { afterEach, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { initFingerprintSalt } from "../../shared/util/fingerprint";
import { FIXED_TEST_SALT } from "../util/testSalt";

GlobalRegistrator.register();
// React refuses to flush act()-wrapped work outside a declared test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
initFingerprintSalt(FIXED_TEST_SALT);

/**
 * Two places where happy-dom disagrees with a browser about <details>, both
 * of which Radix's focus trap reads directly. A hand-rolled trap that matched
 * `summary` as a CSS selector and filtered collapsed content itself never had
 * to ask, so these gaps only surface once the trap is the platform's.
 */

/**
 * A <details>'s own <summary> is focusable in every browser - it is the
 * element that toggles the disclosure - but happy-dom reports tabIndex -1 for
 * it, so the summary would silently drop out of the trap and Tab would appear
 * to escape the dialog.
 */
const tabIndexDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "tabIndex");
if (tabIndexDescriptor?.get !== undefined) {
	const readTabIndex = tabIndexDescriptor.get;
	Object.defineProperty(HTMLElement.prototype, "tabIndex", {
		...tabIndexDescriptor,
		get(this: HTMLElement): number {
			if (this.tagName === "SUMMARY" && !this.hasAttribute("tabindex") && this.parentElement?.tagName === "DETAILS") {
				return 0;
			}
			return readTabIndex.call(this) as number;
		},
	});
}

/**
 * happy-dom implements Element.checkVisibility for CSS, but ships no UA
 * stylesheet for <details>, so it reports a control inside a collapsed
 * disclosure as visible where Chrome refuses to render or focus it. Only that
 * gap is filled; the CSS answer stays happy-dom's.
 */
const domCheckVisibility = Element.prototype.checkVisibility;
Element.prototype.checkVisibility = function checkVisibility(this: Element, options?: CheckVisibilityOptions): boolean {
	if (!domCheckVisibility.call(this, options)) {
		return false;
	}
	for (let node: Element | null = this; node !== null; node = node.parentElement) {
		const parent = node.parentElement;
		if (parent?.tagName === "DETAILS" && !(parent as HTMLDetailsElement).open && node.tagName !== "SUMMARY") {
			return false;
		}
	}
	return true;
};

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
