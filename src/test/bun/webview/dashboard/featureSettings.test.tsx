/**
 * The inline-completions and commit-generation settings rows: the shared model picker
 * (declared-only options, writes, the dangling warning's covering contract), the
 * language filter's mode and list rows, and the commit prompt row.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { WIRE_LIMITS } from "../../../../dashboard/endpoints";
import { SettingsSection } from "../../../../webview/dashboard/settings";
import { makeSettings } from "../../../dashboardSettingsFixture";
import { makeModel } from "../fixtures";
import {
	cleanup,
	fireBlur,
	fireClick,
	fireInput,
	fireKeyDown,
	fireSelect,
	lastRequest,
	mount,
	postedCalls,
	pushToWebview,
	render,
	resetPosted,
} from "../harness";

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

function textareaOf(root: ParentNode, settingId: string): HTMLTextAreaElement {
	const box = root.querySelector(`#setting-${CSS.escape(settingId)}`);
	if (!(box instanceof HTMLTextAreaElement)) {
		throw new Error(`no textarea for setting ${settingId}`);
	}
	return box;
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
	expect(labels).toEqual(["Not set", "Prod: gpt-test", "Prod: codestral", "Gateway: gpt-test", "Custom model ID..."]);
	// Unset renders the Not set choice selected and no warning.
	expect(select.value).toBe("");
	expect(rowOf(select).querySelector(".setting-hint .error")).toBeNull();
});

test("only declared entries' models are offered: an external group's label mints no option", () => {
	// A ref addresses a servers-entry label, which external groups do not have,
	// so their models must never be offered as picks.
	const root = mount(<SettingsSection settings={makeSettings()} models={MODELS} declaredServerLabels={["Prod"]} />);
	const labels = [...selectOf(root, "inlineCompletions.model").options].map((option) => option.textContent);
	expect(labels).toEqual(["Not set", "Prod: gpt-test", "Prod: codestral", "Custom model ID..."]);
	// And with no declared labels at all (the prop's fail-closed default), only Not set remains.
	cleanup();
	const bare = mount(<SettingsSection settings={makeSettings()} models={MODELS} />);
	expect([...selectOf(bare, "commitGeneration.model").options].map((option) => option.textContent)).toEqual([
		"Not set",
		"Custom model ID...",
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

test("an unlisted model on a DECLARED server stays quiet: absence from the catalog proves nothing", () => {
	// Completion-mode (FIM) models never register as chat models, so a custom
	// pick is always absent from the options; only a vanished SERVER warns.
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Prod", model: "codestral-fim" }, commitGeneration: null },
		featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
	});
	const root = mount(<SettingsSection settings={settings} models={MODELS} declaredServerLabels={DECLARED} />);
	const select = selectOf(root, "inlineCompletions.model");
	expect(select.selectedOptions[0]?.textContent).toBe("Prod: codestral-fim");
	expect(select.getAttribute("aria-invalid")).toBe("false");
	expect(rowOf(select).querySelector(".setting-hint .error")).toBeNull();
	// And the probe stays available for exactly this case.
	const button = [...rowOf(select).querySelectorAll("button")].find(
		(candidate) => candidate.textContent === "Test completion"
	);
	expect(button?.hasAttribute("disabled")).toBe(false);
});

test("a ref naming a vanished SERVER keeps its option, wears the covering warning, and never changes the row's structure", () => {
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Removed", model: "gpt-test" }, commitGeneration: null },
		featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
	});
	const root = mount(<SettingsSection settings={settings} models={MODELS} declaredServerLabels={DECLARED} />);
	const select = selectOf(root, "inlineCompletions.model");
	// The configured pair is synthesized into the options so the pick stays
	// visible and keepable; its rendered text is the same vocabulary as every
	// served option, so toggling served <-> dangling redraws nothing else.
	expect(select.selectedOptions[0]?.textContent).toBe("Removed: gpt-test");
	expect(select.getAttribute("aria-invalid")).toBe("true");
	// The dangling row's probe is disabled: the send could only fail on the
	// missing entry, and the warning already says so.
	const button = [...rowOf(select).querySelectorAll("button")].find(
		(candidate) => candidate.textContent === "Test completion"
	);
	expect(button?.hasAttribute("disabled")).toBe(true);
	// The warning rides the covered-description slot (the height-keeping
	// overlay), never a new block: check-geometry pins the no-move claim.
	const hint = rowOf(select).querySelector(".setting-hint");
	expect(hint?.classList.contains("setting-covered")).toBe(true);
	expect(hint?.querySelector(".setting-cover .error")?.textContent).toContain(
		'This model cannot be reached because server "Removed" is no longer configured'
	);
	// Keeping the dangling pick selected again is a no-op, never a write.
	fireSelect(select, select.value);
	expect(postedCalls()).toEqual([]);
});

test("a standing write failure outranks the dangling warning in the covered slot", () => {
	// The dangling warning never clears on its own, so if it kept the slot a
	// refused setFeatureModel write would stay invisible on exactly the row
	// that posted it.
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Removed", model: "gpt-test" }, commitGeneration: null },
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
	expect(error).not.toContain("cannot be reached because");
});

test("the language list row commits its half as a patch: trimmed deduplicated IDs, never a mode", () => {
	const settings = makeSettings({
		languageFilter: { mode: "allow", languages: { values: ["markdown"], lossy: false, scope: "global" } },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const list = inputOf(root, "inlineCompletions.languageFilter");
	fireInput(list, " typescript , python, typescript ");
	fireBlur(list);
	fireInput(list, "");
	fireBlur(list);
	expect(postedCalls()).toEqual([
		{ method: "setLanguageFilter", payload: { languages: ["typescript", "python"] } },
		{ method: "setLanguageFilter", payload: { languages: [] } },
	]);
});

test("switching the mode patches the mode alone: the stored languages are the extension's to keep", () => {
	const settings = makeSettings({
		languageFilter: { mode: "block", languages: { values: ["markdown", "plaintext"], lossy: false, scope: "global" } },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const mode = selectOf(root, "inlineCompletions.languageFilter-mode");
	expect([...mode.options].map((option) => option.textContent)).toEqual([
		"Block listed languages",
		"Allow only listed languages",
	]);
	fireSelect(mode, "allow");
	expect(postedCalls()).toEqual([{ method: "setLanguageFilter", payload: { mode: "allow" } }]);
	// The list row's texts follow the picked mode.
	const list = inputOf(root, "inlineCompletions.languageFilter");
	expect(rowOf(list).textContent ?? "").toContain("Blocked languages");
});

test("cross-row writes cannot revert each other: each row's patch names only its own field", () => {
	// The merge onto the stored filter happens extension-side on the chained
	// channel, so no interleaving of pushes and queued writes can make one
	// row's write carry the other row's stale half.
	const settings = makeSettings({
		languageFilter: { mode: "block", languages: { values: ["markdown"], lossy: false, scope: "global" } },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const list = inputOf(root, "inlineCompletions.languageFilter");
	fireInput(list, "markdown, plaintext");
	fireBlur(list);
	fireSelect(selectOf(root, "inlineCompletions.languageFilter-mode"), "allow");
	fireInput(list, "markdown, plaintext, git-commit");
	fireBlur(list);
	for (const call of postedCalls()) {
		expect(Object.keys(call.payload as Record<string, unknown>).length).toBe(1);
	}
	expect(postedCalls()).toEqual([
		{ method: "setLanguageFilter", payload: { languages: ["markdown", "plaintext"] } },
		{ method: "setLanguageFilter", payload: { mode: "allow" } },
		{ method: "setLanguageFilter", payload: { languages: ["markdown", "plaintext", "git-commit"] } },
	]);
});

test("filtering by either row's text keeps BOTH rows: one setting never shows as half a setting", () => {
	const settings = makeSettings({
		languageFilter: { mode: "block", languages: { values: ["markdown"], lossy: false, scope: "global" } },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const filter = root.querySelector('input[aria-label="Filter settings"]') as HTMLInputElement;
	expect(filter).not.toBeNull();
	// "Language filter" matches only the mode row's own text...
	fireInput(filter, "Language filter");
	const modeRow = rowOf(selectOf(root, "inlineCompletions.languageFilter-mode"));
	const listRow = rowOf(inputOf(root, "inlineCompletions.languageFilter"));
	expect(modeRow.hidden).toBe(false);
	expect(listRow.hidden).toBe(false);
	// ...and "Blocked languages" only the list row's; both keep the pair.
	fireInput(filter, "Blocked languages");
	expect(modeRow.hidden).toBe(false);
	expect(listRow.hidden).toBe(false);
});

test("a lossy stored language filter renders BOTH rows read-only instead of being silently canonicalized", () => {
	const settings = makeSettings({
		languageFilter: { mode: "allow", languages: { values: ["typescript"], lossy: true, scope: "global" } },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	// The list input is gone (CommaListRow's read-only fallback)...
	expect(root.querySelector("#setting-inlineCompletions\\.languageFilter")).toBeNull();
	const row = root.querySelector('.setting-row:has([aria-label="Open Allowed languages in settings.json"])');
	expect(row).not.toBeNull();
	expect(row?.textContent ?? "").toContain("typescript");
	expect(row?.textContent ?? "").toContain("Custom list");
	// ...and so is the mode select: a mode write would re-send the normalized
	// list and destroy the raw form the fallback protects.
	expect(root.querySelector("#setting-inlineCompletions\\.languageFilter-mode")).toBeNull();
	expect(root.textContent ?? "").toContain("Allow only listed languages");
});

test("a comma-holding entry freezes both rows too: the shared custom rule, not just the lossy flag", () => {
	// "a,b" survives normalization verbatim (lossy: false), but the comma box
	// cannot round-trip it - and a mode write re-sends the list, so the mode
	// select must freeze by the SAME predicate as the list row.
	const settings = makeSettings({
		languageFilter: { mode: "block", languages: { values: ["a,b"], lossy: false, scope: "global" } },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	expect(root.querySelector("#setting-inlineCompletions\\.languageFilter")).toBeNull();
	expect(root.querySelector("#setting-inlineCompletions\\.languageFilter-mode")).toBeNull();
});

test("the filter's write failure and actions render once, under the list row (the mode row is a companion)", () => {
	const settings = makeSettings({
		languageFilter: { mode: "block", languages: { values: ["markdown"], lossy: false, scope: "global" } },
	});
	const root = mount(
		<SettingsSection
			settings={settings}
			models={[]}
			writeFailures={{
				setLanguageFilter: { seq: 1, row: "inlineCompletions.languageFilter", message: "refused by the extension" },
			}}
		/>
	);
	const failures = [...root.querySelectorAll(".setting-cover .error")].filter((line) =>
		(line.textContent ?? "").includes("The last change did not apply")
	);
	expect(failures.length).toBe(1);
	expect(failures[0]?.closest(".setting-row")).toBe(rowOf(inputOf(root, "inlineCompletions.languageFilter")));
	// One reset gesture for the one setting: the companion mode row offers none.
	const modeRow = rowOf(selectOf(root, "inlineCompletions.languageFilter-mode"));
	expect(modeRow.querySelector('[aria-label^="Open"]')).toBeNull();
	expect(rowOf(inputOf(root, "inlineCompletions.languageFilter")).querySelector('[aria-label^="Open"]')).not.toBeNull();
});

test("the commit prompt commits verbatim on blur and clears with the empty string", () => {
	const settings = makeSettings({ commitPrompt: "Old.", commitPromptScope: "global" });
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const box = textareaOf(root, "commitGeneration.prompt");
	expect(box.value).toBe("Old.");
	// The bound rides the control itself, so the wire limit cannot be out-typed.
	expect(box.maxLength).toBe(WIRE_LIMITS.commitPrompt);
	fireInput(box, "Subject only. ");
	fireBlur(box);
	fireInput(box, "");
	fireBlur(box);
	expect(postedCalls()).toEqual([
		{ method: "setCommitPrompt", payload: { value: "Subject only. " } },
		{ method: "setCommitPrompt", payload: { value: "" } },
	]);
});

test("a multiline prompt renders editable and round-trips its newlines through the wire", () => {
	// The textarea replaced the old read-only fallback, which existed only
	// because a single-line text input flattens line separators.
	const prompt = "Subject line.\nThen a body.";
	const settings = makeSettings({ commitPrompt: prompt, commitPromptScope: "global" });
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const box = textareaOf(root, "commitGeneration.prompt");
	expect(box.value).toBe(prompt);
	expect(root.textContent ?? "").not.toContain("Multi-line prompt");
	// The row's title is a real label pointed at the textarea in every state.
	const label = box.closest(".setting-row")?.querySelector('label[for="setting-commitGeneration.prompt"]');
	expect(label?.textContent).toBe("Commit message prompt");
	fireInput(box, `${prompt}\nAnd a closing line.`);
	fireBlur(box);
	expect(postedCalls()).toEqual([{ method: "setCommitPrompt", payload: { value: `${prompt}\nAnd a closing line.` } }]);
});

test("plain Enter never commits the prompt draft; Ctrl/Cmd+Enter keeps a keyboard commit", () => {
	// Reinstating the old Enter-commits handler would flatten every newline the
	// user types - the exact bug the textarea replaced - so its absence is pinned.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const box = textareaOf(root, "commitGeneration.prompt");
	fireInput(box, "Subject.\nBody.");
	const plain = fireKeyDown(box, "Enter");
	expect(postedCalls()).toEqual([]);
	// The line break stays the browser's: an unhandled Enter is not cancelled.
	expect(plain.defaultPrevented).toBe(false);
	const chord = fireKeyDown(box, "Enter", { ctrlKey: true });
	expect(postedCalls()).toEqual([{ method: "setCommitPrompt", payload: { value: "Subject.\nBody." } }]);
	// The chord is consumed whole: committing must not also edit the draft.
	expect(chord.defaultPrevented).toBe(true);
	resetPosted();
	fireInput(box, "Subject.\nBody.\nMore.");
	expect(fireKeyDown(box, "Enter", { metaKey: true }).defaultPrevented).toBe(true);
	expect(postedCalls()).toEqual([{ method: "setCommitPrompt", payload: { value: "Subject.\nBody.\nMore." } }]);
});

test("a CR-separated stored prompt gets the same editable box: no separator disqualifies it", () => {
	// The old fallback keyed on /[\r\n]/; both separators must now land in the
	// textarea (the box may normalize CR to LF, so no byte-exact claim here).
	const settings = makeSettings({ commitPrompt: "Subject line.\rThen a body.", commitPromptScope: "global" });
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const box = textareaOf(root, "commitGeneration.prompt");
	expect(box.value).toContain("Subject line.");
	expect(box.value).toContain("Then a body.");
	expect(root.textContent ?? "").not.toContain("Multi-line prompt");
	expect(postedCalls()).toEqual([]);
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

test("custom entry commits a declared label plus a free-typed model ID, and Cancel restores the select", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={MODELS} declaredServerLabels={DECLARED} />);
	fireSelect(selectOf(root, "inlineCompletions.model"), "custom");
	// The select swapped for the entry cluster: the id moves to the server pick.
	const serverPick = selectOf(root, "inlineCompletions.model");
	expect([...serverPick.options].map((option) => option.textContent)).toEqual(["Prod", "Gateway"]);
	const row = rowOf(serverPick);
	const modelInput = row.querySelector('input[aria-label="Model ID"]') as HTMLInputElement;
	expect(modelInput).not.toBeNull();
	const useButton = [...row.querySelectorAll("button")].find((button) => button.textContent === "Use model");
	expect(useButton?.hasAttribute("disabled")).toBe(true);

	fireSelect(serverPick, "Gateway");
	fireInput(modelInput, "  codestral-fim  ");
	expect(useButton?.hasAttribute("disabled")).toBe(false);
	fireClick(useButton as HTMLElement);
	expect(postedCalls()).toEqual([
		{
			method: "setFeatureModel",
			payload: { feature: "inlineCompletions", value: { server: "Gateway", model: "codestral-fim" } },
		},
	]);
	// The commit leaves custom mode: the plain picker is back.
	expect(rowOf(selectOf(root, "inlineCompletions.model")).querySelector('input[aria-label="Model ID"]')).toBeNull();

	// Cancel never writes.
	resetPosted();
	fireSelect(selectOf(root, "inlineCompletions.model"), "custom");
	const cancel = [...rowOf(selectOf(root, "inlineCompletions.model")).querySelectorAll("button")].find(
		(button) => button.textContent === "Cancel"
	);
	fireClick(cancel as HTMLElement);
	expect(postedCalls()).toEqual([]);
	expect(rowOf(selectOf(root, "inlineCompletions.model")).querySelector('input[aria-label="Model ID"]')).toBeNull();
});

test("the test-completion probe posts the configured pair and renders the ack's outcome in the covered slot", () => {
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Prod", model: "codestral" }, commitGeneration: null },
		featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
	});
	const root = mount(<SettingsSection settings={settings} models={MODELS} declaredServerLabels={DECLARED} />);
	const row = rowOf(selectOf(root, "inlineCompletions.model"));
	const button = [...row.querySelectorAll("button")].find((candidate) => candidate.textContent === "Test completion");
	expect(button).not.toBeNull();
	fireClick(button as HTMLElement);

	const request = lastRequest("testFimCompletion");
	expect(request.payload).toEqual({ model: { server: "Prod", model: "codestral" } });
	// While in flight the button reads busy and refuses a second post.
	expect(row.textContent).toContain("Testing...");

	pushToWebview({
		kind: "ack",
		id: request.id,
		method: "testFimCompletion",
		message: "Completion received - 42 characters",
	});
	const status = row.querySelector('[role="status"]');
	expect(status?.textContent).toBe("Completion received - 42 characters");
	// Success wears the app-wide ok tone, one vocabulary with Test connection.
	expect(status?.classList.contains("state-ok")).toBe(true);

	// A failed probe renders the classified message in the error tone; counts
	// and classified text only, never completion text.
	fireClick(
		[...row.querySelectorAll("button")].find((candidate) => candidate.textContent === "Test completion") as HTMLElement
	);
	const retry = lastRequest("testFimCompletion");
	pushToWebview({
		kind: "fail",
		id: retry.id,
		method: "testFimCompletion",
		message: "LiteLLM inline completion request timed out after 15000ms.",
		failureKind: "validation",
	});
	expect(row.querySelector('[role="status"]')?.textContent).toContain("timed out");
});

test("a custom draft never seeds or commits an undeclared server label", () => {
	// The configured ref names a vanished server; the draft must seed from the
	// first DECLARED label - a controlled select initialized to a nonexistent
	// value would DISPLAY its first option while committing the stale label.
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Removed", model: "old" }, commitGeneration: null },
		featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
	});
	const root = mount(<SettingsSection settings={settings} models={MODELS} declaredServerLabels={DECLARED} />);
	fireSelect(selectOf(root, "inlineCompletions.model"), "custom");
	const serverPick = selectOf(root, "inlineCompletions.model");
	expect(serverPick.value).toBe("Prod");
	const row = rowOf(serverPick);
	fireInput(row.querySelector('input[aria-label="Model ID"]') as HTMLInputElement, "codestral-fim");
	fireClick([...row.querySelectorAll("button")].find((button) => button.textContent === "Use model") as HTMLElement);
	expect(postedCalls()).toEqual([
		{
			method: "setFeatureModel",
			payload: { feature: "inlineCompletions", value: { server: "Prod", model: "codestral-fim" } },
		},
	]);
});

test("opening the custom editor clears a landed probe outcome: the annotation never outlives its inputs", () => {
	const settings = makeSettings({
		featureModels: { inlineCompletions: { server: "Prod", model: "codestral" }, commitGeneration: null },
		featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
	});
	const root = mount(<SettingsSection settings={settings} models={MODELS} declaredServerLabels={DECLARED} />);
	const row = rowOf(selectOf(root, "inlineCompletions.model"));
	fireClick(
		[...row.querySelectorAll("button")].find((candidate) => candidate.textContent === "Test completion") as HTMLElement
	);
	const request = lastRequest("testFimCompletion");
	pushToWebview({
		kind: "ack",
		id: request.id,
		method: "testFimCompletion",
		message: "Completion received - 5 characters",
	});
	expect(row.querySelector('[role="status"]')).not.toBeNull();
	// The editor exists to change what the probe tested; opening it stales the result.
	fireSelect(selectOf(root, "inlineCompletions.model"), "custom");
	expect(row.querySelector('[role="status"]')).toBeNull();
	// Cancelling does not resurrect it either.
	fireClick([...row.querySelectorAll("button")].find((candidate) => candidate.textContent === "Cancel") as HTMLElement);
	expect(row.querySelector('[role="status"]')).toBeNull();
});

test("a changed pick hides a landed probe outcome: a result never sits beside a model it did not test", () => {
	const settingsFor = (model: string) =>
		makeSettings({
			featureModels: { inlineCompletions: { server: "Prod", model }, commitGeneration: null },
			featureModelScopes: { inlineCompletions: "global", commitGeneration: null },
		});
	const root = mount(
		<SettingsSection settings={settingsFor("codestral")} models={MODELS} declaredServerLabels={DECLARED} />
	);
	const row = rowOf(selectOf(root, "inlineCompletions.model"));
	fireClick(
		[...row.querySelectorAll("button")].find((candidate) => candidate.textContent === "Test completion") as HTMLElement
	);
	const request = lastRequest("testFimCompletion");
	pushToWebview({
		kind: "ack",
		id: request.id,
		method: "testFimCompletion",
		message: "Completion received - 5 characters",
	});
	expect(row.querySelector('[role="status"]')?.textContent).toContain("Completion received");
	// The next state push carries a different configured pair: the outcome is
	// keyed to the tested pair and leaves with it.
	render(<SettingsSection settings={settingsFor("gpt-test")} models={MODELS} declaredServerLabels={DECLARED} />, root);
	expect(rowOf(selectOf(root, "inlineCompletions.model")).querySelector('[role="status"]')).toBeNull();
});

test("the probe button stays disabled while no model is picked, and the commit row renders none", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={MODELS} declaredServerLabels={DECLARED} />);
	const inlineRow = rowOf(selectOf(root, "inlineCompletions.model"));
	const button = [...inlineRow.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === "Test completion"
	);
	expect(button?.hasAttribute("disabled")).toBe(true);
	const commitRow = rowOf(selectOf(root, "commitGeneration.model"));
	expect(
		[...commitRow.querySelectorAll("button")].some((candidate) => candidate.textContent === "Test completion")
	).toBe(false);
});
