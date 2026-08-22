/**
 * The scalar settings form: draft parsing, commit rules, blur-gated errors, resync, Reset, scope notes, ms hints.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fc from "fast-check";
import { act } from "react";
import type { RpcRequest } from "../../../../dashboard/endpoints";
import { WIRE_LIMITS } from "../../../../dashboard/endpoints";
import { isBoundViolation, parseNumberDraft } from "../../../../dashboard/presenters";
import { formatPercentExact } from "../../../../dashboard/spendFormat";
import { NUMBER_SETTING_IDS, settingRowPage } from "../../../../dashboard/viewModels";
import { OPENROUTER_MODEL_DIRECTIVE } from "../../../../shared/config/recordResolution";
import { AnnounceOnceScope } from "../../../../webview/dashboard/announceOnce";
import { App } from "../../../../webview/dashboard/app";
import { settingRowHelp } from "../../../../webview/dashboard/helpText";
import { parseThresholdBox, SettingsSection } from "../../../../webview/dashboard/settingsPage";
import { makeSettings } from "../../../dashboardSettingsFixture";
import { resolveFuzzSeed } from "../../../fuzzStream";
import { makeState, statePush } from "../fixtures";
import {
	buttonByText,
	cleanup,
	fireBlur,
	fireCheck,
	fireClick,
	fireInput,
	fireKeyDown,
	fireSelect,
	mount,
	postedCalls,
	postedMessages,
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

const NUM_RUNS = Number(process.env.FUZZ_RUNS) || 300;
const SEED = resolveFuzzSeed();

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

test("a row's help glyph trails the description inline, in the shared flow the covering texts swap around", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	// The glyph flows INLINE after the description's last word (same position on every row), inside the .setting-live
	// flow whose first slot swaps between the resting text and a covering error - the glyph itself never moves.
	const hint = rowOf(settingInput(root, "discovery.cacheTtl")).querySelector(".setting-hint");
	expect(hint).not.toBeNull();
	const help = hint?.querySelector("button.help");
	expect(help).not.toBeNull();
	// The glyph rides the NoBreakTail glue span (Chrome breaks before an atomic inline even after an NBSP, orphaning a
	// lone "?"); the glue is the live flow's own child, AFTER the resting-flow wrapper and outside the description.
	const glue = help?.closest(".help-wrap")?.parentElement;
	expect(glue?.classList.contains("whitespace-nowrap")).toBe(true);
	const live = glue?.parentElement;
	expect(live?.classList.contains("setting-live")).toBe(true);
	const rest = live?.querySelector(".setting-rest");
	expect(rest?.classList.contains("contents")).toBe(true);
	expect(rest?.nextElementSibling).toBe(glue as Element);
	expect(live?.parentElement).toBe(hint as HTMLElement);
	expect(hint?.querySelector(".setting-desc")?.querySelector("button.help")).toBeNull();
	// The cell owns wrapping and breaking (one unbroken token must not push out
	// of the column), and caps its prose at a reading measure inside the
	// full-bleed track: structure goes full-bleed, sentences do not.
	expect(hint?.classList.contains("break-words")).toBe(true);
	expect(hint?.classList.contains("min-w-0")).toBe(true);
	expect(hint?.classList.contains("max-w-[72ch]")).toBe(true);
	// At rest the cell holds the live flow alone, in flow: the height twin and
	// the overlay class exist only while a cover stands.
	expect(hint?.querySelector(".setting-twin")).toBeNull();
	expect(hint?.classList.contains("setting-covered")).toBe(false);
});

test("an error covers the hint cell without taking its height, and the one glyph trails the error's tail", () => {
	// Little of this is measurable in happy-dom: while covered, the live flow leaves the flow (dashboard.css
	// .setting-covered) and overlays the resting text's invisible twin, which keeps the cell's height - the row never
	// moves while you type, and the glyph never paints through an overlay because it rides the covering flow itself.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "discovery.cacheTtl");
	fireInput(input, "not a number");
	const hint = rowOf(input).querySelector(".setting-hint");
	const live = hint?.querySelector(".setting-live");
	const error = live?.querySelector(".error");
	const cover = error?.closest(".setting-cover");

	expect(error?.textContent).toContain("Not a duration");
	// The overlay rule keys on these two classes; the cell stays the anchor.
	expect(hint?.classList.contains("setting-covered")).toBe(true);
	expect(hint?.classList.contains("relative")).toBe(true);
	// The covering text replaces the resting flow IN the live flow; the resting
	// copy that holds the box is the aria-hidden twin (visibility-hidden by
	// dashboard.css, so its words and controls leave the accessibility tree).
	expect(live?.querySelector(".setting-rest")).toBeNull();
	const twin = hint?.querySelector(".setting-twin");
	expect(twin?.getAttribute("aria-hidden")).toBe("true");
	expect(twin?.querySelector(".setting-desc")).not.toBeNull();
	// The error span holds the message alone (the field's aria-describedby
	// reads its subtree, so a glyph inside it would announce its own name with
	// every problem); the glyph is the cover's SIBLING in the same inline flow.
	expect(error?.querySelector("button.help")).toBeNull();
	expect(cover?.querySelector("button.help")).toBeNull();
	const glyph = live?.querySelector("button.help");
	expect(glyph).not.toBeNull();
	expect(cover?.nextElementSibling).toBe(glyph?.closest(".whitespace-nowrap") as Element);
	// ONE live control: the twin renders its own inert copy - present (it holds
	// the resting box), inside the aria-hidden height holder - and no glyph
	// outside the twin exists besides the live one.
	const twinGlyph = hint?.querySelector(".setting-twin button.help");
	expect(twinGlyph).not.toBeNull();
	expect(twinGlyph?.closest('[aria-hidden="true"]')).not.toBeNull();
	for (const candidate of Array.from(hint?.querySelectorAll("button.help") ?? [])) {
		if (candidate !== glyph) {
			expect(candidate.closest(".setting-twin")).not.toBeNull();
		}
	}
});

test("the help glyph is one mount: focus on it survives an overlay landing and clearing", () => {
	// The bug class this structure kills: the old rest/cover twin glyphs were two mounts of one control, so a swap
	// landing while the reader was ON the "?" needed a hand-off effect to keep the keyboard. One element, no hand-off.
	// check-geometry's settings-write-failure-overlay pair asserts the same persistence in a real browser.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "discovery.cacheTtl");
	const hint = () => rowOf(input).querySelector(".setting-hint") as HTMLElement;
	const glyph = hint().querySelector(".setting-live button.help") as HTMLButtonElement;
	// Real focus (activeElement moves), act-wrapped because the tip primitive
	// updates state on focus.
	void act(() => glyph.focus());
	expect(document.activeElement).toBe(glyph);

	fireInput(input, "not a number");
	expect(hint().querySelector(".setting-cover")).not.toBeNull();
	expect(hint().querySelector(".setting-live button.help")).toBe(glyph);
	expect(document.activeElement).toBe(glyph);

	fireInput(input, "5000");
	expect(hint().querySelector(".setting-cover")).toBeNull();
	expect(hint().querySelector(".setting-live button.help")).toBe(glyph);
	expect(document.activeElement).toBe(glyph);
});

test("a repeat failure's remounted cover leaves the focused glyph alone", () => {
	// The cover is keyed on the failure seq (a repeat must re-announce), so a second refusal REPLACES the cover span -
	// but the glyph is the cover's sibling, not its child, so the remount cannot touch it or the keyboard on it.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const failureAt = (seq: number) =>
		render(
			<SettingsSection
				settings={makeSettings()}
				models={[]}
				writeFailures={{ setNumberSetting: { seq, row: "chat.timeout", message: `refused (attempt ${seq})` } }}
			/>,
			root
		);
	failureAt(1);
	const hint = () => rowOf(settingInput(root, "chat.timeout")).querySelector(".setting-hint") as HTMLElement;
	const glyph = hint().querySelector(".setting-live button.help") as HTMLButtonElement;
	void act(() => glyph.focus());
	expect(document.activeElement).toBe(glyph);

	failureAt(2);
	expect(hint().textContent).toContain("refused (attempt 2)");
	expect(hint().querySelector(".setting-live button.help")).toBe(glyph);
	expect(document.activeElement).toBe(glyph);
});

test("a group with no help renders no glyph in its head", () => {
	// Only Import & Export passes help today, so every other group head is the
	// case where the glyph must not appear at all - an empty tip would be a
	// button that says nothing.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const heads = Array.from(root.querySelectorAll(".settings-group-head"));
	expect(heads.length).toBeGreaterThan(1);
	for (const head of heads) {
		const title = head.querySelector(".settings-group-title")?.textContent;
		expect(Boolean(head.querySelector("button.help"))).toBe(title === "Import & Export");
	}
});

test("a User-scope modified number row keeps its words on demand: the default note rides the reveal idiom", () => {
	// At rest the gutter bar is the whole signal; the note exists for hover and focus (the reveal wrapper's opacity
	// idiom), lives in the hint cell with the prose, and says only the built-in default a Reset would head toward.
	const settings = makeSettings();
	const root = mount(
		<SettingsSection
			settings={{
				...settings,
				configuredScopes: {
					...settings.configuredScopes,
					numbers: { ...settings.configuredScopes.numbers, "discovery.cacheTtl": "global" },
				},
			}}
			models={[]}
		/>
	);
	const hint = rowOf(settingInput(root, "discovery.cacheTtl")).querySelector(".setting-hint");
	const note = hint?.querySelector(".setting-modified-note");
	expect(note?.textContent).toBe("default: 1 h");
	expect(note?.textContent).not.toContain("Modified");
	// In the live flow (the hint cell's own inline flow), trailing the glyph.
	expect(note?.parentElement?.classList.contains("setting-live")).toBe(true);
	expect(note?.parentElement?.parentElement).toBe(hint as HTMLElement);
	expect(note?.classList.contains("opacity-0")).toBe(true);
	expect(note?.classList.contains("group-hover/setting:opacity-100")).toBe(true);
	expect(note?.classList.contains("group-focus-within/setting:opacity-100")).toBe(true);
});

test("a below-minimum draft stays calm until blur reveals it; commit posts nothing; a valid draft posts once; unchanged posts nothing", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "discovery.timeout");

	// Mid-typing, an honest below-minimum draft raises no error yet...
	fireInput(input, "500");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
	expect(input.getAttribute("aria-invalid")).toBe("false");
	// ...but blur reveals it, and the invalid draft still never commits.
	fireBlur(input);
	expect(rowOf(input).textContent).toContain("Must be at least 1000");
	expect(input.getAttribute("aria-invalid")).toBe("true");
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);

	fireInput(input, "20480");
	expect(rowOf(input).textContent).not.toContain("Must be at least");
	fireBlur(input);
	expect(postedCalls()).toEqual([
		{ method: "setNumberSetting", payload: { setting: "discovery.timeout", value: 20480 } },
	]);

	// A draft equal to the stored value posts nothing on commit.
	resetPosted();
	fireInput(input, "30000");
	fireBlur(input);
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);
});

test("Enter reveals a bound error like blur does; parse errors show live per keystroke", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
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
	// The drift guard the display gating leans on: both functions read the draft with one grammar (durations on ms
	// settings), so "invalid because of the minimum" and isBoundViolation must agree on every draft. The list covers
	// empties, unparsable text, non-finite numbers, both sides of every minimum, and the duration grammar's edges.
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
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
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
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "discovery.timeout");
	fireInput(input, "45000");
	fireKeyDown(input, "Enter");
	expect(postedCalls()).toEqual([
		{ method: "setNumberSetting", payload: { setting: "discovery.timeout", value: 45000 } },
	]);
});

test("the count-unit number input rejects a fractional draft live and commits a whole one", () => {
	// chat.maxToolsPerRequest is the count-unit setting: type="number", whole values only. "1.5" has no reading under
	// the count grammar, so the error shows on the keystroke (a parse failure, not a blur-gated bound).
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "chat.maxToolsPerRequest");
	expect(input.type).toBe("number");

	fireInput(input, "1.5");
	expect(rowOf(input).textContent).toContain("Not a whole number");
	expect(input.getAttribute("aria-invalid")).toBe("true");
	fireKeyDown(input, "Enter");
	fireBlur(input);
	expect(postedMessages).toEqual([]);

	fireInput(input, "129");
	expect(rowOf(input).textContent).not.toContain("Not a whole number");
	fireKeyDown(input, "Enter");
	expect(postedCalls()).toEqual([
		{ method: "setNumberSetting", payload: { setting: "chat.maxToolsPerRequest", value: 129 } },
	]);
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
	const root = mount(<SettingsSection settings={settings} models={[]} />);

	const resets = Array.from(root.querySelectorAll("button.reset"));
	expect(resets.length).toBe(1);
	expect(resets[0]?.getAttribute("aria-label")).toBe("Remove the Workspace value of Request timeout");
	expect(rowOf(settingInput(root, "chat.timeout")).classList.contains("modified")).toBe(true);
	expect(rowOf(settingInput(root, "discovery.timeout")).classList.contains("modified")).toBe(false);

	fireClick(resets[0] as HTMLButtonElement);
	expect(postedCalls()).toEqual([{ method: "resetSetting", payload: { setting: "chat.timeout" } }]);
});

test("the boolean checkbox posts setBooleanSetting with the toggled value", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const checkbox = settingInput(root, "ui.maskSecretInputs");
	expect(checkbox.checked).toBe(true);
	fireCheck(checkbox, false);
	expect(postedCalls()).toEqual([
		{ method: "setBooleanSetting", payload: { setting: "ui.maskSecretInputs", value: false } },
	]);
});

test("ms equivalence hints: 90000 reads as clock units, the zero-meaning settings read their special zero", () => {
	const settings = makeSettings({
		numbers: { ...makeSettings().numbers, "chat.timeout": 90000, "discovery.cacheTtl": 0, "usage.pollInterval": 0 },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);

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

test("annotation earns its place by being news: a workspace override speaks at rest, a User value stays silent", () => {
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
	const root = mount(<SettingsSection settings={settings} models={[]} />);

	const noteOf = (id: string) => rowOf(settingInput(root, id)).querySelector(".setting-modified-note");
	// A workspace override is what the gutter bar alone cannot disambiguate ("my user setting is not what applies
	// here"), so its note stands at rest - no reveal idiom - and the ms default reads in the duration idiom.
	expect(noteOf("chat.timeout")?.textContent).toBe("Modified in Workspace settings (default: 5 min)");
	expect(noteOf("chat.timeout")?.classList.contains("opacity-0")).toBe(false);
	// A User-scope boolean has no default worth revealing and no scope worth
	// naming: the bar is the whole annotation.
	expect(noteOf("ui.maskSecretInputs")).toBeNull();
	// An unmodified number row reserves the note's box as an invisible, aria-hidden spacing twin: the revealed note
	// holds in-flow space on a modified row (opacity, never display), so without the twin, marking a row modified
	// re-wrapped its description line and grew the row. The twin never reveals and says nothing to assistive tech.
	const phantom = noteOf("discovery.timeout");
	expect(phantom?.getAttribute("aria-hidden")).toBe("true");
	expect(phantom?.textContent).toBe("default: 30 s");
	expect(phantom?.classList.contains("opacity-0")).toBe(true);
	expect(phantom?.classList.contains("group-hover/setting:opacity-100")).toBe(false);
	expect(phantom?.getAttribute("data-slot")).toBeNull();
	expect(noteOf("chat.timeout")?.closest(".setting-hint")).not.toBeNull();
	expect(noteOf("chat.timeout")?.previousElementSibling).not.toBeNull();
});

test("the cache row's label needs no acronym", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	expect(rowOf(settingInput(root, "discovery.cacheTtl")).querySelector(".setting-title")?.textContent).toBe(
		"Discovery cache lifetime"
	);
});

test("settings-row help glyphs are named for their setting, so a button list is not a column of bare Helps", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const glyphOf = (id: string) => rowOf(settingInput(root, id)).querySelector("button.help");
	expect(glyphOf("chat.timeout")?.getAttribute("aria-label")).toBe("Help: Request timeout");
	expect(glyphOf("chat.promptCaching")?.getAttribute("aria-label")).toBe("Help: Prompt caching");
	// The section's own glyph is named by the Section primitive: a button called "Settings" that performs no action is
	// a trap. Addressed through its own heading, because the record editors below share the header-line class.
	const sectionGlyph = root.querySelector(".section-head:has(> .section-title) button.help");
	expect(sectionGlyph?.getAttribute("aria-label")).toBe("Help: Settings");
});

test("ms fields are text inputs (the duration suffixes need letters)", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	for (const id of ["chat.timeout", "discovery.timeout", "discovery.cacheTtl", "usage.pollInterval"]) {
		const input = settingInput(root, id);
		expect(input.getAttribute("type"), id).toBe("text");
		// min is a number-input constraint; the duration grammar owns the bound.
		expect(input.getAttribute("min"), id).toBeNull();
	}
});

test("a duration draft commits its millisecond value, with the equivalence hint live while typing", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
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
	expect(postedCalls()).toEqual([{ method: "setNumberSetting", payload: { setting: "chat.timeout", value: 90000 } }]);

	// A draft spelling the stored value differently ("90s" over 90000) still
	// counts as unchanged once committed: same value, no second post.
	resetPosted();
	const stored = makeSettings({ numbers: { ...makeSettings().numbers, "chat.timeout": 90000 } });
	const storedRoot = mount(<SettingsSection settings={stored} models={[]} />);
	const storedInput = settingInput(storedRoot, "chat.timeout");
	fireInput(storedInput, "90s");
	fireBlur(storedInput);
	expect(postedMessages).toEqual([]);
});

test("a unit typo reads as a live grammar error; a below-bound duration stays calm until blur", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
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
	expect(postedCalls()).toEqual([
		{ method: "setNumberSetting", payload: { setting: "discovery.timeout", value: 45000 } },
	]);
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
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]');
	if (filter === null) {
		throw new Error("no filter input");
	}
	expect(filter.getAttribute("placeholder")).toBe("Filter settings, e.g. timeout");

	fireInput(filter, "timeout");
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
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;

	// A nested parameter name reaches the editor, not just its own keys.
	fireInput(filter, "temperature");
	expect(editorSection(root, "Model parameters").hidden).toBe(false);

	// The editor's own title matches like a scalar row's label does.
	fireInput(filter, "model param");
	expect(editorSection(root, "Model parameters").hidden).toBe(false);

	fireInput(filter, "no such key");
	expect(editorSection(root, "Model parameters").hidden).toBe(true);
});

test("the filter matches a row's help text", () => {
	// The searchable synonyms live in the "?" tips, so a row's tip is part of its haystack: the glyph is visible at
	// rest and the tip carries the match. Group-level help stays out; the Import & Export test below holds that line.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;

	// "homelab" lives only in discovery.staleServeWindow's help.
	fireInput(filter, "homelab");
	expect(rowOf(settingInput(root, "discovery.staleServeWindow")).hidden).toBe(false);
	expect(rowOf(settingInput(root, "discovery.timeout")).hidden).toBe(true);
});

test("the filter matches a record editor's own help, which is where its save model moved", () => {
	// An editor matched through its header help is one visible unit whose "?"
	// carries the match - the same reading as a scalar row matched through its
	// help, not a group kept alive by group-level help.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;
	fireInput(filter, "apply together");
	expect(editorSection(root, "Model parameters").hidden).toBe(false);
	expect(editorSection(root, "Model capabilities").hidden).toBe(false);
	expect(rowOf(settingInput(root, "chat.timeout")).hidden).toBe(true);
});

test("zero hits show the no-match line, and a dirty draft survives being filtered away and back", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;
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
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);

	const jumpOf = (id: string) => rowOf(settingInput(root, id)).querySelector("button.reveal-json");
	const numberJump = jumpOf("chat.timeout");
	expect(numberJump?.getAttribute("aria-label")).toBe("Open Request timeout in settings.json");
	fireClick(numberJump as HTMLButtonElement);
	expect(postedCalls()).toEqual([{ method: "revealSetting", payload: { setting: "chat.timeout" } }]);

	resetPosted();
	const booleanJump = jumpOf("chat.promptCaching");
	expect(booleanJump?.getAttribute("aria-label")).toBe("Open Prompt caching in settings.json");
	fireClick(booleanJump as HTMLButtonElement);
	expect(postedCalls()).toEqual([{ method: "revealSetting", payload: { setting: "chat.promptCaching" } }]);
});

test("the capabilities editor renders as a second record editor and applies via setModelCapabilities", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
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
	const posted = postedMessages[0] as RpcRequest<"setModelCapabilities">;
	expect(posted.method).toBe("setModelCapabilities");
	expect(posted.payload.value).toEqual({ "gpt-4*": { context_length: 200000 } });
	expect(typeof posted.id).toBe("string");
});

test("the page runs full-bleed: no measure cap on the header or the groups, one right edge from the pane", () => {
	// This page is a LIST of settings: its one right edge is the pane's own, held by the rows' fixed trailing actions
	// track. What this pins is that nobody reintroduces a measure cap on either container and mints a second edge.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const groups = root.querySelector(".settings-groups") as HTMLElement;
	const header = root.querySelector(".page-section > .section-head") as HTMLElement;
	for (const surface of [groups, header]) {
		expect(Array.from(surface.classList).some((name) => name.startsWith("max-w-"))).toBe(false);
	}
	// The fixed actions track is what makes the edge one: the wide tier's template lives on .settings-groups in
	// dashboard.css (rows adopt it through subgrid, so the label track is one measured width for the page) and its
	// last track is a rem. happy-dom runs no cascade, so the stylesheet is where this is checkable.
	const css = readFileSync(join(import.meta.dir, "../../../../webview/dashboard/styles/dashboard.css"), "utf8");
	const template = /\.settings-groups \{\s*display: grid;\s*grid-template-columns: ([^;]+);/.exec(css)?.[1] ?? "";
	expect(template).toMatch(/ [\d.]+rem$/);
	const row = /\.setting-row \{\s*grid-column: span 4;\s*grid-template-columns: (subgrid);/.exec(css)?.[1];
	expect(row).toBe("subgrid");
});

test("the title's stacked flip shares the row grid's threshold, inside the same stylesheet band", () => {
	// The label flips left where the columns turn two-track. Both live in dashboard.css's `< 910` band now, so the
	// claim is that ONE block carries both - a flip block of its own could drift to another width. The end anchor is
	// searched FROM the flip's own block, so an "auto 1fr" elsewhere in the file cannot satisfy it.
	const css = readFileSync(join(import.meta.dir, "../../../../webview/dashboard/styles/dashboard.css"), "utf8");
	const stackedAt = /@container pane \(width < (\d+)px\) \{\s*\.setting-title \{\s*text-align: left;/.exec(css);
	expect(stackedAt).not.toBeNull();
	const start = css.indexOf(stackedAt?.[0] ?? "");
	expect(start).toBeGreaterThan(-1);
	const bandAt = css.indexOf("@container pane (width >= 560px)", start);
	const templateAt = css.indexOf("grid-template-columns: auto 1fr", start);
	expect(bandAt).toBeGreaterThan(start);
	expect(templateAt).toBeGreaterThan(bandAt);
});

test("every settings row anchors its actions in one trailing slot: Reset then the settings.json jump", () => {
	// Fail-closed structural pin behind the "{} renders in two different positions" defect: the slot is the row
	// template's LAST cell, the jump its LAST child, and no action leaks into the control or hint cells. Counted
	// against the page's row INVENTORY (every scalar id this page owns plus the seven non-scalar rows - the
	// feature rows live on the Features page now), so it fails both ways.
	const base = makeSettings();
	const settings = makeSettings({
		configuredScopes: {
			numbers: { ...base.configuredScopes.numbers, "chat.timeout": "global" },
			booleans: { ...base.configuredScopes.booleans, "ui.maskSecretInputs": "workspace" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const rows = Array.from(root.querySelectorAll(".setting-row"));
	const ownedScalars = [
		...Object.keys(settings.configuredScopes.numbers),
		...Object.keys(settings.configuredScopes.booleans),
	].filter((id) => settingRowPage(id) === "settings");
	expect(rows.length).toBe(ownedScalars.length + 7);
	for (const row of rows) {
		const slots = Array.from(row.children).filter((child) => child.classList.contains("setting-actions"));
		expect(slots.length, row.textContent ?? "").toBe(1);
		const slot = slots[0] as HTMLElement;
		expect(row.lastElementChild).toBe(slot);
		const jumps = row.querySelectorAll("button.reveal-json");
		if (row.classList.contains("setting-companion")) {
			// A multi-row setting's secondary row: the primary row owns the
			// actions, so the companion keeps the empty slot (the grid track
			// stays) and offers neither gesture.
			expect(jumps.length, row.textContent ?? "").toBe(0);
			expect(row.querySelectorAll("button.reset").length, row.textContent ?? "").toBe(0);
			expect(slot.children.length, row.textContent ?? "").toBe(0);
			continue;
		}
		expect(jumps.length, row.textContent ?? "").toBe(1);
		expect(slot.contains(jumps[0] as HTMLElement)).toBe(true);
		expect(slot.lastElementChild?.querySelector("button.reveal-json") ?? null).not.toBeNull();
		// Reset, when the row offers one, lives in the same slot - never in the
		// control cell, where its x would follow the control's width.
		for (const reset of Array.from(row.querySelectorAll("button.reset"))) {
			expect(slot.contains(reset)).toBe(true);
		}
		expect(row.querySelector(".setting-control button.reveal-json")).toBeNull();
		expect(row.querySelector(".setting-control button.reset")).toBeNull();
		// Both actions wear the one reveal idiom: wrapper opacity, both reveal
		// clauses, and the narrow-pane always-visible fallback.
		for (const wrap of Array.from(slot.children)) {
			expect(wrap.classList.contains("opacity-0")).toBe(true);
			expect(wrap.classList.contains("group-hover/setting:opacity-100")).toBe(true);
			expect(wrap.classList.contains("group-focus-within/setting:opacity-100")).toBe(true);
			expect(wrap.classList.contains("@max-[560px]/pane:opacity-100")).toBe(true);
		}
	}
	// No companion rows live on this page: the one companion (the language
	// filter's mode row) moved to the Features page with its setting, where
	// featureSettings.test.tsx pins it.
	expect(rows.filter((row) => row.classList.contains("setting-companion")).length).toBe(0);
});

test("the catalog status renders inside the row's own description slot, with the moved prose in the row's ?", () => {
	// The cluster lives in the row's hint cell where every other row shows its text, so the row reads label, checkbox,
	// status, "?" - and the sentence the status displaced is the tip's.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const row = rowOf(settingInput(root, "models.openRouterCatalog"));
	const status = row.querySelector(".catalog-status") as HTMLElement;
	expect(status).not.toBeNull();
	expect(status.closest(".setting-hint")).not.toBeNull();
	// No free-standing second line remains anywhere on the page.
	expect(root.querySelector(".catalog-row")).toBeNull();
	// The row's help tip carries the description that moved out of the row.
	const tip = row.querySelector(".setting-hint .tip-bubble") as HTMLElement;
	expect(tip.textContent).toBe(settingRowHelp("models.openRouterCatalog") ?? "");
	expect(tip.textContent).toContain("Fill missing model capabilities from the OpenRouter catalog");
	// With the description <label> displaced by the status, the checkbox must
	// still carry its name - the row's title, stated directly on the input -
	// while a label-named checkbox carries no second, competing name.
	const checkbox = settingInput(root, "models.openRouterCatalog");
	expect(checkbox.getAttribute("aria-label")).toBe("OpenRouter catalog");
	expect(settingInput(root, "ui.maskSecretInputs").hasAttribute("aria-label")).toBe(false);
});

test("the filter matches the catalog row's live status text, which is what its description slot shows", () => {
	// The static description moved into the tip; the slot shows the status
	// cluster, so its words are the row's haystack ("no refreshes" while off,
	// "bundled snapshot" while on) - a needle finds what it can see.
	const base = makeSettings();
	const off = makeSettings({ booleans: { ...base.booleans, "models.openRouterCatalog": false } });
	const root = mount(<SettingsSection settings={off} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;
	fireInput(filter, "no refreshes");
	expect(rowOf(settingInput(root, "models.openRouterCatalog")).hidden).toBe(false);
	expect(root.textContent).not.toContain("No settings match the filter.");

	cleanup();
	const bundled = makeSettings({ catalog: { modelCount: 100, lastSuccessAt: undefined, refreshing: false } });
	const onRoot = mount(<SettingsSection settings={bundled} models={[]} />);
	const onFilter = onRoot.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;
	fireInput(onFilter, "bundled snapshot");
	expect(rowOf(settingInput(onRoot, "models.openRouterCatalog")).hidden).toBe(false);
	fireInput(onFilter, "no refreshes");
	expect(rowOf(settingInput(onRoot, "models.openRouterCatalog")).hidden).toBe(true);
	// The static description is OUT of this row's haystack (isVisible matches the tip and live status only - two
	// independently translated keys cannot be trusted to stay identical outside English). Its words still find the row
	// through the tip, which in English opens with them, so no render-level needle can tell the two apart.
	fireInput(onFilter, "refreshed weekly");
	expect(rowOf(settingInput(onRoot, "models.openRouterCatalog")).hidden).toBe(false);
});

test("the catalog row states the snapshot's size and age, and Refresh posts refreshCatalog", () => {
	const now = Date.now();
	const settings = makeSettings({
		catalog: { modelCount: 321, lastSuccessAt: now - 5 * 60 * 1000, refreshing: false },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} now={now} />);
	const row = rowOf(settingInput(root, "models.openRouterCatalog"));
	expect(row.textContent).toContain("321 catalog models");
	expect(row.textContent).toContain("updated 5 min ago");

	const refresh = buttonByText(row, "Refresh");
	expect(refresh.disabled).toBe(false);
	resetPosted();
	fireClick(refresh);
	expect(postedCalls()).toEqual([{ method: "refreshCatalog", payload: null }]);
});

test("the catalog row without a refresh yet names the bundled snapshot; a running refresh disables the button", () => {
	const bundled = makeSettings({ catalog: { modelCount: 100, lastSuccessAt: undefined, refreshing: false } });
	const root = mount(<SettingsSection settings={bundled} models={[]} />);
	expect(rowOf(settingInput(root, "models.openRouterCatalog")).textContent).toContain("bundled snapshot");

	cleanup();
	const refreshing = makeSettings({ catalog: { modelCount: 100, lastSuccessAt: undefined, refreshing: true } });
	const busyRoot = mount(<SettingsSection settings={refreshing} models={[]} />);
	const busyRow = rowOf(settingInput(busyRoot, "models.openRouterCatalog"));
	const busy = Array.from(busyRow.querySelectorAll("button")).find((button) =>
		(button.textContent ?? "").includes("Refreshing...")
	) as HTMLButtonElement;
	expect(busy).toBeDefined();
	expect(busy.disabled).toBe(true);
});

test("the catalog status hides with the row it belongs to", () => {
	// The cluster renders inside the row's own hint cell, so the row's hidden
	// attribute covers it: a filter that hides the setting can no longer leave
	// its status and Refresh button stranded under another group.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;
	const row = rowOf(settingInput(root, "models.openRouterCatalog"));
	expect(row.contains(buttonByText(row, "Refresh"))).toBe(true);
	expect(row.hidden).toBe(false);
	fireInput(filter, "timeout");
	expect(rowOf(settingInput(root, "chat.timeout")).hidden).toBe(false);
	expect(row.hidden).toBe(true);
});

test("with the catalog setting off the row shows the inert hint instead of the status and Refresh", () => {
	const base = makeSettings();
	const settings = makeSettings({
		booleans: { ...base.booleans, "models.openRouterCatalog": false },
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const row = rowOf(settingInput(root, "models.openRouterCatalog"));
	expect(row.textContent).toContain("Catalog off:");
	// The off-state consequence moved into the row's "?" with the description;
	// asserted on the tip element itself, not row.textContent, which would
	// pass merely because the hidden bubble stays mounted.
	expect(row.querySelector(".setting-hint .tip-bubble")?.textContent).toContain(OPENROUTER_MODEL_DIRECTIVE);
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
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const row = rowOf(settingInput(root, "models.openRouterCatalog"));
	const failure = row.querySelector(".error") as HTMLElement;
	expect(failure.textContent).toBe("Last refresh failed (HTTP 503); serving the cached snapshot.");
	// The failure starts a line of its own - the break before it - while the
	// error span itself stays inline, so the row's trailing "?" can glue to
	// its last word instead of stranding alone on the next line.
	expect(failure.previousElementSibling?.tagName).toBe("BR");
	expect(document.querySelector(".toast")).toBeNull();
});

test("the record editors live inside the Models group, mirroring the manifest's grouping", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const modelsGroup = Array.from(root.querySelectorAll(".settings-group")).find(
		(group) => group.querySelector(".settings-group-title")?.textContent === "Models"
	) as HTMLElement;
	expect(modelsGroup).toBeDefined();
	const headings = Array.from(modelsGroup.querySelectorAll("h3")).map((h) => (h.textContent ?? "").trim());
	// Each heading names its section and nothing else: the help, docs and
	// settings.json controls are its siblings on the header line, so the
	// heading's accessible name is not three button labels long.
	expect(headings).toContain("Model parameters");
	expect(headings).toContain("Model capabilities");
	// Each editor appears once, inside the Models group. Counted by their own heading rather than by the header-line
	// class every section now shares: the question is how many editors there are, not how many headers.
	const editorHeads = Array.from(root.querySelectorAll(".section-head")).filter((head) => {
		const heading = (head.querySelector("h3")?.textContent ?? "").trim();
		return heading === "Model parameters" || heading === "Model capabilities";
	});
	expect(editorHeads.length).toBe(2);
	expect(editorHeads.every((head) => modelsGroup.contains(head))).toBe(true);
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
		usage: {
			statusBarMode: "always",
			statusBarScope: null,
			alertThresholds,
			thresholdsScope: null,
			currencySymbol: "$",
			currencySymbolScope: null,
		},
	});
}

test("the thresholds row renders the stored pair as percents and commits an edited pair sorted on blur", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const { warning, error } = thresholdBoxes(root);
	expect(warning.value).toBe("80%");
	expect(error.value).toBe("95%");

	// Sorting is the row's job: the lower value warns whichever box it sits in.
	fireInput(warning, "0.9");
	fireInput(error, "50%");
	fireBlur(error);
	expect(postedCalls()).toEqual([{ method: "setUsageAlertThresholds", payload: { values: [0.5, 0.9] } }]);

	// A draft equal to the stored list posts nothing on commit.
	resetPosted();
	fireInput(warning, "80%");
	fireInput(error, "0.95");
	fireKeyDown(error, "Enter");
	expect(postedMessages).toEqual([]);
});

test("a non-whole stored threshold reaches the boxes exactly, not floored to a whole percent", () => {
	// The alert toast and this row print one configured number through the same
	// exact renderer; a floor here would restate 0.855 as the 85% it is not.
	const root = mount(<SettingsSection settings={settingsWithThresholds([0.855, 0.99])} models={[]} />);
	const { warning, error } = thresholdBoxes(root);
	expect(warning.value).toBe("85.5%");
	expect(error.value).toBe("99%");
});

test("thresholds accept fractions, percent signs, and bare numbers above 1 as percents", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const { warning, error } = thresholdBoxes(root);
	fireInput(warning, "75");
	fireInput(error, "0.9");
	fireBlur(warning);
	expect(postedCalls()).toEqual([{ method: "setUsageAlertThresholds", payload: { values: [0.75, 0.9] } }]);
});

test("a blur that only moves focus to the sibling box does not commit the half-edited pair", () => {
	// The two boxes are one draft: committing on the Tab between them would
	// let the write's own state push resync the pair mid-edit.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const { warning, error } = thresholdBoxes(root);
	fireInput(warning, "60%");
	fireBlur(warning, error);
	expect(postedMessages).toEqual([]);

	// Leaving the pair commits once, with both edits.
	fireInput(error, "0.9");
	fireBlur(error);
	expect(postedCalls()).toEqual([{ method: "setUsageAlertThresholds", payload: { values: [0.6, 0.9] } }]);
});

test("one filled box means error-at-that-value: a single-element list plus the inline hint", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const { warning, error } = thresholdBoxes(root);

	// Only Error set.
	fireInput(warning, "");
	fireInput(error, "90%");
	expect(rowOf(error).textContent).toContain("A single threshold goes straight to the error alert.");
	fireBlur(error);
	expect(postedCalls()).toEqual([{ method: "setUsageAlertThresholds", payload: { values: [0.9] } }]);

	// Only Warning set: same single-value semantics, same hint.
	resetPosted();
	fireInput(error, "");
	fireInput(warning, "60%");
	expect(rowOf(warning).textContent).toContain("A single threshold goes straight to the error alert.");
	fireBlur(warning);
	expect(postedCalls()).toEqual([{ method: "setUsageAlertThresholds", payload: { values: [0.6] } }]);
});

test("a stored single-element list fills the Error box, and equal boxes collapse to one value", () => {
	const single = mount(<SettingsSection settings={settingsWithThresholds([0.9])} models={[]} />);
	const boxes = thresholdBoxes(single);
	expect(boxes.warning.value).toBe("");
	expect(boxes.error.value).toBe("90%");
	expect(rowOf(boxes.error).textContent).toContain("A single threshold goes straight to the error alert.");

	cleanup();
	resetPosted();
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const { warning, error } = thresholdBoxes(root);
	fireInput(warning, "0.9");
	fireInput(error, "90%");
	fireBlur(error);
	expect(postedCalls()).toEqual([{ method: "setUsageAlertThresholds", payload: { values: [0.9] } }]);
});

test("both boxes emptied turns alerts off: an empty list with the row saying so", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const { warning, error } = thresholdBoxes(root);
	fireInput(warning, "");
	fireInput(error, "");
	expect(rowOf(error).textContent).toContain("Alerts are off.");
	fireBlur(error);
	expect(postedCalls()).toEqual([{ method: "setUsageAlertThresholds", payload: { values: [] } }]);
});

test("an invalid threshold shows its error live and never posts: 0, over 100%, and non-numbers reject", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
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

test("render -> parse -> render is a fixed point for every representable threshold", () => {
	// The property commit() leans on: the box text a stored value renders to
	// must reparse to a value that renders the same text, or an untouched box
	// would read as an edit. Value space is NOT a fixed point (the specimen
	// below), so the rendered vocabulary is the one the pair compares in.
	fc.assert(
		fc.property(
			// The full representable range, with half the budget spent where real
			// thresholds live so the property is not all denormal exponents.
			fc.oneof(
				fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true }),
				fc.double({ min: 0.001, max: 1, noNaN: true })
			),
			(threshold) => {
				const rendered = formatPercentExact(threshold);
				const parsed = parseThresholdBox(rendered);
				expect(parsed.kind).toBe("value");
				if (parsed.kind === "value") {
					expect(formatPercentExact(parsed.value)).toBe(rendered);
				}
			}
		),
		{ seed: SEED, numRuns: NUM_RUNS }
	);
	// The 0.533 specimen: reparse lands an ulp low, yet the render is stable.
	expect(formatPercentExact(0.533)).toBe("53.3%");
	expect(parseThresholdBox("53.3%")).toEqual({ kind: "value", value: 0.5329999999999999 });
	expect(formatPercentExact(0.5329999999999999)).toBe("53.3%");
});

test("an untouched threshold box never rewrites settings on focus and blur", () => {
	// 0.533 is one of the stored values whose reparse shifts by an ulp; before
	// commit() compared rendered strings, focusing and leaving this box rewrote
	// settings.json to 0.5329999999999999 with no edit anywhere.
	const root = mount(<SettingsSection settings={settingsWithThresholds([0.533, 0.9])} models={[]} />);
	const { warning, error } = thresholdBoxes(root);
	expect(warning.value).toBe("53.3%");
	expect(error.value).toBe("90%");
	for (const box of [warning, error]) {
		box.focus();
		fireBlur(box);
		fireKeyDown(box, "Enter");
	}
	expect(postedMessages).toEqual([]);
});

test("an unsorted stored pair still normalizes on an untouched blur: ordering is a real difference", () => {
	// The no-rewrite guarantee compares rendered values in position, so a
	// stored [high, low] list the boxes display swapped commits back sorted -
	// a deliberate normalizing write, not float noise.
	const root = mount(<SettingsSection settings={settingsWithThresholds([0.9, 0.533])} models={[]} />);
	const { warning } = thresholdBoxes(root);
	warning.focus();
	fireBlur(warning);
	expect(postedCalls()).toEqual([
		{ method: "setUsageAlertThresholds", payload: { values: [0.5329999999999999, 0.9] } },
	]);
});

test("a hand-written list of 3+ values renders read-only with the values, the hint, and the reveal button", () => {
	const settings = makeSettings({
		usage: {
			statusBarMode: "always",
			statusBarScope: null,
			alertThresholds: [0.5, 0.8, 0.95],
			thresholdsScope: "global",
			currencySymbol: "$",
			currencySymbolScope: null,
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const row = Array.from(root.querySelectorAll(".setting-row")).find((candidate) =>
		candidate.textContent?.includes("Usage alert thresholds")
	) as HTMLElement;
	expect(row.textContent).toContain("50%, 80%, 95%");
	expect(row.textContent).toContain("Custom list - edit in settings.json.");
	// The description and hint describe THIS branch: the stored list's own semantics, never the two boxes' empty
	// drafts - which once printed "Alerts are off." beside a live 50/80/95 list.
	expect(row.textContent).toContain("Alerts fire as spend crosses each value.");
	expect(row.textContent).toContain("Warns from 50%; errors at 95%.");
	expect(row.textContent).not.toContain("Alerts are off.");
	expect(row.textContent).not.toContain("Clear both fields");
	// No inputs: the two boxes cannot represent the list, and rendering them
	// would let a blur destroy the hand-written values.
	expect(row.querySelector("input")).toBeNull();
	expect(row.querySelector("button[aria-label='Open Usage alert thresholds in settings.json']")).not.toBeNull();
});

test("the currency-symbol row renders the stored value and commits an edit on blur or Enter", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "usage.currencySymbol");
	expect(input.value).toBe("$");

	fireInput(input, "EUR ");
	fireBlur(input);
	expect(postedCalls()).toEqual([{ method: "setCurrencySymbol", payload: { value: "EUR " } }]);

	// A draft equal to the stored value posts nothing on commit.
	resetPosted();
	fireInput(input, "$");
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);
});

test("clearing the currency-symbol box commits the empty string (bare numbers), not a reset", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "usage.currencySymbol");
	fireInput(input, "");
	fireKeyDown(input, "Enter");
	expect(postedCalls()).toEqual([{ method: "setCurrencySymbol", payload: { value: "" } }]);
});

test("the currency box's maxLength reads the shared wire cap, not a private twin", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	expect(settingInput(root, "usage.currencySymbol").maxLength).toBe(WIRE_LIMITS.currencySymbol);
});

test("an over-limit symbol from settings.json round-trips whole, errors instead of committing, and recovers in place", () => {
	// maxLength gates typing only: a longer symbol hand-written in settings.json rides the state push into the box
	// unclamped. The row neither truncates it nor lets a commit die host-side - the bound is the row's own error.
	const long = "x".repeat(WIRE_LIMITS.currencySymbol + 3);
	const settings = makeSettings();
	const root = mount(
		<SettingsSection settings={{ ...settings, usage: { ...settings.usage, currencySymbol: long } }} models={[]} />
	);
	const input = settingInput(root, "usage.currencySymbol");
	expect(input.value).toBe(long);
	expect(rowOf(input).textContent).toContain(`At most ${WIRE_LIMITS.currencySymbol} characters.`);
	expect(input.getAttribute("aria-invalid")).toBe("true");
	fireKeyDown(input, "Enter");
	fireBlur(input);
	expect(postedMessages).toEqual([]);

	// An edited draft still over the cap keeps erroring and never posts...
	fireInput(input, "x".repeat(WIRE_LIMITS.currencySymbol + 1));
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);
	// ...and one at the cap commits.
	fireInput(input, "x".repeat(WIRE_LIMITS.currencySymbol));
	expect(rowOf(input).textContent).not.toContain("At most");
	expect(input.getAttribute("aria-invalid")).toBe("false");
	fireKeyDown(input, "Enter");
	expect(postedCalls()).toEqual([
		{ method: "setCurrencySymbol", payload: { value: "x".repeat(WIRE_LIMITS.currencySymbol) } },
	]);
});

test("the status-bar mode select posts setUsageStatusBar on change", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const select = root.querySelector("#setting-usage\\.statusBar") as HTMLSelectElement;
	expect(select).not.toBeNull();
	expect(select.value).toBe("always");

	void act(() => {
		select.value = "alerts-only";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(postedCalls()).toEqual([{ method: "setUsageStatusBar", payload: { value: "alerts-only" } }]);
});

test("the token-estimation select renders in the Chat group with the default and posts setTokenEstimation on change", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const select = root.querySelector("#setting-chat\\.tokenEstimation") as HTMLSelectElement;
	expect(select).not.toBeNull();
	expect(select.value).toBe("auto");
	expect(Array.from(select.options).map((option) => option.value)).toEqual([
		"auto",
		"heuristic",
		"o200k_base",
		"cl100k_base",
	]);
	// The row rides the Chat group, beside the scalar chat settings.
	const group = select.closest(".settings-group") as HTMLElement;
	expect(group.querySelector("#setting-chat\\.timeout")).not.toBeNull();

	void act(() => {
		select.value = "o200k_base";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(postedCalls()).toEqual([{ method: "setTokenEstimation", payload: { value: "o200k_base" } }]);
});

test("the tool-schema-keywords box renders in the Chat group and posts the parsed, deduplicated list on commit", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "chat.additionalToolSchemaKeywords");
	expect(input.value).toBe("");
	// The row rides the Chat group, beside the scalar chat settings.
	const group = input.closest(".settings-group") as HTMLElement;
	expect(group.querySelector("#setting-chat\\.timeout")).not.toBeNull();

	fireInput(input, " propertyNames, , patternProperties,propertyNames ");
	fireKeyDown(input, "Enter");
	expect(postedCalls()).toEqual([
		{ method: "setAdditionalToolSchemaKeywords", payload: { values: ["propertyNames", "patternProperties"] } },
	]);
});

test("a stored keyword list round-trips into the box, and an unchanged blur posts nothing", () => {
	const settings = makeSettings({
		chat: {
			tokenEstimation: "auto",
			tokenEstimationScope: null,
			additionalToolSchemaKeywords: { values: ["propertyNames", "patternProperties"], lossy: false, scope: "global" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const input = settingInput(root, "chat.additionalToolSchemaKeywords");
	expect(input.value).toBe("propertyNames, patternProperties");
	fireBlur(input);
	expect(postedMessages).toEqual([]);
});

test("a keyword draft past the intent schema's bounds shows the bound and never posts", () => {
	// The bounds mirror intentSchema.ts (z.array(z.string().max(256)).max(64)):
	// without the mirror a big paste committed, failed host-side, and surfaced
	// as a generic envelope failure instead of a row error.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "chat.additionalToolSchemaKeywords");

	fireInput(input, Array.from({ length: 65 }, (_, index) => `k${index}`).join(", "));
	expect(rowOf(input).textContent).toContain("At most 64 keywords.");
	expect(input.getAttribute("aria-invalid")).toBe("true");
	fireKeyDown(input, "Enter");
	fireBlur(input);
	expect(postedMessages).toEqual([]);

	fireInput(input, `ok, ${"x".repeat(257)}`);
	expect(rowOf(input).textContent).toContain("Keywords run up to 256 characters each.");
	fireKeyDown(input, "Enter");
	expect(postedMessages).toEqual([]);

	// Back inside the bounds, the same draft machinery commits normally.
	fireInput(input, "propertyNames");
	expect(input.getAttribute("aria-invalid")).toBe("false");
	fireKeyDown(input, "Enter");
	expect(postedCalls()).toEqual([
		{ method: "setAdditionalToolSchemaKeywords", payload: { values: ["propertyNames"] } },
	]);
});

test("a lossy stored list (entries normalization dropped) renders read-only even when the visible list looks clean", () => {
	// The push carries only the NORMALIZED list, so a raw ["propertyNames", "constructor"] arrives as just
	// ["propertyNames"] - nothing the shape check can see. The host's lossy flag is what keeps a dashboard edit
	// from silently destroying the hidden entry.
	const settings = makeSettings({
		chat: {
			tokenEstimation: "auto",
			tokenEstimationScope: null,
			additionalToolSchemaKeywords: { values: ["propertyNames"], lossy: true, scope: "global" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const row = Array.from(root.querySelectorAll(".setting-row")).find((candidate) =>
		candidate.textContent?.includes("Extra tool schema keywords")
	) as HTMLElement;
	expect(row.textContent).toContain("Custom list - edit in settings.json.");
	expect(row.querySelector("input")).toBeNull();
});

test("a stored keyword the comma box cannot round-trip renders read-only with the reveal button", () => {
	const settings = makeSettings({
		chat: {
			tokenEstimation: "auto",
			tokenEstimationScope: null,
			additionalToolSchemaKeywords: { values: ["a,b"], lossy: false, scope: "global" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const row = Array.from(root.querySelectorAll(".setting-row")).find((candidate) =>
		candidate.textContent?.includes("Extra tool schema keywords")
	) as HTMLElement;
	expect(row.textContent).toContain("a,b");
	expect(row.textContent).toContain("Custom list - edit in settings.json.");
	// No input: a blur would rewrite the hand-written entry as two keywords.
	expect(row.querySelector("input")).toBeNull();
	expect(row.querySelector("button[aria-label='Open Extra tool schema keywords in settings.json']")).not.toBeNull();
});

/** The Import & Export group, addressed as the last settings group (its pinned position). */
function importExportGroup(root: ParentNode): HTMLElement {
	const group = Array.from(root.querySelectorAll(".settings-group")).pop();
	if (!(group instanceof HTMLElement)) {
		throw new Error("no settings groups rendered");
	}
	return group;
}

