/**
 * The scalar settings form: draft parsing and commit rules, the blur-gated
 * display of bound errors, the draftSyncKey resync contract, Reset naming and
 * posting, the modified-scope notes with their defaults, and the ms
 * equivalence hints.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { RpcRequest } from "../../../../dashboard/endpoints";
import { WIRE_LIMITS } from "../../../../dashboard/endpoints";
import { isBoundViolation, parseNumberDraft } from "../../../../dashboard/presenters";
import { NUMBER_SETTING_IDS } from "../../../../dashboard/viewModels";
import { AnnounceOnceScope } from "../../../../webview/dashboard/announceOnce";
import { App } from "../../../../webview/dashboard/app";
import { settingRowHelp } from "../../../../webview/dashboard/helpText";
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

test("a row's help glyph trails the description inline, inside the resting flow an overlay covers whole", () => {
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	// The glyph used to hold a phantom column past a 46ch prose box, which put
	// a lone "?" at a different distance from every sentence. It now flows
	// INLINE after the description's last word - same position relative to the
	// words on every row - inside the .setting-rest wrapper that an overlay
	// hides whole (the glyph re-renders at the overlay's own tail then; the
	// covered test below pins that half).
	const hint = rowOf(settingInput(root, "discovery.cacheTtl")).querySelector(".setting-hint");
	expect(hint).not.toBeNull();
	const help = hint?.querySelector("button.help");
	expect(help).not.toBeNull();
	// The glyph rides inside a nowrap glue span (Chrome breaks before an
	// atomic inline even after a no-break space, so the NBSP alone let a lone
	// "?" orphan onto its own line); the span lives in the resting-flow
	// wrapper, which is display: contents so it adds no box to the inline
	// flow, and the glyph still stays outside the description span itself.
	const glue = help?.closest(".help-wrap")?.parentElement;
	expect(glue?.classList.contains("whitespace-nowrap")).toBe(true);
	const rest = glue?.parentElement;
	expect(rest?.classList.contains("setting-rest")).toBe(true);
	expect(rest?.classList.contains("contents")).toBe(true);
	expect(rest?.parentElement).toBe(hint as HTMLElement);
	expect(hint?.querySelector(".setting-desc")?.querySelector("button.help")).toBeNull();
	// The cell owns wrapping and breaking (one unbroken token must not push out
	// of the column), and caps its prose at a reading measure inside the
	// full-bleed track: structure goes full-bleed, sentences do not.
	expect(hint?.classList.contains("break-words")).toBe(true);
	expect(hint?.classList.contains("min-w-0")).toBe(true);
	expect(hint?.classList.contains("max-w-[72ch]")).toBe(true);
	expect(Array.from(hint?.classList ?? []).some((name) => name.startsWith("grid"))).toBe(false);
});

test("an error covers the hint cell without taking its height, and carries the glyph at its own tail", () => {
	// The rules that keep the form still while you type, none of which
	// happy-dom can observe by measuring, and all of which sit in the cell this
	// change reorganized: the resting flow stays in flow (invisible, not
	// removed) so the row keeps the height it had, the error rides an absolute
	// cover inside the relative cell so it adds none, the cover lets clicks
	// through, and the help glyph re-renders at the error text's tail with its
	// own pointer-events restored - painted through the overlay it collided
	// with the words in dark and vanished under forced colors' backplate.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "discovery.cacheTtl");
	fireInput(input, "not a number");
	const hint = rowOf(input).querySelector(".setting-hint");
	const rest = hint?.querySelector(".setting-rest");
	const error = hint?.querySelector(".error");
	const cover = error?.closest(".setting-cover");

	expect(error?.textContent).toContain("Not a duration");
	expect(rest).not.toBeNull();
	expect(rest?.querySelector(".setting-desc")).not.toBeNull();
	expect(rest?.classList.contains("invisible")).toBe(true);
	expect(hint?.classList.contains("relative")).toBe(true);
	expect(cover?.classList.contains("absolute")).toBe(true);
	expect(cover?.classList.contains("inset-0")).toBe(true);
	expect(cover?.classList.contains("pointer-events-none")).toBe(true);
	// The error span holds the message alone (the field's aria-describedby
	// reads its subtree, so a glyph inside it would announce its own name with
	// every problem); the glyph is its cover-mate, clickable again.
	expect(error?.querySelector("button.help")).toBeNull();
	const coverGlyph = cover?.querySelector("button.help");
	expect(coverGlyph).not.toBeNull();
	expect(coverGlyph?.closest(".pointer-events-auto")).not.toBeNull();
});

test("the help glyph hands focus to its visible twin when an overlay lands and when it clears", () => {
	// The resting "?" and the cover's are two mounts of one control, and a
	// swap can land while the reader is ON it: a hidden or removed element
	// cannot keep focus, so without the hand-off the keyboard falls to the
	// body mid-read. check-geometry's settings-write-failure-overlay pair
	// asserts the same hand-off in a real browser.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "discovery.cacheTtl");
	const hint = () => rowOf(input).querySelector(".setting-hint") as HTMLElement;
	const restGlyph = hint().querySelector(".setting-rest button.help") as HTMLButtonElement;
	// Real focus (activeElement moves), act-wrapped because the tip primitive
	// updates state on focus.
	void act(() => restGlyph.focus());
	expect(document.activeElement).toBe(restGlyph);

	fireInput(input, "not a number");
	const coverGlyph = hint().querySelector(".setting-cover button.help");
	expect(coverGlyph).not.toBeNull();
	expect(document.activeElement).toBe(coverGlyph as HTMLElement);

	fireInput(input, "5000");
	expect(hint().querySelector(".setting-cover")).toBeNull();
	expect(document.activeElement).toBe(hint().querySelector(".setting-rest button.help") as HTMLElement);
});

test("a repeat failure's remounted cover keeps the focused glyph's keyboard", () => {
	// The cover is keyed on the failure seq (a repeat must re-announce), so a
	// second refusal REPLACES the cover while covered never flips - the
	// hand-off has to follow the slot's tenant identity, not just the flag,
	// or the destroyed glyph drops focus to the document between failures.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "chat.timeout");
	fireInput(input, "5000");
	fireBlur(input);
	const posted = postedMessages.filter((message) => message.method === "setNumberSetting").pop();
	const failureAt = (seq: number) =>
		render(
			<SettingsSection
				settings={makeSettings()}
				models={[]}
				writeFailures={{ setNumberSetting: { seq, id: posted?.id ?? "", message: `refused (attempt ${seq})` } }}
			/>,
			root
		);
	failureAt(1);
	const hint = () => rowOf(settingInput(root, "chat.timeout")).querySelector(".setting-hint") as HTMLElement;
	const firstGlyph = hint().querySelector(".setting-cover button.help") as HTMLButtonElement;
	void act(() => firstGlyph.focus());
	expect(document.activeElement).toBe(firstGlyph);

	failureAt(2);
	const secondGlyph = hint().querySelector(".setting-cover button.help") as HTMLButtonElement;
	expect(hint().textContent).toContain("refused (attempt 2)");
	expect(secondGlyph.isConnected).toBe(true);
	expect(document.activeElement).toBe(secondGlyph);

	// The negative half: a deliberate blur (Escape, a click on the page
	// background - a null relatedTarget from a still-connected glyph) means
	// the reader LEFT, and the next tenant swap must not steal focus back.
	void act(() => secondGlyph.blur());
	expect(document.activeElement).not.toBe(secondGlyph);
	failureAt(3);
	expect(hint().textContent).toContain("refused (attempt 3)");
	expect(document.activeElement).toBe(document.body);
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
	// At rest the gutter bar is the whole signal; the note exists for hover
	// and focus (the reveal wrapper's opacity idiom), lives in the hint cell
	// with the prose, and says only the fact worth revealing - the built-in
	// default a Reset would head toward.
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
	// Inside the resting-flow wrapper (display: contents, so it is still the
	// hint cell's own inline flow), after the glyph.
	expect(note?.parentElement?.classList.contains("setting-rest")).toBe(true);
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
	// chat.maxToolsPerRequest is the count-unit setting: type="number" (no
	// suffix grammar to swallow), whole values only. "1.5" has no reading
	// under the count grammar, so the error shows on the keystroke (a parse
	// failure, not a blur-gated bound) and the draft never commits.
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
	// A workspace override is the case the gutter bar alone cannot
	// disambiguate ("my user setting is not what applies here"), so its note
	// stands at rest - no reveal idiom - and the ms default reads in the
	// duration idiom, matching the field's hint.
	expect(noteOf("chat.timeout")?.textContent).toBe("Modified in Workspace settings (default: 5 min)");
	expect(noteOf("chat.timeout")?.classList.contains("opacity-0")).toBe(false);
	// A User-scope boolean has no default worth revealing and no scope worth
	// naming: the bar is the whole annotation.
	expect(noteOf("ui.maskSecretInputs")).toBeNull();
	// An unmodified number row reserves the note's box as an invisible,
	// aria-hidden spacing twin: the revealed note holds in-flow space on a
	// modified row (opacity, never display), so without the twin, marking a
	// row modified re-wrapped its description line and the row grew - a state
	// change moving layout. The twin never reveals (no reveal variants, no
	// data-slot for the bordered modes' at-rest reveal) and says nothing to
	// assistive tech: a clean row's value IS the default.
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
	// The section's own glyph is named by the Section primitive, for the same
	// reason: a button called "Settings" that performs no action is a trap.
	// Addressed through its own heading, because the record editors below carry
	// the same header-line class and a bare selector would take whichever came
	// first in the DOM.
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
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter settings"]') as HTMLInputElement;

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

test("the filter matches a row's help text", () => {
	// The searchable synonyms moved into the "?" tips when the long
	// explanations left the descriptions, so the tips are part of a row's
	// haystack: the row's glyph is visible at rest and its tip carries the
	// match. Group-level help stays out; the Import & Export test below holds
	// that boundary.
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
	// The earlier design capped the page at a 56rem measure; the redesign
	// revoked it - this page is a LIST of settings, and its one right edge is
	// the pane's own, held by the rows' fixed trailing actions track. What
	// this pins is that nobody quietly reintroduces a cap on one of the two
	// containers and mints a second right edge.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const groups = root.querySelector(".settings-groups") as HTMLElement;
	const header = root.querySelector(".page-section > .section-head") as HTMLElement;
	for (const surface of [groups, header]) {
		expect(Array.from(surface.classList).some((name) => name.startsWith("max-w-"))).toBe(false);
	}
	// The fixed actions track is what makes the edge one: every row wears the
	// same template, and its last track is a rem length, not auto.
	const row = root.querySelector(".setting-row") as HTMLElement;
	const template = Array.from(row.classList).find((name) => name.startsWith("grid-cols-["));
	expect(template).toMatch(/_[\d.]+rem\]$/);
});

test("the title's stacked flip shares the row grid's threshold, read off the grid itself", () => {
	// Re-homed from the deleted catalog-grid test: SETTING_TITLE's stacked
	// variant is its own class string (Tailwind compiles only whole variants),
	// and nothing but this stops the label flipping left at one width while
	// the columns turn two-track at another. The prefix is derived from the
	// row's own stacked override, so the two tiers cannot drift apart by one
	// edit. The two-track template lives in an exclusive band (it hands the
	// narrowest tier back to one column), so the stack threshold is the
	// band's own @max half.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const row = root.querySelector(".setting-row") as HTMLElement;
	const tracks = Array.from(row.classList).filter((name) => name.includes("grid-cols-"));
	const stackedTemplate = "grid-cols-[auto_minmax(0,1fr)]";
	const band = tracks.find((name) => name.startsWith("@") && name.endsWith(stackedTemplate)) ?? "";
	const stacked = /(@max-\[\d+px\]\/pane:)/.exec(band)?.[1] ?? "";
	expect(stacked).toMatch(/^@max-\[\d+px\]\/pane:$/);
	const title = root.querySelector(".setting-title") as HTMLElement;
	expect(title.classList.contains(`${stacked}text-left`)).toBe(true);
});

test("every settings row anchors its actions in one trailing slot: Reset then the settings.json jump", () => {
	// The fail-closed structural pin behind the "{} renders in two different
	// positions" defect: the slot is the row template's LAST cell, the jump is
	// the slot's LAST child, and no action leaks into the control or hint
	// cells - asserted over every row the page renders, against the page's own
	// row INVENTORY rather than a floor: every scalar id plus the seven
	// non-scalar rows (token estimation, tool schema keywords, thresholds,
	// status bar, currency, theme, accent). Exact equality is what fails
	// closed both ways - a dropped row and an uncounted new row both land
	// here, and adding a tail row costs updating the 7.
	const base = makeSettings();
	const settings = makeSettings({
		configuredScopes: {
			numbers: { ...base.configuredScopes.numbers, "chat.timeout": "global" },
			booleans: { ...base.configuredScopes.booleans, "ui.maskSecretInputs": "workspace" },
		},
	});
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const rows = Array.from(root.querySelectorAll(".setting-row"));
	expect(rows.length).toBe(
		Object.keys(settings.configuredScopes.numbers).length + Object.keys(settings.configuredScopes.booleans).length + 7
	);
	for (const row of rows) {
		const slots = Array.from(row.children).filter((child) => child.classList.contains("setting-actions"));
		expect(slots.length, row.textContent ?? "").toBe(1);
		const slot = slots[0] as HTMLElement;
		expect(row.lastElementChild).toBe(slot);
		const jumps = row.querySelectorAll("button.reveal-json");
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
});

test("the catalog status renders inside the row's own description slot, with the moved prose in the row's ?", () => {
	// The cluster used to be a second grid line under the row; it now lives in
	// the row's hint cell where every other row shows its text, so the row
	// reads label, checkbox, status, "?" - and the sentence the status
	// displaced is the tip's.
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
	// The static description is OUT of this row's haystack (isVisible matches
	// the row on its tip and live status only - two independently translated
	// keys cannot be trusted to stay identical outside English). Its words
	// still find the row, through the tip that visibly opens with them; in
	// English the description is a prefix of the tip, so no render-level
	// needle can tell the two apart - the exclusion lives in isVisible's
	// catalog branch and its comment.
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
	expect(row.querySelector(".setting-hint .tip-bubble")?.textContent).toContain("_openrouter_model");
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
	// Each editor appears once, and inside the Models group. Counted by their own
	// heading rather than by the header-line class, which every section on the
	// page now shares: the question is how many editors there are, not how many
	// headers.
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
	// The description and hint describe THIS branch: the stored list's own
	// semantics, never the two boxes' empty drafts - which once printed
	// "Alerts are off." beside a live 50/80/95 list - and no instruction to
	// clear fields the branch does not render.
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
	// maxLength gates typing only: a longer symbol hand-written in
	// settings.json rides the state push into the box unclamped. The row
	// neither truncates it nor lets a commit die host-side as a generic
	// envelope failure: the bound is the row's error, commits refuse, and
	// deleting down to the cap commits normally.
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
			additionalToolSchemaKeywords: ["propertyNames", "patternProperties"],
			additionalToolSchemaKeywordsLossy: false,
			additionalToolSchemaKeywordsScope: "global",
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
	// The push carries only the NORMALIZED list, so a raw
	// ["propertyNames", "constructor"] arrives as just ["propertyNames"]: no
	// comma, no edge whitespace, nothing the shape check can see. The host's
	// lossy flag is what keeps a dashboard edit from silently destroying the
	// hidden entry.
	const settings = makeSettings({
		chat: {
			tokenEstimation: "auto",
			tokenEstimationScope: null,
			additionalToolSchemaKeywords: ["propertyNames"],
			additionalToolSchemaKeywordsLossy: true,
			additionalToolSchemaKeywordsScope: "global",
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
			additionalToolSchemaKeywords: ["a,b"],
			additionalToolSchemaKeywordsLossy: false,
			additionalToolSchemaKeywordsScope: "global",
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
		expect(button.getAttribute("data-variant")).toBe("secondary");
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

	// The GROUP's help string is deliberately NOT in the haystack, unlike the
	// rows' own help (see the help-text test above): a group kept alive by
	// words behind its heading's glyph would stand with rows the needle
	// matches nowhere, and the reader scanning them finds nothing.
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
	// The two predicates used to disagree: scalar rows matched label plus
	// description and ignored the id, tail rows matched title plus id and
	// ignored the description. Typing a word from the theme row's own
	// description answered "No settings match the filter."
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

test("a failed write reports under the row that posted it, covering the description slot", () => {
	// The fail envelope echoes the request id and never the payload, so the
	// page remembers which row posted each write and places the standing
	// notice there - hoisting every scalar failure to the pane top left a
	// reader hunting for which of thirty rows refused. Placement is the
	// covered-description slot the row's parse errors already use, not a
	// block inserted under the row: an inserted block moved every row below
	// it when the refusal landed (the charter's transients-never-move-anything
	// clause). The slot carries the framed HEADLINE only - the technical
	// detail line is arbitrary-length and the covering contract keeps the
	// cell at the description's own height.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "chat.timeout");
	fireInput(input, "5000");
	fireBlur(input);
	const posted = postedMessages.filter((message) => message.method === "setNumberSetting").pop();
	expect(posted).toBeDefined();
	cleanup();

	const failure = { seq: 1, id: posted?.id ?? "", message: "the write was refused\nsetting detail line" };
	const withFailure = mount(
		<SettingsSection settings={makeSettings()} models={[]} writeFailures={{ setNumberSetting: failure }} />
	);
	const hint = rowOf(settingInput(withFailure, "chat.timeout")).querySelector(".setting-hint");
	const notice = hint?.querySelector(".error");
	expect(notice?.textContent).toBe("The last change did not apply: the write was refused");
	// Headline only: the detail line stays off this surface (the host
	// notifier's toast rule), because the covered cell cannot grow for it.
	expect(notice?.textContent).not.toContain("setting detail line");
	// Covered, not inserted: the resting flow keeps the cell's height and the
	// notice's cover overlays it, so the refusal landing moves nothing - and
	// the row's help glyph rides the cover at the notice's own tail.
	expect(hint?.querySelector(".setting-rest")?.classList.contains("invisible")).toBe(true);
	const cover = notice?.closest(".setting-cover");
	expect(cover?.classList.contains("absolute")).toBe(true);
	expect(cover?.classList.contains("inset-0")).toBe(true);
	expect(cover?.querySelector("button.help")).not.toBeNull();
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
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "chat.timeout");
	fireInput(input, "5000");
	fireBlur(input);
	const posted = postedMessages.filter((message) => message.method === "setNumberSetting").pop();
	cleanup();

	const withFailure = mount(
		<SettingsSection
			settings={makeSettings()}
			models={[]}
			writeFailures={{ setNumberSetting: { seq: 1, id: posted?.id ?? "", message: "the write was refused" } }}
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
	// The announce-once registry records what the hook is handed: fed the seq
	// unconditionally, a failure landing behind a live parse error was marked
	// spoken with no visible line having spoken it, and surfaced silent once
	// the error cleared. The seq reaches the hook only while the failure
	// branch renders, so the first render that SHOWS it is the one that
	// speaks it - and exactly once (the registry dedupes the next render).
	const container = mount(
		<AnnounceOnceScope>
			<SettingsSection settings={makeSettings()} models={[]} />
		</AnnounceOnceScope>
	);
	const input = settingInput(container, "chat.timeout");
	fireInput(input, "5000");
	fireBlur(input);
	const posted = postedMessages.filter((message) => message.method === "setNumberSetting").pop();
	const hint = () => rowOf(settingInput(container, "chat.timeout")).querySelector(".setting-hint");

	// A live parse error holds the slot when the refusal lands.
	fireInput(settingInput(container, "chat.timeout"), "not a number");
	fireBlur(settingInput(container, "chat.timeout"));
	render(
		<AnnounceOnceScope>
			<SettingsSection
				settings={makeSettings()}
				models={[]}
				writeFailures={{ setNumberSetting: { seq: 1, id: posted?.id ?? "", message: "the write was refused" } }}
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

test("a failure no mounted row claims falls back to one section-top line", () => {
	// An id the registry does not hold (the panel reopened since the write, or
	// a newer write is already in flight) still has to surface somewhere.
	const root = mount(
		<SettingsSection
			settings={makeSettings()}
			models={[]}
			writeFailures={{ setUsageStatusBar: { seq: 2, id: "id-no-row-posted", message: "the write was refused" } }}
		/>
	);
	expect(root.querySelector(".setting-hint .error")).toBeNull();
	expect(root.querySelector("p.error[role='alert']")?.textContent).toContain(
		"The last change did not apply: the write was refused"
	);
});

test("two methods' failures on one row keep the latest, not the method-list order", () => {
	// A row can post two kinds of write (its value and its Reset); when both
	// stand failed, the newer failure is the one the reader acted on last.
	// Without the seq comparison, resetSetting's later position in the method
	// list let an OLDER failed reset overwrite a newer failed write.
	const configured = makeSettings();
	const settings = {
		...configured,
		configuredScopes: {
			...configured.configuredScopes,
			numbers: { ...configured.configuredScopes.numbers, "usage.pollInterval": "global" as const },
		},
	};
	const root = mount(<SettingsSection settings={settings} models={[]} />);
	const input = settingInput(root, "usage.pollInterval");
	fireInput(input, "45000");
	fireBlur(input);
	const write = postedMessages.filter((message) => message.method === "setNumberSetting").pop();
	const reset = root.querySelector("button[aria-label='Remove the User value of Usage poll interval']");
	if (!(reset instanceof HTMLButtonElement)) {
		throw new Error("no reset button on the configured row");
	}
	fireClick(reset);
	const resetPost = postedMessages.filter((message) => message.method === "resetSetting").pop();
	expect(write).toBeDefined();
	expect(resetPost).toBeDefined();
	cleanup();

	const withBoth = mount(
		<SettingsSection
			settings={settings}
			models={[]}
			writeFailures={{
				resetSetting: { seq: 3, id: resetPost?.id ?? "", message: "the older reset failure" },
				setNumberSetting: { seq: 9, id: write?.id ?? "", message: "the newer write failure" },
			}}
		/>
	);
	const row = rowOf(settingInput(withBoth, "usage.pollInterval"));
	const notice = row.querySelector(".setting-hint .error");
	expect(notice?.textContent).toContain("the newer write failure");
	expect(notice?.textContent).not.toContain("the older reset failure");
});

test("a newer write on the same method does not un-claim an older standing failure's row", () => {
	// The registry keys by request id, one entry per write: with one slot per
	// method, committing row B would evict row A's remembered write, and A's
	// still-standing failure would teleport from its row to the fallback line
	// mid-read (announcing itself a second time on the way).
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const older = settingInput(root, "chat.timeout");
	fireInput(older, "45000");
	fireBlur(older);
	const olderWrite = postedMessages.filter((message) => message.method === "setNumberSetting").pop();
	const newer = settingInput(root, "discovery.timeout");
	fireInput(newer, "20480");
	fireBlur(newer);
	expect(postedMessages.filter((message) => message.method === "setNumberSetting")).toHaveLength(2);
	cleanup();

	const withFailure = mount(
		<SettingsSection
			settings={makeSettings()}
			models={[]}
			writeFailures={{ setNumberSetting: { seq: 1, id: olderWrite?.id ?? "", message: "the write was refused" } }}
		/>
	);
	const row = rowOf(settingInput(withFailure, "chat.timeout"));
	expect(row.querySelector(".setting-hint .error")?.textContent).toContain(
		"The last change did not apply: the write was refused"
	);
	expect(withFailure.querySelector("p.error[role='alert']")).toBeNull();
});

test("a failure whose owning row the filter hides routes to the section-top line instead of a hidden notice", () => {
	// The filter hides rows without unmounting them, so a claimed notice under
	// a hidden row would be placed and invisible at once - the worst of both.
	const root = mount(<SettingsSection settings={makeSettings()} models={[]} />);
	const input = settingInput(root, "chat.timeout");
	fireInput(input, "45000");
	fireBlur(input);
	const posted = postedMessages.filter((message) => message.method === "setNumberSetting").pop();
	cleanup();

	const withFailure = mount(
		<SettingsSection
			settings={makeSettings()}
			models={[]}
			writeFailures={{ setNumberSetting: { seq: 1, id: posted?.id ?? "", message: "the write was refused" } }}
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
