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
	// draft with the same grammar (durations included on ms settings), so
	// "invalid because of the minimum" and isBoundViolation must agree on
	// every draft. Covers empties, whitespace, unparsable text, non-finite
	// numbers, values on both sides of every configured minimum (0, 1, and
	// 1000), and the duration grammar's suffixes, typos, and bare suffixes.
	const drafts = [
		"",
		"  ",
		"soon",
		"NaN",
		"Infinity",
		"1e999",
		"-5",
		"0",
		"0.5",
		"1",
		"999",
		"1000",
		" 300000 ",
		"500ms",
		"999ms",
		"1000ms",
		"0.5s",
		"1s",
		"90s",
		"5m",
		" 5 M ",
		"1.5h",
		"-1s",
		"0s",
		"ms",
		"h",
		"5 min",
		"5d",
		"1e999s",
		"9e307h",
	];
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
	// The ms default reads in the duration idiom, matching the field's hint.
	expect(noteOf("requestTimeout")?.textContent).toBe("Modified in Workspace settings (default: 5 min)");
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

test("ms fields are text inputs (the duration suffixes need letters); token fields stay number inputs", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	for (const id of ["requestTimeout", "discoveryTimeout", "discoveryCacheTtl"]) {
		const input = settingInput(root, id);
		expect(input.getAttribute("type"), id).toBe("text");
		// min is a number-input constraint; the duration grammar owns the bound.
		expect(input.getAttribute("min"), id).toBeNull();
	}
	for (const id of ["defaultMaxOutputTokens", "defaultContextLength", "defaultMaxInputTokens"]) {
		expect(settingInput(root, id).getAttribute("type"), id).toBe("number");
		expect(settingInput(root, id).getAttribute("min"), id).not.toBeNull();
	}
});

test("a duration draft commits its millisecond value, with the equivalence hint live while typing", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "requestTimeout");

	fireInput(input, "5m");
	expect(rowOf(input).querySelector(".setting-equiv")?.textContent).toBe("= 5 min");
	// "5m" IS the stored 300000, so committing it posts nothing (the
	// unchanged-posts-nothing rule sees through the spelling)...
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);

	// ...while a real change posts the milliseconds the suffix scales to.
	fireInput(input, "90s");
	expect(rowOf(input).querySelector(".setting-equiv")?.textContent).toBe("= 1 min 30 s");
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "requestTimeout", value: 90000 }]);

	// A draft spelling the stored value differently ("90s" over 90000) still
	// counts as unchanged once committed: same value, no second post.
	resetPosted();
	const stored = makeSettings({ numbers: { ...makeSettings().numbers, requestTimeout: 90000 } });
	const storedRoot = mount(<SettingsSection settings={stored} models={[]} failures={{}} />);
	const storedInput = settingInput(storedRoot, "requestTimeout");
	fireInput(storedInput, "90s");
	fireBlur(storedInput);
	expect(postedMessages).toEqual([]);
});

test("a unit typo reads as a live grammar error; a below-bound duration stays calm until blur", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "discoveryTimeout");

	// A suffixed value below the bound is an honest mid-typing state ("500ms"
	// on the way to "1500ms"), so it keeps the blur gate plain numbers get.
	// This runs before any settle: the first blur arms the reveal latch.
	fireInput(input, "500ms");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
	fireBlur(input);
	expect(rowOf(input).textContent).toContain("Must be at least 1000");
	expect(postedMessages).toEqual([]);

	// Typos never wait for blur: the grammar verdict tracks every keystroke.
	fireInput(input, "5 min");
	expect(rowOf(input).textContent).toContain("Not a duration - use ms, s, m, or h");
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);

	fireInput(input, "45s");
	fireBlur(input);
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "discoveryTimeout", value: 45000 }]);
});

/** The <section> whose h3 heading starts with the title (the heading also carries its glyphs). */
function editorSection(root: ParentNode, heading: string): HTMLElement {
	const section = Array.from(root.querySelectorAll("section")).find((candidate) =>
		(candidate.querySelector("h3")?.textContent ?? "").trim().startsWith(heading)
	);
	if (!(section instanceof HTMLElement)) {
		throw new Error(`no section titled ${heading}`);
	}
	return section;
}

