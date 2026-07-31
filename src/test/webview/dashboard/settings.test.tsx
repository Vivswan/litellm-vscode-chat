/**
 * The scalar settings form: draft parsing and commit rules, the clear-vs-
 * invalid split for nullable settings, the draftSyncKey resync contract,
 * Reset naming and posting, and the ms equivalence hints.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "../../../webview/dashboard/app";
import { SettingsSection } from "../../../webview/dashboard/settings";
import { makeSettings, makeState, statePush } from "../fixtures";
import {
	cleanup,
	fireBlur,
	fireCheck,
	fireClick,
	fireInput,
	fireKeyDown,
	mount,
	postedMessages,
	pushToWebview,
	resetPosted,
} from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

function settingInput(root: ParentNode, id: string): HTMLInputElement {
	const input = root.querySelector(`#setting-${CSS.escape(id)}`);
	if (!(input instanceof HTMLInputElement)) {
		throw new Error(`no input for setting ${id}`);
	}
	return input;
}

function rowOf(input: HTMLElement): HTMLElement {
	const row = input.closest(".setting-row");
	if (!(row instanceof HTMLElement)) {
		throw new Error("input is not inside a setting row");
	}
	return row;
}

test("a draft below the minimum shows the problem and commit posts nothing; a valid draft posts once; unchanged posts nothing", () => {
	const root = mount(<SettingsSection settings={makeSettings()} failures={{}} />);
	const input = settingInput(root, "defaultMaxOutputTokens");

	fireInput(input, "0");
	expect(rowOf(input).textContent).toContain("Must be at least 1");
	fireBlur(input);
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);

	fireInput(input, "2048");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
	fireBlur(input);
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "defaultMaxOutputTokens", value: 2048 }]);

	// A draft equal to the stored value posts nothing on commit.
	resetPosted();
	fireInput(input, "16000");
	fireBlur(input);
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);
});

test("Enter commits a valid draft like blur does", () => {
	const root = mount(<SettingsSection settings={makeSettings()} failures={{}} />);
	const input = settingInput(root, "discoveryTimeout");
	fireInput(input, "45000");
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "discoveryTimeout", value: 45000 }]);
});

test("clearing nullable defaultMaxInputTokens posts null only when a value was set; a non-nullable empty shows 'Enter a number'", () => {
	const configured = makeSettings({
		numbers: { ...makeSettings().numbers, defaultMaxInputTokens: 4096 },
	});
	const root = mount(<SettingsSection settings={configured} failures={{}} />);
	const input = settingInput(root, "defaultMaxInputTokens");
	expect(input.value).toBe("4096");
	fireInput(input, "");
	fireBlur(input);
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "defaultMaxInputTokens", value: null }]);

	// Already unset: clearing again writes nothing.
	resetPosted();
	const unsetRoot = mount(<SettingsSection settings={makeSettings()} failures={{}} />);
	const unsetInput = settingInput(unsetRoot, "defaultMaxInputTokens");
	fireInput(unsetInput, "");
	fireBlur(unsetInput);
	expect(postedMessages).toEqual([]);

	// Non-nullable: empty is invalid, never a clear.
	const contextInput = settingInput(unsetRoot, "defaultContextLength");
	fireInput(contextInput, "");
	expect(rowOf(contextInput).textContent).toContain("Enter a number");
	fireBlur(contextInput);
	expect(postedMessages).toEqual([]);
});

test("an external state push resyncs a rejected draft, including a scope-only change with an unchanged value", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const input = settingInput(root, "requestTimeout");

	fireInput(input, "1"); // below MIN_TIMEOUT_MS
	expect(rowOf(input).textContent).toContain("Must be at least");

	// The push changes only the configured scope (a reset of a value pinned to
	// its default); the stale rejected draft must resync anyway.
	const scopeOnly = makeSettings();
	pushToWebview(
		statePush(
			makeState({
				settings: {
					...scopeOnly,
					configuredScopes: {
						...scopeOnly.configuredScopes,
						numbers: { ...scopeOnly.configuredScopes.numbers, requestTimeout: "global" },
					},
				},
			})
		)
	);
	expect(input.value).toBe("300000");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
});

test("Reset renders only on configured rows, carries the scope-naming accessible name, and posts resetSetting", () => {
	const base = makeSettings();
	const settings = makeSettings({
		configuredScopes: {
			numbers: { ...base.configuredScopes.numbers, requestTimeout: "workspace" },
			booleans: base.configuredScopes.booleans,
		},
	});
	const root = mount(<SettingsSection settings={settings} failures={{}} />);

	const resets = Array.from(root.querySelectorAll("button.reset"));
	expect(resets.length).toBe(1);
	expect(resets[0]?.getAttribute("aria-label")).toBe("Remove the Workspace value of Request timeout");
	expect(rowOf(settingInput(root, "requestTimeout")).classList.contains("modified")).toBe(true);
	expect(rowOf(settingInput(root, "discoveryTimeout")).classList.contains("modified")).toBe(false);

	fireClick(resets[0] as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "resetSetting", setting: "requestTimeout" }]);
});

test("the boolean checkbox posts setBooleanSetting with the toggled value", () => {
	const root = mount(<SettingsSection settings={makeSettings()} failures={{}} />);
	const checkbox = settingInput(root, "maskApiKeyInput");
	expect(checkbox.checked).toBe(true);
	fireCheck(checkbox, false);
	expect(postedMessages).toEqual([{ type: "setBooleanSetting", setting: "maskApiKeyInput", value: false }]);
});

test("ms equivalence hints: 90000 reads as clock units, TTL 0 as its zero meaning, token units render none", () => {
	const settings = makeSettings({
		numbers: { ...makeSettings().numbers, requestTimeout: 90000, discoveryCacheTtl: 0 },
	});
	const root = mount(<SettingsSection settings={settings} failures={{}} />);

	expect(rowOf(settingInput(root, "requestTimeout")).querySelector(".setting-equiv")?.textContent).toBe("= 1 min 30 s");
	expect(rowOf(settingInput(root, "discoveryCacheTtl")).querySelector(".setting-equiv")?.textContent).toBe(
		"= every refresh"
	);
	// The zero special case must not leak to other ms settings, and token
	// counts get no equivalence at all.
	expect(rowOf(settingInput(root, "discoveryTimeout")).querySelector(".setting-equiv")?.textContent).toBe("= 30 s");
	expect(rowOf(settingInput(root, "defaultMaxOutputTokens")).querySelector(".setting-equiv")).toBeNull();
});
