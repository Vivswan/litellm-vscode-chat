/**
 * The inline-completions and commit-generation settings rows: the shared model picker
 * (declared-only options, writes, the dangling warning's covering contract), the
 * language-list rows, and the commit prompt row.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { SettingsSection } from "../../../../webview/dashboard/settings";
import { makeSettings } from "../../../dashboardSettingsFixture";
import { makeModel } from "../fixtures";
import { cleanup, fireBlur, fireInput, fireSelect, mount, postedCalls, resetPosted } from "../harness";

beforeEach(() => {
	resetPosted();
});
afterEach(() => {
	cleanup();
});

const MODELS = [
	makeModel({ id: "gpt-test", rawId: "gpt-test", serverLabel: "Prod" }),
	makeModel({ id: "codestral", rawId: "codestral", name: "Codestral", serverLabel: "Prod" }),
	// The same raw ID under a second claimant label stays a distinct option;
	// an exact duplicate pair collapses.
	makeModel({ id: "gpt-test", rawId: "gpt-test", serverLabel: "Gateway" }),
	makeModel({ id: "gpt-test", rawId: "gpt-test", serverLabel: "Prod" }),
];

const DECLARED = ["Prod", "Gateway"];

function selectOf(root: ParentNode, settingId: string): HTMLSelectElement {
	const select = root.querySelector(`#setting-${CSS.escape(settingId)}`);
	if (!(select instanceof HTMLSelectElement)) {
		throw new Error(`no select for setting ${settingId}`);
	}
	return select;
}

function inputOf(root: ParentNode, settingId: string): HTMLInputElement {
	const input = root.querySelector(`#setting-${CSS.escape(settingId)}`);
	if (!(input instanceof HTMLInputElement)) {
		throw new Error(`no input for setting ${settingId}`);
	}
	return input;
}

function rowOf(element: HTMLElement): HTMLElement {
	const row = element.closest(".setting-row");
	if (!(row instanceof HTMLElement)) {
		throw new Error("element is not inside a setting row");
	}
	return row;
}

test("the model picker offers Not set plus the deduplicated (server, model) pairs, once per claimant label", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={MODELS} declaredServerLabels={DECLARED} />);
	const select = selectOf(root, "inlineCompletions.model");
	const labels = [...select.options].map((option) => option.textContent);
	expect(labels).toEqual(["Not set", "Prod: gpt-test", "Prod: codestral", "Gateway: gpt-test"]);
	// Unset renders the Not set choice selected and no warning.
	expect(select.value).toBe("");
	expect(rowOf(select).querySelector(".setting-hint .error")).toBeNull();
});

test("only declared entries' models are offered: an external group's label mints no option", () => {
	// A ref addresses a servers-entry label, which external groups do not have,
	// so their models must never be offered as picks.
	const root = mount(<SettingsSection settings={makeSettings()} models={MODELS} declaredServerLabels={["Prod"]} />);
	const labels = [...selectOf(root, "inlineCompletions.model").options].map((option) => option.textContent);
	expect(labels).toEqual(["Not set", "Prod: gpt-test", "Prod: codestral"]);
	// And with no declared labels at all (the prop's fail-closed default), only Not set remains.
	cleanup();
	const bare = mount(<SettingsSection settings={makeSettings()} models={MODELS} />);
	expect([...selectOf(bare, "commitGeneration.model").options].map((option) => option.textContent)).toEqual([
		"Not set",
	]);
});

test("picking a model sends setFeatureModel with the feature and ref; Not set sends null", () => {
	const settings = makeSettings({
		featureModels: { inlineCompletions: null, commitGeneration: { server: "Prod", model: "codestral" } },
		featureModelScopes: { inlineCompletions: null, commitGeneration: "global" },
	});
	const root = mount(<SettingsSection settings={settings} models={MODELS} declaredServerLabels={DECLARED} />);

	// Option values are the (server, model) identity itself (a JSON tuple), so
	// a pick is total by construction - never an index that could silently miss.
	fireSelect(selectOf(root, "inlineCompletions.model"), JSON.stringify(["Prod", "codestral"]));
	fireSelect(selectOf(root, "commitGeneration.model"), "");

	expect(postedCalls()).toEqual([
		{
			method: "setFeatureModel",
			payload: { feature: "inlineCompletions", value: { server: "Prod", model: "codestral" } },
		},
		{ method: "setFeatureModel", payload: { feature: "commitGeneration", value: null } },
	]);
});

test("a configured ref stays selected and quiet while a declared server serves it", () => {
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Gateway", model: "gpt-test" }, commitGeneration: null },
		featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
	});
	const root = mount(<SettingsSection settings={settings} models={MODELS} declaredServerLabels={DECLARED} />);
	const select = selectOf(root, "inlineCompletions.model");
	expect(select.selectedOptions[0]?.textContent).toBe("Gateway: gpt-test");
	expect(select.getAttribute("aria-invalid")).toBe("false");
	expect(rowOf(select).querySelector(".setting-hint .error")).toBeNull();
});

test("a dangling ref keeps its option, wears the covering warning, and never changes the row's structure", () => {
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Prod", model: "gone-model" }, commitGeneration: null },
		featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
	});
	const root = mount(<SettingsSection settings={settings} models={MODELS} declaredServerLabels={DECLARED} />);
	const select = selectOf(root, "inlineCompletions.model");
	// The configured pair is synthesized into the options so the pick stays
	// visible and keepable; its rendered text is the same vocabulary as every
	// served option, so toggling served <-> dangling redraws nothing else.
	expect(select.selectedOptions[0]?.textContent).toBe("Prod: gone-model");
	expect(select.getAttribute("aria-invalid")).toBe("true");
	// The warning rides the covered-description slot (the height-keeping
	// overlay), never a new block: check-geometry pins the no-move claim.
	const hint = rowOf(select).querySelector(".setting-hint");
	expect(hint?.classList.contains("setting-covered")).toBe(true);
	expect(hint?.querySelector(".setting-cover .error")?.textContent).toContain("no longer available");
	// Keeping the dangling pick selected again is a no-op, never a write.
	fireSelect(select, select.value);
	expect(postedCalls()).toEqual([]);
});

test("a standing write failure outranks the dangling warning in the covered slot", () => {
	// The dangling warning never clears on its own, so if it kept the slot a
	// refused setFeatureModel write would stay invisible on exactly the row
	// that posted it.
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Prod", model: "gone-model" }, commitGeneration: null },
		featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
	});
	const root = mount(
		<SettingsSection
			settings={settings}
			models={MODELS}
			declaredServerLabels={DECLARED}
			writeFailures={{
				setFeatureModel: { seq: 1, row: "inlineCompletions.model", message: "refused by the extension" },
			}}
		/>
	);
	const hint = rowOf(selectOf(root, "inlineCompletions.model")).querySelector(".setting-hint");
	const error = hint?.querySelector(".setting-cover .error")?.textContent ?? "";
	expect(error).toContain("The last change did not apply");
	expect(error).not.toContain("no longer available");
});

test("the language-list rows commit trimmed deduplicated IDs to their own list; clearing sends the empty list", () => {
	const settings = makeSettings({
		languageLists: {
			allowedLanguages: { values: [], lossy: false, scope: null },
			blockedLanguages: { values: ["markdown"], lossy: false, scope: "global" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const allowed = inputOf(root, "inlineCompletions.allowedLanguages");
	fireInput(allowed, " typescript , python, typescript ");
	fireBlur(allowed);
	const blocked = inputOf(root, "inlineCompletions.blockedLanguages");
	fireInput(blocked, "");
	fireBlur(blocked);
	expect(postedCalls()).toEqual([
		{ method: "setLanguageList", payload: { list: "allowedLanguages", values: ["typescript", "python"] } },
		{ method: "setLanguageList", payload: { list: "blockedLanguages", values: [] } },
	]);
});

test("a lossy stored language list renders read-only instead of being silently canonicalized", () => {
	const settings = makeSettings({
		languageLists: {
			allowedLanguages: { values: ["typescript"], lossy: true, scope: "global" },
			blockedLanguages: { values: [], lossy: false, scope: null },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	expect(root.querySelector("#setting-inlineCompletions\\.allowedLanguages")).toBeNull();
	const row = root.querySelector('.setting-row:has([aria-label="Open Allowed languages in settings.json"])');
	expect(row).not.toBeNull();
	expect(row?.textContent ?? "").toContain("typescript");
	expect(row?.textContent ?? "").toContain("Custom list");
});

test("the commit prompt commits verbatim on blur and clears with the empty string", () => {
	const settings = makeSettings({ commitPrompt: "Old.", commitPromptScope: "global" });
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const input = inputOf(root, "commitGeneration.prompt");
	expect(input.value).toBe("Old.");
	fireInput(input, "Subject only. ");
	fireBlur(input);
	fireInput(input, "");
	fireBlur(input);
	expect(postedCalls()).toEqual([
		{ method: "setCommitPrompt", payload: { value: "Subject only. " } },
		{ method: "setCommitPrompt", payload: { value: "" } },
	]);
});

test("a multiline stored prompt renders read-only: a text input would silently flatten its newlines", () => {
	// CR and LF both disqualify the box: text inputs strip either separator.
	for (const prompt of ["Subject line.\nThen a body.", "Subject line.\rThen a body."]) {
		cleanup();
		resetPosted();
		const settings = makeSettings({ commitPrompt: prompt, commitPromptScope: "global" });
		const root = mount(<SettingsSection settings={settings} models={[]} />);
		expect(root.querySelector("#setting-commitGeneration\\.prompt")).toBeNull();
		const row = root.querySelector('.setting-row:has([aria-label="Open Commit message prompt in settings.json"])');
		expect(row).not.toBeNull();
		expect(row?.textContent ?? "").toContain("Subject line.");
		expect(row?.textContent ?? "").toContain("Multi-line prompt");
		expect(postedCalls()).toEqual([]);
	}
});

test("the two feature groups render after UI in the manifest's order, booleans included", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const titles = [...root.querySelectorAll(".settings-group-title")].map((title) => title.textContent);
	expect(titles).toEqual([
		"Models",
		"Chat",
		"Discovery",
		"Usage",
		"UI",
		"Inline completions",
		"Commit message generation",
		"Import & Export",
	]);
	expect(root.querySelector("#setting-inlineCompletions\\.enabled")).not.toBeNull();
	expect(root.querySelector("#setting-commitGeneration\\.enabled")).not.toBeNull();
});
