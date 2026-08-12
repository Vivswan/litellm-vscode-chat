/**
 * The scalar settings form: draft parsing and commit rules, the blur-gated
 * display of bound errors, the draftSyncKey resync contract, Reset naming and
 * posting, the modified-scope notes with their defaults, and the ms
 * equivalence hints.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "preact/test-utils";
import { isBoundViolation, NUMBER_SETTING_IDS, parseNumberDraft } from "../../../../dashboard/protocol";
import { App } from "../../../../webview/dashboard/app";
import { SettingsSection } from "../../../../webview/dashboard/settings";
import { makeSettings, makeState, statePush } from "../fixtures";
import {
	buttonByText,
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
	const input = settingInput(root, "discovery.timeout");

	// Mid-typing, an honest below-minimum draft raises no error yet...
	fireInput(input, "500");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
	expect(input.classList.contains("invalid")).toBe(false);
	// ...but blur reveals it, and the invalid draft still never commits.
	fireBlur(input);
	expect(rowOf(input).textContent).toContain("Must be at least 1000");
	expect(input.classList.contains("invalid")).toBe(true);
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);

	fireInput(input, "20480");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
	fireBlur(input);
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "discovery.timeout", value: 20480 }]);

	// A draft equal to the stored value posts nothing on commit.
	resetPosted();
	fireInput(input, "30000");
	fireBlur(input);
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);
});

test("Enter reveals a bound error like blur does; parse errors show live per keystroke", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "chat.timeout");

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

	// Parse failures never wait for blur: emptying the field shows on the
	// keystroke.
	const other = settingInput(root, "discovery.timeout");
	fireInput(other, "");
	expect(rowOf(other).textContent).toContain("Enter a number");
});

test("isBoundViolation classifies exactly parseNumberDraft's minimum-bound rejections, for every setting", () => {
	// The drift guard the display gating leans on: the two functions read the
	// draft with the same grammar (durations included on ms settings), so
	// "invalid because of the minimum" and isBoundViolation must agree on
	// every draft. Covers empties, whitespace, unparsable text, non-finite
	// numbers, values on both sides of every configured minimum (0 and
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
	const input = settingInput(root, "chat.timeout");

	// While a bound error is held back, assistive tech hears a valid field.
	fireInput(input, "500");
	expect(input.getAttribute("aria-invalid")).toBe("false");
	expect(input.getAttribute("aria-describedby")).toBe("setting-chat.timeout-unit");

	// Once revealed, the error element joins the description chain.
	fireBlur(input);
	expect(input.getAttribute("aria-invalid")).toBe("true");
	expect(input.getAttribute("aria-describedby")).toBe("setting-chat.timeout-unit setting-chat.timeout-error");
	expect(root.querySelector("#setting-chat\\.timeout-error")?.textContent).toBe("Must be at least 1000");
});

test("Enter commits a valid draft like blur does", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "discovery.timeout");
	fireInput(input, "45000");
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "discovery.timeout", value: 45000 }]);
});

test("an external state push resyncs a rejected draft and re-arms the calm start, including a scope-only change", () => {
	const root = mount(<App />);
	pushToWebview(statePush(makeState()));
	const input = settingInput(root, "chat.timeout");

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
						numbers: { ...scopeOnly.configuredScopes.numbers, "chat.timeout": "global" },
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
			numbers: { ...base.configuredScopes.numbers, "chat.timeout": "workspace" },
			booleans: base.configuredScopes.booleans,
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);

	const resets = Array.from(root.querySelectorAll("button.reset"));
	expect(resets.length).toBe(1);
	expect(resets[0]?.getAttribute("aria-label")).toBe("Remove the Workspace value of Request timeout");
	expect(rowOf(settingInput(root, "chat.timeout")).classList.contains("modified")).toBe(true);
	expect(rowOf(settingInput(root, "discovery.timeout")).classList.contains("modified")).toBe(false);

	fireClick(resets[0] as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "resetSetting", setting: "chat.timeout" }]);
});

test("the boolean checkbox posts setBooleanSetting with the toggled value", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const checkbox = settingInput(root, "ui.maskSecretInputs");
	expect(checkbox.checked).toBe(true);
	fireCheck(checkbox, false);
	expect(postedMessages).toEqual([{ type: "setBooleanSetting", setting: "ui.maskSecretInputs", value: false }]);
});

test("ms equivalence hints: 90000 reads as clock units, the zero-meaning settings read their special zero", () => {
	const settings = makeSettings({
		numbers: { ...makeSettings().numbers, "chat.timeout": 90000, "discovery.cacheTtl": 0, "usage.pollInterval": 0 },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);

	expect(rowOf(settingInput(root, "chat.timeout")).querySelector(".setting-equiv")?.textContent).toBe("= 1 min 30 s");
	expect(rowOf(settingInput(root, "discovery.cacheTtl")).querySelector(".setting-equiv")?.textContent).toBe(
		"= every refresh"
	);
	expect(rowOf(settingInput(root, "usage.pollInterval")).querySelector(".setting-equiv")?.textContent).toBe(
		"= polling off"
	);
	// The zero special case must not leak to other ms settings.
	expect(rowOf(settingInput(root, "discovery.timeout")).querySelector(".setting-equiv")?.textContent).toBe("= 30 s");
});

test("a modified row names its scope in the head; number rows add the default; clean rows carry no note", () => {
	const base = makeSettings();
	const settings = makeSettings({
		numbers: { ...base.numbers, "chat.timeout": 60000 },
		configuredScopes: {
			numbers: {
				...base.configuredScopes.numbers,
				"chat.timeout": "workspace",
			},
			booleans: { ...base.configuredScopes.booleans, "ui.maskSecretInputs": "global" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);

	const noteOf = (id: string) => rowOf(settingInput(root, id)).querySelector(".setting-modified-note");
	// The ms default reads in the duration idiom, matching the field's hint.
	expect(noteOf("chat.timeout")?.textContent).toBe("Modified in Workspace settings (default: 5 min)");
	// Boolean rows say where the value lives, without a default.
	expect(noteOf("ui.maskSecretInputs")?.textContent).toBe("Modified in User settings");
	// Unmodified rows carry no note at all, and the note lives in the head
	// (after the title), so its coming and going never shifts the row's text.
	expect(noteOf("discovery.timeout")).toBeNull();
	expect(noteOf("chat.timeout")?.closest(".setting-head")).not.toBeNull();
	expect(noteOf("chat.timeout")?.previousElementSibling).not.toBeNull();
});

test("the cache row's label needs no acronym", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	expect(rowOf(settingInput(root, "discovery.cacheTtl")).querySelector(".setting-title")?.textContent).toBe(
		"Discovery cache lifetime"
	);
});

test("settings-row help glyphs are named for their setting, so a button list is not a column of bare Helps", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const glyphOf = (id: string) => rowOf(settingInput(root, id)).querySelector("button.help");
	expect(glyphOf("chat.timeout")?.getAttribute("aria-label")).toBe("Help: Request timeout");
	expect(glyphOf("chat.promptCaching")?.getAttribute("aria-label")).toBe("Help: Prompt caching");
	// Call sites that pass no name keep the bare default: the section heading.
	const sectionGlyph = root.querySelector("h2 button.help");
	expect(sectionGlyph?.getAttribute("aria-label")).toBe("Help");
});

test("ms fields are text inputs (the duration suffixes need letters)", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	for (const id of ["chat.timeout", "discovery.timeout", "discovery.cacheTtl", "usage.pollInterval"]) {
		const input = settingInput(root, id);
		expect(input.getAttribute("type"), id).toBe("text");
		// min is a number-input constraint; the duration grammar owns the bound.
		expect(input.getAttribute("min"), id).toBeNull();
	}
});

test("a duration draft commits its millisecond value, with the equivalence hint live while typing", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "chat.timeout");

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
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "chat.timeout", value: 90000 }]);

	// A draft spelling the stored value differently ("90s" over 90000) still
	// counts as unchanged once committed: same value, no second post.
	resetPosted();
	const stored = makeSettings({ numbers: { ...makeSettings().numbers, "chat.timeout": 90000 } });
	const storedRoot = mount(<SettingsSection settings={stored} models={[]} failures={{}} />);
	const storedInput = settingInput(storedRoot, "chat.timeout");
	fireInput(storedInput, "90s");
	fireBlur(storedInput);
	expect(postedMessages).toEqual([]);
});

test("a unit typo reads as a live grammar error; a below-bound duration stays calm until blur", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const input = settingInput(root, "discovery.timeout");

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
	expect(postedMessages).toEqual([{ type: "setNumberSetting", setting: "discovery.timeout", value: 45000 }]);
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
	expect(rowOf(settingInput(root, "chat.timeout")).hidden).toBe(false);
	expect(rowOf(settingInput(root, "discovery.timeout")).hidden).toBe(false);
	expect(rowOf(settingInput(root, "usage.pollInterval")).hidden).toBe(true);
	expect(rowOf(settingInput(root, "ui.maskSecretInputs")).hidden).toBe(true);
	// A group with no visible rows collapses whole, heading included; the
	// hiding is the hidden attribute, never an unmount (the rows above were
	// still queryable).
	const groupOf = (id: string) => rowOf(settingInput(root, id)).closest(".settings-group") as HTMLElement;
	expect(groupOf("chat.timeout").hidden).toBe(false);
	expect(groupOf("ui.maskSecretInputs").hidden).toBe(true);
	// The record editor does not talk about timeouts.
	expect(editorSection(root, "Model parameters").hidden).toBe(true);

	// Descriptions match too: only the request timeout's mentions the chat call.
	fireInput(filter, "chat completion");
	expect(rowOf(settingInput(root, "chat.timeout")).hidden).toBe(false);
	expect(rowOf(settingInput(root, "discovery.timeout")).hidden).toBe(true);

	// Clearing the filter restores everything.
	fireInput(filter, "");
	expect(rowOf(settingInput(root, "ui.maskSecretInputs")).hidden).toBe(false);
	expect(groupOf("ui.maskSecretInputs").hidden).toBe(false);
	expect(editorSection(root, "Model parameters").hidden).toBe(false);
});

test("the filter matches the record editor by its key names (nested parameter names included) and title", () => {
	const settings = makeSettings({
		modelParameters: {
			editScope: "global",
			value: { "gpt-4": { temperature: 0.2 } },
			otherScopes: [],
			effective: { "gpt-4": { temperature: 0.2 } },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);
	const filter = root.querySelector<HTMLInputElement>(".filterbar input") as HTMLInputElement;

	// A nested parameter name keeps the parameters editor.
	fireInput(filter, "temperature");
	expect(editorSection(root, "Model parameters").hidden).toBe(false);

	// The editor's own title matches like a scalar row's label does.
	fireInput(filter, "model param");
	expect(editorSection(root, "Model parameters").hidden).toBe(false);

	// A pure miss hides it.
	fireInput(filter, "no such key");
	expect(editorSection(root, "Model parameters").hidden).toBe(true);
});

test("zero hits show the no-match line, and a dirty draft survives being filtered away and back", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const filter = root.querySelector<HTMLInputElement>(".filterbar input") as HTMLInputElement;
	const input = settingInput(root, "chat.timeout");

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
	const numberJump = jumpOf("chat.timeout");
	expect(numberJump?.getAttribute("aria-label")).toBe("Open Request timeout in settings.json");
	fireClick(numberJump as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "revealSetting", setting: "chat.timeout" }]);

	resetPosted();
	const booleanJump = jumpOf("chat.promptCaching");
	expect(booleanJump?.getAttribute("aria-label")).toBe("Open Prompt caching in settings.json");
	fireClick(booleanJump as HTMLButtonElement);
	expect(postedMessages).toEqual([{ type: "revealSetting", setting: "chat.promptCaching" }]);
});

test("the capabilities editor renders as a second record editor and applies via setModelCapabilities", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const section = editorSection(root, "Model capabilities");

	// Add matcher opens the full editor overlay; the row is built there.
	fireClick(buttonByText(section, "Add capability matcher"));
	const overlay = section.querySelector(".matcher-editor") as HTMLElement;
	fireInput(overlay.querySelector("input.key[placeholder^='Model ID or matcher']") as HTMLInputElement, "gpt-4*");
	fireClick(buttonByText(overlay, "Add capability"));
	fireInput(overlay.querySelector("input.key[placeholder^='Capability']") as HTMLInputElement, "context_length");
	fireInput(overlay.querySelector("input.value") as HTMLInputElement, "200000");

	resetPosted();
	fireClick(buttonByText(section, "Apply"));
	expect(postedMessages).toHaveLength(1);
	const posted = postedMessages[0] as { type: string; value: unknown; requestId: unknown };
	expect(posted.type).toBe("setModelCapabilities");
	expect(posted.value).toEqual({ "gpt-4*": { context_length: 200000 } });
	expect(typeof posted.requestId).toBe("string");
});

test("the catalog row states the snapshot's size and age, and Refresh posts refreshCatalog", () => {
	const now = Date.now();
	const settings = makeSettings({
		catalog: { modelCount: 321, lastSuccessAt: now - 5 * 60 * 1000, refreshing: false },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} now={now} />);
	const row = root.querySelector(".catalog-row") as HTMLElement;
	expect(row.textContent).toContain("321 catalog models");
	expect(row.textContent).toContain("updated 5 min ago");

	const refresh = buttonByText(row, "Refresh");
	expect(refresh.disabled).toBe(false);
	resetPosted();
	fireClick(refresh);
	expect(postedMessages).toEqual([{ type: "refreshCatalog" }]);
});

test("the catalog row without a refresh yet names the bundled snapshot; a running refresh disables the button", () => {
	const bundled = makeSettings({ catalog: { modelCount: 100, lastSuccessAt: undefined, refreshing: false } });
	const root = mount(<SettingsSection settings={bundled} models={[]} failures={{}} />);
	expect((root.querySelector(".catalog-row") as HTMLElement).textContent).toContain("bundled snapshot");

	cleanup();
	const refreshing = makeSettings({ catalog: { modelCount: 100, lastSuccessAt: undefined, refreshing: true } });
	const busyRoot = mount(<SettingsSection settings={refreshing} models={[]} failures={{}} />);
	const busyRow = busyRoot.querySelector(".catalog-row") as HTMLElement;
	const busy = Array.from(busyRow.querySelectorAll("button")).find((button) =>
		(button.textContent ?? "").includes("Refreshing...")
	) as HTMLButtonElement;
	expect(busy).toBeDefined();
	expect(busy.disabled).toBe(true);
});

test("with the catalog setting off the row shows the inert hint instead of the status and Refresh", () => {
	const base = makeSettings();
	const settings = makeSettings({
		booleans: { ...base.booleans, "models.openRouterCatalog": false },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);
	const row = root.querySelector(".catalog-row") as HTMLElement;
	expect(row.textContent).toContain("Catalog off:");
	expect(row.textContent).toContain("_openrouter_model");
	expect(Array.from(row.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim())).not.toContain("Refresh");
});

test("a standing catalog failure renders in the row with its classification, never as a toast", () => {
	const settings = makeSettings({
		catalog: {
			modelCount: 100,
			lastSuccessAt: Date.now() - 60 * 60 * 1000,
			lastFailure: { classification: "HTTP 503", at: Date.now() },
			refreshing: false,
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);
	const row = root.querySelector(".catalog-row") as HTMLElement;
	expect(row.querySelector(".error")?.textContent).toBe("Last refresh failed (HTTP 503); serving the cached snapshot.");
	expect(document.querySelector(".toast")).toBeNull();
});

test("the record editors live inside the Models group, mirroring the manifest's grouping", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const modelsGroup = Array.from(root.querySelectorAll(".settings-group")).find(
		(group) => group.querySelector(".settings-group-title")?.textContent === "Models"
	) as HTMLElement;
	expect(modelsGroup).toBeDefined();
	const headings = Array.from(modelsGroup.querySelectorAll("h3")).map((h) => (h.textContent ?? "").trim());
	expect(headings.some((h) => h.startsWith("Model parameters"))).toBe(true);
	expect(headings.some((h) => h.startsWith("Model capabilities"))).toBe(true);
	// The editors sit after the catalog row inside the group, and nowhere else.
	expect(root.querySelectorAll("h3.head-with-icons").length).toBe(2);
});

/** The two threshold boxes, addressed by their stable ids. */
function thresholdBoxes(root: ParentNode): { warning: HTMLInputElement; error: HTMLInputElement } {
	return {
		warning: settingInput(root, "usage.alertThresholds-warning"),
		error: settingInput(root, "usage.alertThresholds-error-at"),
	};
}