test("the Import & Export group renders last with its help, and each button posts exactly its command", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const group = importExportGroup(root);
	const head = group.querySelector(".settings-group-head");
	// The heading names the group and nothing else: the Help button is its
	// sibling, so the group does not announce as "Import & Export Help: ...".
	expect(group.querySelector(".settings-group-title")?.textContent).toBe("Import & Export");
	// The explanation moved out of a standing paragraph and behind the glyph;
	// it is still on the page, and still reachable as the trigger's description.
	expect(group.querySelector("p.hint")).toBeNull();
	expect(head?.querySelector('[role="tooltip"]')?.textContent).toContain("Export writes your settings to a JSON file");
	const helpButton = head?.querySelector("button.help");
	expect(helpButton?.getAttribute("aria-label")).toBe("Help: Import & Export");
	expect(helpButton?.getAttribute("aria-describedby")).toBe(
		head?.querySelector('[role="tooltip"]')?.getAttribute("id")
	);

	const exportButton = buttonByText(group, "Export settings");
	const importButton = buttonByText(group, "Import settings");
	for (const button of [exportButton, importButton]) {
		expect(button.getAttribute("type")).toBe("button");
		// Primary rank: the two actions are the section's whole content, so there
		// is no quieter neighbour for a supporting rank to sit under.
		expect(button.getAttribute("data-variant")).toBe("default");
	}

	fireClick(exportButton);
	expect(postedCalls()).toEqual([{ method: "executeCommand", payload: { command: "exportSettings" } }]);
	resetPosted();
	fireClick(importButton);
	expect(postedCalls()).toEqual([{ method: "executeCommand", payload: { command: "importSettings" } }]);
});

