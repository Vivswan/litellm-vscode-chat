/**
 * The scalar settings form: draft parsing and commit rules, the clear-vs-
 * invalid split for nullable settings, the blur-gated display of bound
 * errors, the draftSyncKey resync contract, Reset naming and posting, the
 * modified-scope notes with their defaults, and the ms equivalence hints.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { isBoundViolation, NUMBER_SETTING_IDS, parseNumberDraft } from "../../../extension/dashboard/protocol";
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

test("a below-minimum draft stays calm until blur reveals it; commit posts nothing; a valid draft posts once; unchanged posts nothing", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "defaultMaxOutputTokens");

	// Mid-typing, an honest below-minimum draft raises no error yet...
	fireInput(input, "0");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
	expect(input.classList.contains("invalid")).toBe(false);
	// ...but blur reveals it, and the invalid draft still never commits.
	fireBlur(input);
	expect(rowOf(input).textContent).toContain("Must be at least 1");
	expect(input.classList.contains("invalid")).toBe(true);
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

test("Enter reveals a bound error like blur does; parse errors show live per keystroke", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "requestTimeout");

	fireInput(input, "500");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
	fireKeyDown(input, "Enter");
	expect(rowOf(input).textContent).toContain("Must be at least 1000");
	expect(postedMessages).toEqual([]);
	// Once revealed, the bound verdict tracks every keystroke.
	fireInput(input, "999");
	expect(rowOf(input).textContent).toContain("Must be at least 1000");
	fireInput(input, "9999");
	expect(rowOf(input).textContent).not.toContain("Must be at least");

	// Parse failures never wait for blur: emptying a non-nullable field (the
	// number input sanitizes non-numeric text to empty) shows on the keystroke.
	const other = settingInput(root, "discoveryTimeout");
	fireInput(other, "");
	expect(rowOf(other).textContent).toContain("Enter a number");
});

test("isBoundViolation classifies exactly parseNumberDraft's minimum-bound rejections, for every setting", () => {
	// The drift guard the display gating leans on: the two functions read the
	// draft with the same trim-and-Number rules, so "invalid because of the
	// minimum" and isBoundViolation must agree on every draft. Covers empties,
	// whitespace, unparsable text, non-finite numbers, and values on both
	// sides of every configured minimum (0, 1, and 1000).
	const drafts = ["", "  ", "soon", "NaN", "Infinity", "1e999", "-5", "0", "0.5", "1", "999", "1000", " 300000 "];
	for (const id of NUMBER_SETTING_IDS) {
		for (const draft of drafts) {
			const parse = parseNumberDraft(id, draft);
			const boundRejected = parse.kind === "invalid" && parse.problem.startsWith("Must be at least");
			expect(isBoundViolation(id, draft), `${id} ${JSON.stringify(draft)}`).toBe(boundRejected);
		}
	}
});

test("aria-invalid and the error's aria-describedby wiring follow the displayed error, not the raw verdict", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "requestTimeout");

	// While a bound error is held back, assistive tech hears a valid field.
	fireInput(input, "500");
	expect(input.getAttribute("aria-invalid")).toBe("false");
	expect(input.getAttribute("aria-describedby")).toBe("setting-requestTimeout-unit");

	// Once revealed, the error element joins the description chain.
	fireBlur(input);
	expect(input.getAttribute("aria-invalid")).toBe("true");
	expect(input.getAttribute("aria-describedby")).toBe("setting-requestTimeout-unit setting-requestTimeout-error");
	expect(root.querySelector("#setting-requestTimeout-error")?.textContent).toBe("Must be at least 1000");
});

test("Enter commits a valid draft like blur does", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "discoveryTimeout");
	fireInput(input, "45000");
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "discoveryTimeout", value: 45000 }]);
});

test("clearing nullable defaultMaxInputTokens posts null only when a value was set; a non-nullable empty shows 'Enter a number'", () => {
	const configured = makeSettings({
		numbers: { ...makeSettings().numbers, defaultMaxInputTokens: 4096 },
	});
	const root = mount(<SettingsSection settings={configured} models={[]} failures={{}} />);
	const input = settingInput(root, "defaultMaxInputTokens");
	expect(input.value).toBe("4096");
	fireInput(input, "");
	fireBlur(input);
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "defaultMaxInputTokens", value: null }]);

	// Already unset: clearing again writes nothing.
	resetPosted();
	const unsetRoot = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
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

test("an external state push resyncs a rejected draft and re-arms the calm start, including a scope-only change", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const input = settingInput(root, "requestTimeout");

	fireInput(input, "1"); // below MIN_TIMEOUT_MS
	fireBlur(input);
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
	// The resync also re-armed the blur latch: a fresh below-minimum draft
	// stays calm again until the next blur.
	fireInput(input, "1");
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
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);

	const resets = Array.from(root.querySelectorAll("button.reset"));
	expect(resets.length).toBe(1);
	expect(resets[0]?.getAttribute("aria-label")).toBe("Remove the Workspace value of Request timeout");
	expect(rowOf(settingInput(root, "requestTimeout")).classList.contains("modified")).toBe(true);
	expect(rowOf(settingInput(root, "discoveryTimeout")).classList.contains("modified")).toBe(false);

	fireClick(resets[0] as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "resetSetting", setting: "requestTimeout" }]);
});

test("the boolean checkbox posts setBooleanSetting with the toggled value", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const checkbox = settingInput(root, "maskApiKeyInput");
	expect(checkbox.checked).toBe(true);
	fireCheck(checkbox, false);
	expect(postedMessages).toEqual([{ type: "setBooleanSetting", setting: "maskApiKeyInput", value: false }]);
});

test("ms equivalence hints: 90000 reads as clock units, TTL 0 as its zero meaning, token units render none", () => {
	const settings = makeSettings({
		numbers: { ...makeSettings().numbers, requestTimeout: 90000, discoveryCacheTtl: 0 },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);

	expect(rowOf(settingInput(root, "requestTimeout")).querySelector(".setting-equiv")?.textContent).toBe("= 1 min 30 s");
	expect(rowOf(settingInput(root, "discoveryCacheTtl")).querySelector(".setting-equiv")?.textContent).toBe(
		"= every refresh"
	);
	// The zero special case must not leak to other ms settings, and token
	// counts get no equivalence at all.
	expect(rowOf(settingInput(root, "discoveryTimeout")).querySelector(".setting-equiv")?.textContent).toBe("= 30 s");
	expect(rowOf(settingInput(root, "defaultMaxOutputTokens")).querySelector(".setting-equiv")).toBeNull();
});

test("a modified row names its scope in the head; number rows add the default; clean rows carry no note", () => {
	const base = makeSettings();
	const settings = makeSettings({
		numbers: { ...base.numbers, requestTimeout: 60000, defaultMaxInputTokens: 4096 },
		configuredScopes: {
			numbers: {
				...base.configuredScopes.numbers,
				requestTimeout: "workspace",
				defaultMaxInputTokens: "workspaceFolder",
			},
			booleans: { ...base.configuredScopes.booleans, maskApiKeyInput: "global" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);

	const noteOf = (id: string) => rowOf(settingInput(root, id)).querySelector(".setting-modified-note");
	expect(noteOf("requestTimeout")?.textContent).toBe("Modified in Workspace settings (default: 300000)");
	// The one null spec default is derived per model at request time; the note
	// says so instead of inventing a number.
	expect(noteOf("defaultMaxInputTokens")?.textContent).toBe("Modified in Workspace folder settings (default: derived)");
	// Boolean rows say where the value lives, without a default.
	expect(noteOf("maskApiKeyInput")?.textContent).toBe("Modified in User settings");
	// Unmodified rows carry no note at all, and the note lives in the head
	// (after the title), so its coming and going never shifts the row's text.
	expect(noteOf("discoveryTimeout")).toBeNull();
	expect(noteOf("requestTimeout")?.closest(".setting-head")).not.toBeNull();
	expect(noteOf("requestTimeout")?.previousElementSibling).not.toBeNull();
});

test("the nullable input spells out its empty reading, and the cache row's label needs no acronym", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	expect(settingInput(root, "defaultMaxInputTokens").getAttribute("placeholder")).toBe("derived from context length");
	// Non-nullable inputs carry no placeholder: empty is invalid there, never derived.
	expect(settingInput(root, "defaultContextLength").getAttribute("placeholder")).toBeNull();
	expect(rowOf(settingInput(root, "discoveryCacheTtl")).querySelector(".setting-title")?.textContent).toBe(
		"Discovery cache lifetime"
	);
});

test("settings-row help glyphs are named for their setting, so a button list is not a column of bare Helps", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const glyphOf = (id: string) => rowOf(settingInput(root, id)).querySelector("button.help");
	expect(glyphOf("requestTimeout")?.getAttribute("aria-label")).toBe("Help: Request timeout");
	expect(glyphOf("promptCaching.enabled")?.getAttribute("aria-label")).toBe("Help: Prompt caching");
	// Call sites that pass no name keep the bare default: the section heading.
	const sectionGlyph = root.querySelector("h2 button.help");
	expect(sectionGlyph?.getAttribute("aria-label")).toBe("Help");
});