function settingsWithThresholds(alertThresholds: readonly number[]) {
	return makeSettings({
		usage: { statusBarMode: "always", statusBarScope: null, alertThresholds, thresholdsScope: null },
	});
}

test("the thresholds row renders the stored pair as percents and commits an edited pair sorted on blur", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const { warning, error } = thresholdBoxes(root);
	expect(warning.value).toBe("80%");
	expect(error.value).toBe("95%");

	// Sorting is the row's job: the lower value warns whichever box it sits in.
	fireInput(warning, "0.9");
	fireInput(error, "50%");
	fireBlur(error);
	expect(postedMessages).toEqual([{ type: "setUsageAlertThresholds", values: [0.5, 0.9] }]);

	// A draft equal to the stored list posts nothing on commit.
	resetPosted();
	fireInput(warning, "80%");
	fireInput(error, "0.95");
	fireKeyDown(error, "Enter");
	expect(postedMessages).toEqual([]);
});

test("thresholds accept fractions, percent signs, and bare numbers above 1 as percents", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const { warning, error } = thresholdBoxes(root);
	fireInput(warning, "75");
	fireInput(error, "0.9");
	fireBlur(warning);
	expect(postedMessages).toEqual([{ type: "setUsageAlertThresholds", values: [0.75, 0.9] }]);
});