test("the Import & Export group follows the filter: kept by its own words, hidden on a miss, counted by no-match", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;
	const group = importExportGroup(root);
	expect(group.hidden).toBe(false);

	// Its title and button labels match like a scalar row's label would - and
	// exclusively: no scalar label or description mentions "export", so every
	// scalar row hides while the group stays.
	fireInput(filter, "export");
	expect(group.hidden).toBe(false);
	expect(rowOf(settingInput(root, "chat.timeout")).hidden).toBe(true);
	expect(root.textContent).not.toContain("No settings match the filter.");

	// The GROUP's help string is deliberately NOT in the haystack, unlike the rows' own help: a group kept alive by
	// words behind its heading's glyph would stand with rows the needle matches nowhere.
	fireInput(filter, "another machine");
	expect(group.hidden).toBe(true);
	expect(root.textContent).toContain("No settings match the filter.");

	// A scalar-only needle hides the group whole (hidden, never unmounted).
	fireInput(filter, "timeout");
	expect(group.hidden).toBe(true);

	// A pure miss counts the group out of the no-match verdict too.
	fireInput(filter, "no such setting");
	expect(root.textContent).toContain("No settings match the filter.");

	fireInput(filter, "");
	expect(group.hidden).toBe(false);
});

test("the theme select posts setUiTheme, and the accent swatches post setUiAccent with the checked one following state", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const select = root.querySelector("#setting-ui\\.theme");
	if (!(select instanceof HTMLSelectElement)) {
		throw new Error("no theme select");
	}
	expect(select.value).toBe("auto");
	// ...and the controls render the stored value, not a hardcoded default.
	const pinned = mount(
		<SettingsSection
			settings={makeSettings({
				appearance: { theme: "light", themeScope: "workspace", accent: "amber", accentScope: "global" },
			})}
			models={[]}
		/>
	);
	const pinnedSelect = pinned.querySelector("#setting-ui\\.theme");
	expect(pinnedSelect instanceof HTMLSelectElement ? pinnedSelect.value : undefined).toBe("light");
	expect(
		[...pinned.querySelectorAll('input[name="ui-accent"]')]
			.filter((node): node is HTMLInputElement => node instanceof HTMLInputElement && node.checked)
			.map((node) => node.value)
	).toEqual(["amber"]);
	// A configured row shows its scope and offers a Reset; both rows are
	// configured here, so neither branch is left unrendered.
	expect(pinned.textContent).toContain("Workspace");
	fireSelect(select, "dark");
	expect(postedCalls()).toEqual([{ method: "setUiTheme", payload: { value: "dark" } }]);

	resetPosted();
	const swatches = [...root.querySelectorAll('input[name="ui-accent"]')].filter(
		(node): node is HTMLInputElement => node instanceof HTMLInputElement
	);
	// Every hue is offered, not just the live one - the choice is the color.
	expect(swatches.map((input) => input.value)).toEqual(["blue", "violet", "teal", "amber"]);
	expect(swatches.filter((input) => input.checked).map((input) => input.value)).toEqual(["blue"]);
	const teal = swatches[2];
	if (teal === undefined) {
		throw new Error("no teal swatch");
	}
	fireCheck(teal, true);
	expect(postedCalls()).toEqual([{ method: "setUiAccent", payload: { value: "teal" } }]);
});