test("the filter hides rows by label or description match and collapses emptied groups, all via hidden", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const filter = root.querySelector<HTMLInputElement>(".filterbar input");
	if (filter === null) {
		throw new Error("no filter input");
	}
	expect(filter.getAttribute("placeholder")).toBe("Filter settings, e.g. timeout");

	fireInput(filter, "timeout");
	// Label matches survive; pure misses hide.
	expect(rowOf(settingInput(root, "requestTimeout")).hidden).toBe(false);
	expect(rowOf(settingInput(root, "discoveryTimeout")).hidden).toBe(false);
	expect(rowOf(settingInput(root, "defaultMaxInputTokens")).hidden).toBe(true);
	expect(rowOf(settingInput(root, "maskApiKeyInput")).hidden).toBe(true);
	// A group with no visible rows collapses whole, heading included; the
	// hiding is the hidden attribute, never an unmount (the rows above were
	// still queryable).
	const groupOf = (id: string) => rowOf(settingInput(root, id)).closest(".settings-group") as HTMLElement;
	expect(groupOf("requestTimeout").hidden).toBe(false);
	expect(groupOf("maskApiKeyInput").hidden).toBe(true);
	// Neither record editor talks about timeouts.
	expect(editorSection(root, "Model parameters").hidden).toBe(true);
	expect(editorSection(root, "Custom headers").hidden).toBe(true);

	// Descriptions match too: only the request timeout's mentions the chat call.
	fireInput(filter, "chat completion");
	expect(rowOf(settingInput(root, "requestTimeout")).hidden).toBe(false);
	expect(rowOf(settingInput(root, "discoveryTimeout")).hidden).toBe(true);

	// Clearing the filter restores everything.
	fireInput(filter, "");
	expect(rowOf(settingInput(root, "maskApiKeyInput")).hidden).toBe(false);
	expect(groupOf("maskApiKeyInput").hidden).toBe(false);
	expect(editorSection(root, "Custom headers").hidden).toBe(false);
});

test("the filter matches the record editors by their key names (nested parameter names included) and titles", () => {
	const settings = makeSettings({
		modelParameters: {
			editScope: "global",
			value: { "gpt-4": { temperature: 0.2 } },
			otherScopes: [],
			effective: { "gpt-4": { temperature: 0.2 } },
		},
		headers: {
			editScope: "global",
			value: { "x-litellm-api-key": "v" },
			otherScopes: [],
			effective: { "x-litellm-api-key": "v" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);
	const filter = root.querySelector<HTMLInputElement>(".filterbar input") as HTMLInputElement;

	// A header name keeps the headers editor; the parameters editor goes.
	fireInput(filter, "litellm-api");
	expect(editorSection(root, "Custom headers").hidden).toBe(false);
	expect(editorSection(root, "Model parameters").hidden).toBe(true);

	// A nested parameter name keeps the parameters editor.
	fireInput(filter, "temperature");
	expect(editorSection(root, "Model parameters").hidden).toBe(false);
	expect(editorSection(root, "Custom headers").hidden).toBe(true);

	// The editor's own title matches like a scalar row's label does.
	fireInput(filter, "custom head");
	expect(editorSection(root, "Custom headers").hidden).toBe(false);
});

test("zero hits show the no-match line, and a dirty draft survives being filtered away and back", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const filter = root.querySelector<HTMLInputElement>(".filterbar input") as HTMLInputElement;
	const input = settingInput(root, "requestTimeout");

	// A half-typed (and even rejected) draft...
	fireInput(input, "5x");
	fireInput(filter, "no such setting");
	expect(root.textContent).toContain("No settings match the filter.");
	expect(rowOf(input).hidden).toBe(true);

	// ...survives the round trip: hidden, never unmounted.
	fireInput(filter, "");
	expect(root.textContent).not.toContain("No settings match the filter.");
	expect(input.value).toBe("5x");
	expect(postedMessages).toEqual([]);
});

test("every scalar row carries a settings.json jump that posts revealSetting with its id", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);

	const jumpOf = (id: string) => rowOf(settingInput(root, id)).querySelector("button.reveal-json");
	const numberJump = jumpOf("requestTimeout");
	expect(numberJump?.getAttribute("aria-label")).toBe("Open Request timeout in settings.json");
	fireClick(numberJump as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "revealSetting", setting: "requestTimeout" }]);

	resetPosted();
	const booleanJump = jumpOf("promptCaching.enabled");
	expect(booleanJump?.getAttribute("aria-label")).toBe("Open Prompt caching in settings.json");
	fireClick(booleanJump as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "revealSetting", setting: "promptCaching.enabled" }]);
});

test("the model-defaults group carries the deprecation hint pointing at modelCapabilities", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const group = [...root.querySelectorAll(".settings-group")].find((el) =>
		el.querySelector(".settings-group-title")?.textContent?.includes("Model defaults")
	);
	const hint = group?.querySelector("p.hint");
	expect(hint?.textContent).toContain("Deprecated");
	expect(hint?.textContent).toContain("modelCapabilities");
});