test("a blur that only moves focus to the sibling box does not commit the half-edited pair", () => {
	// The two boxes are one draft: committing on the Tab between them would
	// let the write's own state push resync the pair mid-edit.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const { warning, error } = thresholdBoxes(root);
	fireInput(warning, "60%");
	void act(() => {
		warning.dispatchEvent(new FocusEvent("blur", { relatedTarget: error }));
	});
	expect(postedMessages).toEqual([]);

	// Leaving the pair commits once, with both edits.
	fireInput(error, "0.9");
	void act(() => {
		error.dispatchEvent(new FocusEvent("blur"));
	});
	expect(postedMessages).toEqual([{ type: "setUsageAlertThresholds", values: [0.6, 0.9] }]);
});

test("one filled box means error-at-that-value: a single-element list plus the inline hint", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const { warning, error } = thresholdBoxes(root);

	// Only Error set.
	fireInput(warning, "");
	fireInput(error, "90%");
	expect(rowOf(error).textContent).toContain("A single threshold goes straight to the error alert.");
	fireBlur(error);
	expect(postedMessages).toEqual([{ type: "setUsageAlertThresholds", values: [0.9] }]);

	// Only Warning set: same single-value semantics, same hint.
	resetPosted();
	fireInput(error, "");
	fireInput(warning, "60%");
	expect(rowOf(warning).textContent).toContain("A single threshold goes straight to the error alert.");
	fireBlur(warning);
	expect(postedMessages).toEqual([{ type: "setUsageAlertThresholds", values: [0.6] }]);
});