test("a filter matching only an appearance row shows it instead of the nothing-matched line", () => {
	// The empty-state verdict reads the scalar rows; a tail row that matched
	// while the verdict said nothing did rendered both at once.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const filter = root.querySelector('input[aria-label="Filter settings"]');
	if (!(filter instanceof HTMLInputElement)) {
		throw new Error("no settings filter");
	}
	fireInput(filter, "ui.accent");
	expect(root.textContent).not.toContain("No settings match the filter.");
	const accentRow = [...root.querySelectorAll(".setting-row")].find(
		(row) => row instanceof HTMLElement && !row.hidden && row.textContent?.includes("Accent color") === true
	);
	expect(accentRow).toBeDefined();
});

test("appearance rides every state push onto the root element, so a setting change lands without a reopen", () => {
	// The HTML shell stamps these once at panel creation. Live-apply is this
	// effect: the picker (or a hand edit of settings.json) writes the setting,
	// the configuration change re-pushes state, and the root restamps.
	document.documentElement.dataset.theme = "auto";
	document.documentElement.dataset.accent = "blue";
	mount(<App />);
	act(() => {
		pushToWebview(
			statePush(
				makeState({
					settings: makeSettings({
						appearance: { theme: "dark", themeScope: "global", accent: "amber", accentScope: "global" },
					}),
				})
			)
		);
	});
	expect(document.documentElement.dataset.theme).toBe("dark");
	expect(document.documentElement.dataset.accent).toBe("amber");
	// A second push has to land too: the effect keys on the pushed object, and
	// an appearance that only ever restamped once would pass a single-push test
	// while leaving an open dashboard stuck after the reader's second change.
	act(() => {
		pushToWebview(
			statePush(
				makeState({
					settings: makeSettings({
						appearance: { theme: "light", themeScope: "global", accent: "teal", accentScope: "global" },
					}),
				})
			)
		);
	});
	expect(document.documentElement.dataset.theme).toBe("light");
	expect(document.documentElement.dataset.accent).toBe("teal");
});

