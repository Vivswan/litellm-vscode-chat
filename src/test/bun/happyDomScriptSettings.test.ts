/**
 * happy-dom can reach child_process.execFileSync through synchronous script loading (SyncFetch behind a `<script src>`
 * once JavaScript evaluation is on), a spawn no test deadline covers. The preload turns that off from the first window
 * and pins the three script settings non-writable, and this proves the pin executed: a shape check over the preload's
 * source could not, since a pin moved into an uncalled function reads the same. The pin covers the one window the
 * suites share; a test that builds a second Window and turns script loading on there is deliberate, and out of scope.
 */

import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const SCRIPT_SETTINGS = ["disableJavaScriptFileLoading", "enableJavaScriptEvaluation", "disableJavaScriptEvaluation"];

const settings = (): Record<string, unknown> =>
	(window as unknown as { happyDOM: { settings: Record<string, unknown> } }).happyDOM.settings;

// No deadline: it reads the live window and spawns nothing.
test("the preload's happy-dom window keeps synchronous script loading off and pinned", () => {
	expect(GlobalRegistrator.isRegistered).toBe(true);
	expect(settings().disableJavaScriptFileLoading).toBe(true);
	expect(settings().enableJavaScriptEvaluation).toBe(false);
	expect(settings().disableJavaScriptEvaluation).toBe(false);
	for (const name of SCRIPT_SETTINGS) {
		const before = settings()[name];
		expect(Object.getOwnPropertyDescriptor(settings(), name)).toMatchObject({ writable: false, configurable: false });
		expect(() => {
			settings()[name] = !before;
		}).toThrow(TypeError);
		expect(() => Object.defineProperty(settings(), name, { value: !before })).toThrow(TypeError);
		expect(Reflect.set(settings(), name, !before)).toBe(false);
		expect(settings()[name]).toBe(before);
	}
});