test("a stored single-element list fills the Error box, and equal boxes collapse to one value", () => {
	const single = mount(<SettingsSection settings={settingsWithThresholds([0.9])} models={[]} failures={{}} />);
	const boxes = thresholdBoxes(single);
	expect(boxes.warning.value).toBe("");
	expect(boxes.error.value).toBe("90%");
	expect(rowOf(boxes.error).textContent).toContain("A single threshold goes straight to the error alert.");

	cleanup();
	resetPosted();
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const { warning, error } = thresholdBoxes(root);
	fireInput(warning, "0.9");
	fireInput(error, "90%");
	fireBlur(error);
	expect(postedMessages).toEqual([{ type: "setUsageAlertThresholds", values: [0.9] }]);
});

test("both boxes emptied turns alerts off: an empty list with the row saying so", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const { warning, error } = thresholdBoxes(root);
	fireInput(warning, "");
	fireInput(error, "");
	expect(rowOf(error).textContent).toContain("Alerts are off.");
	fireBlur(error);
	expect(postedMessages).toEqual([{ type: "setUsageAlertThresholds", values: [] }]);
});

test("an invalid threshold shows its error live and never posts: 0, over 100%, and non-numbers reject", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const { warning, error } = thresholdBoxes(root);

	for (const bad of ["0", "150%", "101", "soon"]) {
		fireInput(warning, bad);
		expect(rowOf(warning).textContent).toContain("Thresholds run from above 0% to 100%");
		expect(warning.getAttribute("aria-invalid")).toBe("true");
		fireBlur(warning);
		fireKeyDown(error, "Enter");
		expect(postedMessages).toEqual([]);
	}
	// The valid box alone must not commit around the invalid one.
	expect(error.getAttribute("aria-invalid")).toBe("false");
});