test("the settings filter finds a row by its description and its id, whichever kind of row it is", () => {
	// The two predicates used to disagree: scalar rows matched label plus description and ignored the id, tail rows
	// matched title plus id and ignored the description.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const filter = root.querySelector('input[aria-label="Filter settings"]');
	if (!(filter instanceof HTMLInputElement)) {
		throw new Error("no settings filter");
	}
	const visibleRowTitles = (): string[] =>
		[...root.querySelectorAll(".setting-row")]
			.filter((row): row is HTMLElement => row instanceof HTMLElement && !row.hidden)
			.map((row) => row.querySelector(".setting-title")?.textContent ?? "");

	// A tail row found by a word from its description.
	fireInput(filter, "light or dark");
	expect(root.textContent).not.toContain("No settings match the filter.");
	expect(visibleRowTitles()).toContain("Dashboard theme");

	// A scalar row found by its setting id.
	fireInput(filter, "ui.maskSecretInputs");
	expect(root.textContent).not.toContain("No settings match the filter.");
	expect(visibleRowTitles().length).toBeGreaterThan(0);

	// And a needle matching nothing still says so.
	fireInput(filter, "zzzzz-no-such-setting");
	expect(root.textContent).toContain("No settings match the filter.");
});

test("a failed write reports under the row the fail envelope names, covering the description slot", () => {
	// The fail envelope carries the owning row (extension-derived from the refused payload; never payload text), so
	// the page places each standing notice with no correlation state of its own. Placement is the covered-description
	// slot the parse errors already use, not an inserted block, which would move every row below it. The slot carries
	// the framed HEADLINE only.
	const failure = { seq: 1, row: "chat.timeout" as const, message: "the write was refused\nsetting detail line" };
	const withFailure = mount(
		<SettingsSection settings={makeSettings()} models={[]} writeFailures={{ setNumberSetting: failure }} />
	);
	const hint = rowOf(settingInput(withFailure, "chat.timeout")).querySelector(".setting-hint");
	const notice = hint?.querySelector(".error");
	expect(notice?.textContent).toBe("The last change did not apply: the write was refused");
	// Headline only: the detail line stays off this surface (the host
	// notifier's toast rule), because the covered cell cannot grow for it.
	expect(notice?.textContent).not.toContain("setting detail line");
	// Covered, not inserted: the resting flow's invisible twin keeps the cell's
	// height while the notice takes the live flow, so the refusal landing moves
	// nothing - and the row's one glyph trails the notice's own tail.
	expect(hint?.querySelector(".setting-twin .setting-desc")).not.toBeNull();
	const cover = notice?.closest(".setting-cover");
	expect(cover?.parentElement?.classList.contains("setting-live")).toBe(true);
	expect(cover?.parentElement?.querySelector("button.help")).not.toBeNull();
	// Announced: a refusal after a quiet blur commit is otherwise invisible.
	expect(notice?.getAttribute("role")).toBe("alert");
	// No inserted diagnostic block anywhere, and no section-top double.
	expect(withFailure.querySelector(".row-diagnostic")).toBeNull();
	expect(withFailure.querySelector("p.error[role='alert']")).toBeNull();
});

test("a live parse error outranks the standing write failure in the covered slot", () => {
	// The error describes the draft under the user's fingers, the failure the
	// commit before it; both at once would be two sentences in one cell. The
	// failure resurfaces when the draft parses clean again.
	const withFailure = mount(
		<SettingsSection
			settings={makeSettings()}
			models={[]}
			writeFailures={{ setNumberSetting: { seq: 1, row: "chat.timeout", message: "the write was refused" } }}
		/>
	);
	const failedInput = settingInput(withFailure, "chat.timeout");
	const hint = () => rowOf(failedInput).querySelector(".setting-hint");
	expect(hint()?.querySelector(".error")?.textContent).toContain("the write was refused");
	fireInput(failedInput, "not a number");
	fireBlur(failedInput);
	expect(hint()?.querySelector(".error")?.textContent).toContain("Not a duration");
	expect(hint()?.textContent).not.toContain("the write was refused");
	fireInput(failedInput, "5000");
	expect(hint()?.querySelector(".error")?.textContent).toContain("the write was refused");
});

test("a failure arriving while a parse error holds the slot still announces when it surfaces", () => {
	// The announce-once registry records what the hook is handed: fed the seq unconditionally, a failure landing behind
	// a live parse error was marked spoken with nothing visible having spoken it. The seq reaches the hook only while
	// the failure branch renders, so the first render that SHOWS it speaks it, exactly once.
	const container = mount(
		<AnnounceOnceScope>
			<SettingsSection settings={makeSettings()} models={[]} />
		</AnnounceOnceScope>
	);
	const hint = () => rowOf(settingInput(container, "chat.timeout")).querySelector(".setting-hint");

	// A live parse error holds the slot when the refusal lands.
	fireInput(settingInput(container, "chat.timeout"), "not a number");
	fireBlur(settingInput(container, "chat.timeout"));
	render(
		<AnnounceOnceScope>
			<SettingsSection
				settings={makeSettings()}
				models={[]}
				writeFailures={{ setNumberSetting: { seq: 1, row: "chat.timeout", message: "the write was refused" } }}
			/>
		</AnnounceOnceScope>,
		container
	);
	expect(hint()?.querySelector(".error")?.textContent).toContain("Not a duration");
	// The draft parses clean again: the failure surfaces AND announces.
	fireInput(settingInput(container, "chat.timeout"), "5000");
	const surfaced = hint()?.querySelector(".error");
	expect(surfaced?.textContent).toContain("the write was refused");
	expect(surfaced?.getAttribute("role")).toBe("alert");
	// Spoken once: the registry stands the role down on the next render.
	fireInput(settingInput(container, "chat.timeout"), "6000");
	expect(hint()?.querySelector(".error")?.getAttribute("role")).toBeNull();
});