test("a hand-written list of 3+ values renders read-only with the values, the hint, and the reveal button", () => {
	const settings = makeSettings({
		usage: {
			statusBarMode: "always",
			statusBarScope: null,
			alertThresholds: [0.5, 0.8, 0.95],
			thresholdsScope: "global",
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} failures={{}} />);
	const row = Array.from(root.querySelectorAll(".setting-row")).find((candidate) =>
		candidate.textContent?.includes("Usage alert thresholds")
	) as HTMLElement;
	expect(row.textContent).toContain("50%, 80%, 95%");
	expect(row.textContent).toContain("Custom list - edit in settings.json.");
	// No inputs: the two boxes cannot represent the list, and rendering them
	// would let a blur destroy the hand-written values.
	expect(row.querySelector("input")).toBeNull();
	expect(row.querySelector("button[aria-label='Open Usage alert thresholds in settings.json']")).not.toBeNull();
});

test("the status-bar mode select posts setUsageStatusBar on change", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const select = root.querySelector("#setting-usage\\.statusBar") as HTMLSelectElement;
	expect(select).not.toBeNull();
	expect(select.value).toBe("always");

	void act(() => {
		select.value = "alerts-only";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(postedMessages).toEqual([{ type: "setUsageStatusBar", value: "alerts-only" }]);
});

/** The Import & Export group, addressed as the last settings group (its pinned position). */
function importExportGroup(root: ParentNode): HTMLElement {
	const group = Array.from(root.querySelectorAll(".settings-group")).pop();
	if (!(group instanceof HTMLElement)) {
		throw new Error("no settings groups rendered");
	}
	return group;
}

test("the Import & Export group renders last with its hint, and each button posts exactly its command", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const group = importExportGroup(root);
	expect(group.querySelector(".settings-group-title")?.textContent).toBe("Import & Export");
	expect(group.querySelector("p.hint")?.textContent).toContain("Export writes your settings to a JSON file");

	const exportButton = buttonByText(group, "Export settings");
	const importButton = buttonByText(group, "Import settings");
	for (const button of [exportButton, importButton]) {
		expect(button.getAttribute("type")).toBe("button");
		expect(button.classList.contains("secondary")).toBe(true);
	}

	fireClick(exportButton);
	expect(postedMessages).toEqual([{ type: "executeCommand", command: "exportSettings" }]);
	resetPosted();
	fireClick(importButton);
	expect(postedMessages).toEqual([{ type: "executeCommand", command: "importSettings" }]);
});

test("the Import & Export group follows the filter: kept by its own words, hidden on a miss, counted by no-match", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} failures={{}} />);
	const filter = root.querySelector<HTMLInputElement>(".filterbar input") as HTMLInputElement;
	const group = importExportGroup(root);
	expect(group.hidden).toBe(false);

	// Its title and button labels match like a scalar row's label would - and
	// exclusively: no scalar label or description mentions "export", so every
	// scalar row hides while the group stays.
	fireInput(filter, "export");
	expect(group.hidden).toBe(false);
	expect(rowOf(settingInput(root, "chat.timeout")).hidden).toBe(true);
	expect(root.textContent).not.toContain("No settings match the filter.");

	// A scalar-only needle hides the group whole (hidden, never unmounted).
	fireInput(filter, "timeout");
	expect(group.hidden).toBe(true);

	// A pure miss counts the group out of the no-match verdict too.
	fireInput(filter, "no such setting");
	expect(root.textContent).toContain("No settings match the filter.");

	fireInput(filter, "");
	expect(group.hidden).toBe(false);
});