test("a failure no row claims falls back to one section-top line", () => {
	// A refusal whose payload never parsed carries no row (the extension cannot
	// derive one), and it still has to surface somewhere.
	const root = mount(
		<SettingsSection
			settings={makeSettings()}
			models={[]}
			writeFailures={{ setUsageStatusBar: { seq: 2, message: "the write was refused" } }}
		/>
	);
	expect(root.querySelector(".setting-hint .error")).toBeNull();
	expect(root.querySelector("p.error[role='alert']")?.textContent).toContain(
		"The last change did not apply: the write was refused"
	);
});

test("two methods' failures on one row keep the latest, not the method-list order", () => {
	// A row can post two kinds of write (its value and its Reset); the newer failure is the one the reader acted on
	// last. Without the seq comparison, resetSetting's later position in the method list let an OLDER reset win.
	const configured = makeSettings();
	const settings = {
		...configured,
		configuredScopes: {
			...configured.configuredScopes,
			numbers: { ...configured.configuredScopes.numbers, "usage.pollInterval": "global" as const },
		},
	};
	const withBoth = mount(
		<SettingsSection
			settings={settings}
			models={[]}
			writeFailures={{
				resetSetting: { seq: 3, row: "usage.pollInterval", message: "the older reset failure" },
				setNumberSetting: { seq: 9, row: "usage.pollInterval", message: "the newer write failure" },
			}}
		/>
	);
	const row = rowOf(settingInput(withBoth, "usage.pollInterval"));
	const notice = row.querySelector(".setting-hint .error");
	expect(notice?.textContent).toContain("the newer write failure");
	expect(notice?.textContent).not.toContain("the older reset failure");
});

test("a failure whose owning row the filter hides routes to the section-top line instead of a hidden notice", () => {
	// The filter hides rows without unmounting them, so a claimed notice under
	// a hidden row would be placed and invisible at once - the worst of both.
	const withFailure = mount(
		<SettingsSection
			settings={makeSettings()}
			models={[]}
			writeFailures={{ setNumberSetting: { seq: 1, row: "chat.timeout", message: "the write was refused" } }}
		/>
	);
	// Visible row: the notice stands in its covered slot.
	expect(withFailure.querySelector(".setting-hint .error")).not.toBeNull();
	expect(withFailure.querySelector("p.error[role='alert']")).toBeNull();

	// Filter the owning row away: the notice moves to the always-visible line.
	const filter = withFailure.querySelector('input[aria-label="Filter settings"]');
	if (!(filter instanceof HTMLInputElement)) {
		throw new Error("no settings filter");
	}
	fireInput(filter, "currency");
	expect(withFailure.querySelector(".setting-hint .error")).toBeNull();
	expect(withFailure.querySelector("p.error[role='alert']")?.textContent).toContain(
		"The last change did not apply: the write was refused"
	);
});
