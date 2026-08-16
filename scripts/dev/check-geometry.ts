/**
 * Sweeps registered STATE PAIRS for geometry drift: renders a fixture through
 * the render harness, measures a target element, induces a state the same way
 * the harness's own fixtures do (clicks, focus, React-safe input writes, a
 * re-dispatched state push), measures again, and fails when the geometry
 * moved. check-overflow.ts proves "the page fits"; this proves the sibling
 * claim no screenshot can: "a state change does not move what it marks".
 * Three consistency defects shipped because nothing compared an element
 * against ITSELF across its states - a modified settings row taller than an
 * unmodified one, a table stranding half the pane at 2000px, a meta line
 * riding in-row on one surface and below it on another.
 *
 * THE REGISTRIES ARE THE COVERAGE CLAIM. A new stateful element - anything
 * that gains a mark, a reveal, an error, or an overlay without meaning to
 * move - gets a STATE_PAIRS entry; a new destination or structural container
 * gets a WIDTH_SURFACES entry. An element missing from here is an element
 * this sweep says nothing about.
 *
 * What is deliberately NOT a pair: disclosure. A model or server row's
 * closed-vs-open states EXIST to move geometry - the detail body takes rows
 * of its own - so holding them still would gate the design's intent, not a
 * defect. Pairs are for states whose whole contract is "same box, different
 * paint": marks, reveals, validity, overlays.
 *
 * Mechanics: each entry becomes a generated fixture module extending the real
 * one with rest-verify, measure, toggle, induced-verify and compare steps,
 * run by render-dashboard.ts in measurement-only mode (--widths "" asks for
 * no capture; the harness still runs the steps and its own-width overflow
 * assertion). A probe failure throws an error whose message STARTS with a
 * GEOMETRY- marker, which the harness surfaces on exit 1; this runner
 * classifies by those markers, exactly how check-overflow.ts reads "scrolls
 * sideways". The probes assemble each marker at runtime ("GEOMETRY-" +
 * "DRIFT") on purpose: the harness echoes the whole failing expression under
 * the error, so a marker spelled whole in the probe SOURCE would appear in
 * the output of every failure the probe can have, and a vanished selector
 * would read as the drift it never measured.
 *
 * Exit 1 means geometry moved (the case, the dimension, and both numbers are
 * named) or a fixture guard is missing, and is also what a failure of the
 * runner itself exits with (an unwritable tmp directory, a bad flag), like
 * its sibling. Exit 2 means a case never ran - a vanished selector, a toggle
 * that no longer induces its state, a baseline already in the toggled
 * state - or an expectedDrift marker whose drift is gone; a stale entry is
 * its own failure, never a passing sweep.
 *
 * The FIXTURE GUARDS leg is the third registry, a static one: a fixture
 * whose steps drive a flow can catch the wrong page and still exit 0 with a
 * plausible PNG - that has happened, at scale - so every flow-driving
 * fixture must carry a throwing assertion on its own subject, fail-closed
 * for new and modified fixtures, with today's unguarded ones grandfathered
 * in a shrink-only allowlist pinned to their steps' content. The leg
 * inspects each fixture's EXPORTED steps, not its text: steps arrive by
 * spread and import too, and a word in a comment proves nothing.
 *
 * Usage:
 *   bun scripts/dev/check-geometry.ts [--only <substring>] [--jobs 4]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_DIR = path.join(REPO_ROOT, "scripts/dev/renderFixtures");
const HARNESS = path.join(REPO_ROOT, "scripts/dev/render-dashboard.ts");

/**
 * Sub-pixel slack for antialiased layout: Chrome reports fractional rects,
 * and two paints of the same box can differ by a rounding step without any
 * rule having moved. Anything past half a pixel is a rule.
 */
const TOLERANCE_PX = 0.5;

/** The width-extreme viewport: past the pane's 1560px cap plus the rail, so every surface is at its widest. */
const WIDE_VIEWPORT_PX = 2000;

/**
 * A marker as probe SOURCE: two halves joined at runtime, so the assembled
 * word exists only in a thrown message and never in the expression the
 * harness echoes under it (see the header). The runner greps the whole word.
 */
function marker(kind: "SETUP" | "DRIFT" | "XDRIFT" | "STALE" | "WIDTH", rest: string): string {
	return `"GEOMETRY-" + ${JSON.stringify(`${kind}${rest}`)}`;
}

type Dim = "x" | "y" | "width" | "height";

interface ExpectedDrift {
	/** Why the drift stands on today's main, for the reader of this registry. */
	readonly reason: string;
	/**
	 * The drifts the marker covers, each as the "<target> <dim>" prefix of a
	 * drift line. Any drift OUTSIDE this list still fails the pair: a marker
	 * that accepted every drift would hide a new defect behind a known one.
	 */
	readonly where: readonly string[];
}

interface StatePair {
	readonly name: string;
	/** The render fixture (a renderFixtures/ file name) whose page hosts the element. */
	readonly fixture: string;
	/** Selectors measured before and after the toggle; each must hold every non-intended dimension. */
	readonly targets: readonly string[];
	/** A selector whose nextElementSibling's top edge is also held: "the row below must not move". */
	readonly siblingOf?: string;
	/** Steps run before the baseline measurement (open the popover the pair lives in). */
	readonly setup?: readonly string[];
	/** Steps that induce the second state. */
	readonly toggle: readonly string[];
	/**
	 * A page expression that must be truthy at the BASELINE, proving the rest
	 * state is really at rest: a fixture that one day starts in the toggled
	 * state would otherwise compare the state against itself and certify a
	 * claim the pair never tested.
	 */
	readonly restVerify: string;
	/** The mirror guard after the toggle: truthy proves the state was actually induced. */
	readonly verify: string;
	/**
	 * Dimensions a NAMED target is allowed to change, keyed by its selector,
	 * with the reason in the entry's comment. Per target on purpose: an
	 * exemption one element earns must not silently cover its neighbours.
	 */
	readonly intended?: Readonly<Record<string, readonly Dim[]>>;
	/**
	 * The pair drifts on today's main and the defect is known: the sweep stays
	 * green by asserting the NAMED drifts are still there and nothing else
	 * moved. Remove the marker in the same change that fixes the defect - a
	 * marker whose drift is gone fails as stale.
	 */
	readonly expectedDrift?: ExpectedDrift;
}

/** The theme appearance row, the settings row every pair on that page anchors to. */
const THEME_ROW = '.setting-row:has([id="setting-ui.theme"])';
/** The usage-thresholds row, whose error contract is "the overlay never changes the row's height". */
const THRESHOLDS_ROW = '.setting-row:has([id="setting-usage.alertThresholds-warning"])';
/**
 * That row's PARSE-error overlay, named by the id its inputs' aria-describedby
 * points at rather than by `.setting-hint .error`: a refused write now renders
 * its own overlay in the same covered slot with the same class, and a pair
 * whose guards cannot tell the two apart has stopped naming the state it
 * induces.
 */
const THRESHOLDS_PARSE_ERROR = `${THRESHOLDS_ROW} .setting-hint span.error[id="setting-usage.alertThresholds-problem"]`;
/**
 * The same row's write-REFUSAL overlay: the covered slot's other tenant,
 * identified by NOT carrying the parse error's id (only the parse error is
 * pointed at by the inputs' aria-describedby; err-scalar.ts pins the same
 * disambiguation). Both tenants live inside a .setting-cover wrapper, which
 * carries the positioning while the .error span holds only the message text -
 * the row's help glyph rides the cover as the error span's sibling, so the
 * description the id names never includes the glyph's own accessible name.
 */
const THRESHOLDS_REFUSAL = `${THRESHOLDS_ROW} .setting-hint .setting-cover > span.error:not([id])`;
/** The covered slot's help glyph while an overlay stands: the "?" re-homed to the visible sentence's tail. */
const THRESHOLDS_COVER_GLYPH = `${THRESHOLDS_ROW} .setting-hint .setting-cover button.help`;
/** The first server row's home; its next sibling is the second row. */
const FIRST_SERVER_ITEM = ".server-list > li.server-item:first-child";
/** The chip whose popover is open - the one chip a state toggle can address across both measurements. */
const OPEN_CHIP = ".chip-anchor:has(.chip-popover) > button.chip-field";
/** The server edit form's first custom-header row (the only .row users on that page are the header rows). */
const FIRST_HEADER_ROW = "#server-edit-page .row";
/** The settings page's Model parameters frame, anchored by its own add button's id. */
const PARAMS_FRAME = ".record-frame:has(#params-add-matcher)";
/** The same frame in JSON mode, where the add button (the resting anchor) is replaced by the side door. */
const JSON_PARAMS_FRAME = '.record-frame:has(textarea[aria-label="Model parameters as JSON"])';
/** The record row whose chips the popover fixtures open; its next sibling holds the row below. */
const GPT5_RECORD_ROW = `.record-row:has(button[aria-label='Open the full editor for "gpt-5*"'])`;
/** The LAST record row, the one nearest the footer its card's verdict covers. */
const LAST_RECORD_ROW = `.record-row:has(button[aria-label='Open the full editor for "claude-sonnet-4"'])`;

/** Writes a value into a React-controlled input through the native setter, then fires the events React listens to. */
function reactType(selector: string, value: string): string {
	return `(() => {
		const input = document.querySelector(${JSON.stringify(selector)});
		if (input === null) { throw new Error(${marker("SETUP", ": no element matches ")} + ${JSON.stringify(selector)}); }
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
		input.focus({ preventScroll: true });
		setter.call(input, ${JSON.stringify(value)});
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.blur();
	})()`;
}

/**
 * The state pairs. Every entry is one element and one state change, with the
 * intended presentation delta named in its comment and everything else held.
 */
const STATE_PAIRS: readonly StatePair[] = [
	{
		// Marking a settings row modified may change the gutter border's COLOR
		// (it is always there, transparent when clean) and reveal the Reset
		// action (opacity only) - the row's box and the row below must not move.
		// The toggle re-dispatches the fixture's own state push with the two
		// appearance scopes set, the exact message a real configuration change
		// delivers, so the pair cannot drift from the fixture's state shape.
		name: "settings-row-modified",
		fixture: "settings.ts",
		targets: [THEME_ROW],
		siblingOf: THEME_ROW,
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				push.state.settings.appearance.themeScope = "global";
				push.state.settings.appearance.accentScope = "global";
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify: `!document.querySelector(${JSON.stringify(THEME_ROW)}).classList.contains("modified")`,
		verify: `document.querySelector(${JSON.stringify(THEME_ROW)}).classList.contains("modified")`,
	},
	{
		// A modified row's hover/focus reveal (Reset, the settings.json jump,
		// the default note) is opacity through the Reveal primitive - revealing
		// it must not move the row or the row below. Driven through the focus
		// half of the reveal contract, because a fixture step cannot create
		// :hover; both halves reveal by flipping the same opacity utility.
		name: "settings-row-reveal",
		fixture: "settings-appearance-set.ts",
		targets: [THEME_ROW],
		siblingOf: THEME_ROW,
		toggle: [
			`document.querySelector(${JSON.stringify(`${THEME_ROW} .setting-actions button.reveal-json`)})` +
				`.focus({ preventScroll: true })`,
		],
		// The opacity lives on the Reveal WRAPPER (ui/reveal.tsx's data-slot),
		// not the button: computed opacity does not inherit as a value, so the
		// button inside a faded wrapper still reads "1" and a guard on it would
		// be vacuously true in both states.
		restVerify:
			`getComputedStyle(document.querySelector(` +
			`${JSON.stringify(`${THEME_ROW} .setting-actions [data-slot="reveal"]:has(> button.reset)`)}` +
			`)).opacity === "0"`,
		verify:
			`document.querySelector(${JSON.stringify(THEME_ROW)}).contains(document.activeElement) && ` +
			`getComputedStyle(document.querySelector(` +
			`${JSON.stringify(`${THEME_ROW} .setting-actions [data-slot="reveal"]:has(> button.reset)`)}` +
			`)).opacity === "1"`,
	},
	{
		// A settings row's parse error COVERS the description (the description
		// stays, invisible, so the cell keeps its height) - the row must not
		// grow while you type something wrong. The verify also holds the covered
		// slot's help glyph: the "?" re-homes to the error's own tail while one
		// stands (dark collided the two, forced colors buried the glyph under
		// the error text's backplate), so a cover without a painted glyph is the
		// regression this pair now names.
		name: "settings-row-error-overlay",
		fixture: "settings.ts",
		targets: [THRESHOLDS_ROW],
		siblingOf: THRESHOLDS_ROW,
		toggle: [reactType('[id="setting-usage.alertThresholds-warning"]', "abc")],
		restVerify: `document.querySelector(${JSON.stringify(THRESHOLDS_PARSE_ERROR)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(THRESHOLDS_PARSE_ERROR)}) !== null && ` +
			`(document.querySelector(${JSON.stringify(THRESHOLDS_COVER_GLYPH)})?.getBoundingClientRect().width ?? 0) > 0`,
	},
	{
		// The server row's actions cluster occupies a reserved track and reveals
		// by opacity - revealing it must not move the row, its name or URL text,
		// or the row below. Driven through :focus-within (the reveal's keyboard
		// half); the pointer half flips the same opacity rule.
		name: "server-row-actions-reveal",
		fixture: "servers-spend.ts",
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-name`,
			`${FIRST_SERVER_ITEM} .server-url`,
			`${FIRST_SERVER_ITEM} .server-actions`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions button`)})` +
				`.focus({ preventScroll: true })`,
		],
		restVerify:
			`getComputedStyle(document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions`)}))` +
			`.opacity === "0"`,
		verify:
			`getComputedStyle(document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions`)}))` +
			`.opacity === "1"`,
	},
	{
		// The Servers header's Refresh now button during an explicit in-flight
		// pass: the busy label swaps in over a reserved width twin (both labels
		// stay mounted in one grid cell), so flipping to "Refreshing..." must
		// not resize the button, move Add server beside it, or move the header
		// line. The toggle re-dispatches the fixture's own state push with the
		// two usage flags set, the exact message a real explicit refresh
		// delivers.
		name: "servers-refresh-busy",
		fixture: "servers-spend.ts",
		targets: [
			"#servers-section > .section-head .section-actions",
			"#servers-section > .section-head .section-actions > button:first-child",
			"button.refresh-usage",
		],
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				push.state.usage.refreshing = true;
				push.state.usage.refreshingExplicitly = true;
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify: `document.querySelector("button.refresh-usage").disabled === false`,
		verify:
			`document.querySelector("button.refresh-usage").disabled === true && ` +
			`getComputedStyle(document.querySelector("button.refresh-usage .spinner")).visibility === "visible"`,
	},
	{
		// A record chip's invalid mark is a border-color change on a border that
		// is always there, and the popover holding the message is out of flow -
		// going invalid must not change the chip's or its chip line's height or
		// vertical position. Width and x are INTENDED here, not exempted for
		// convenience: the chip echoes the draft's value text and an invalid
		// draft is different text, so the inline chip resizes to its content by
		// design - the claim this pair holds is the vertical one, "the mark
		// never adds a line or moves the row".
		name: "record-chip-invalid",
		fixture: "settings.ts",
		targets: [OPEN_CHIP, ".chip-list:has(.chip-popover)"],
		setup: [
			`(() => {
				const chips = [...document.querySelectorAll("button.chip-field")]
					.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
				if (chips.length < 2) { throw new Error(${marker("SETUP", ": no second temperature chip to open")}); }
				chips[1].click();
			})()`,
		],
		toggle: [reactType(".chip-popover input.value", "not json")],
		restVerify: `document.querySelector(${JSON.stringify(`${OPEN_CHIP}.invalid`)}) === null`,
		verify: `document.querySelector(${JSON.stringify(`${OPEN_CHIP}.invalid`)}) !== null`,
		intended: { [OPEN_CHIP]: ["width", "x"] },
	},
	{
		// The server form's field problem is an overlay COVERING the row's
		// reserved hint slot (the settings rows' covered-description mechanism),
		// and the connection-consequence note under Test connection holds its box
		// as an invisible twin until a connection edit makes it speak - a field
		// going invalid must not move the input or grow the form.
		name: "form-url-error",
		fixture: "form-apikey.ts",
		targets: ["#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-baseUrl", "not a url")],
		restVerify: `document.querySelector('[id="server-baseUrl-error"] .error') === null`,
		verify: `document.querySelector('[id="server-baseUrl-error"] .error') !== null`,
	},
	{
		// A custom-header row's parse verdict lands per keystroke in the row's
		// reserved status line (the .row .row-status reservation) - the row, the
		// row below, and the form must not move when a name goes invalid.
		name: "form-header-row-error",
		fixture: "form-apikey.ts",
		targets: [FIRST_HEADER_ROW, "#server-edit-page"],
		siblingOf: FIRST_HEADER_ROW,
		toggle: [reactType(`${FIRST_HEADER_ROW} input[aria-label="Header name"]`, "bad header")],
		restVerify: `document.querySelector("#server-edit-page .row .row-status.error") === null`,
		verify: `document.querySelector("#server-edit-page .row .row-status.error") !== null`,
	},
	{
		// The matcher editor overlay's per-row verdict lands per keystroke in the
		// row's reserved status line - the row, the rows grid, and the Add action
		// under it (the grid's next sibling) must not move when a value goes
		// invalid. The parameters editor is toggled here; the capability twin
		// below drives the same shared machinery from the caps side.
		name: "record-overlay-row-error",
		fixture: "record-overlay.ts",
		targets: [".matcher-editor .rows > .row", ".matcher-editor .rows"],
		siblingOf: ".matcher-editor .rows",
		toggle: [reactType(".matcher-editor .rows input.value", "not json")],
		restVerify: `document.querySelector(".matcher-editor .row-status.error") === null`,
		verify: `document.querySelector(".matcher-editor .row-status.error") !== null`,
	},
	{
		// The capability editor's twin of the pair above, inside the server
		// form's overlay: its rows also carry standing HINTS at rest (the
		// unknown-key advisories), so this pair proves a problem landing beside
		// them holds the grid and the overlay footer still.
		name: "form-caps-overlay-row-error",
		fixture: "form-caps-open.ts",
		targets: [".matcher-editor .rows", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .rows",
		toggle: [
			`(() => {
				const rows = [...document.querySelectorAll(".matcher-editor .rows > .row")];
				const row = rows.find((r) => r.querySelector("input.key")?.value === "supported_openai_params");
				if (row === undefined) { throw new Error(${marker("SETUP", ": no supported_openai_params row in the overlay")}); }
				const input = row.querySelector("input.value");
				if (input === null) { throw new Error(${marker("SETUP", ": the supported_openai_params row offers no value input")}); }
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
				input.focus({ preventScroll: true });
				setter.call(input, "not json");
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.blur();
			})()`,
		],
		restVerify: `document.querySelector(".matcher-editor .row-status.error") === null`,
		verify: `document.querySelector(".matcher-editor .row-status.error") !== null`,
	},
	{
		// A refused record Apply lands in the footer's inline message slot
		// (headline only) - the frame, its action bar, the slot's own box, the
		// Add action, and the commit trio must not move when the refusal
		// arrives. The toggle drives the real flow: Apply posts the dirty
		// draft, and the fail envelope quotes the posted request's id off the
		// harness stub, like err-recordeditor.ts.
		name: "record-apply-failure-note",
		fixture: "settings.ts",
		setup: [
			// A dirty draft first: open the "*" row's temperature chip, change the
			// value, close the popover. The rest state is the dirty-but-unrefused
			// editor, the state the refusal actually lands on.
			`(() => {
				const chips = [...document.querySelectorAll("button.chip-field")]
					.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
				if (chips.length === 0) { throw new Error(${marker("SETUP", ": no temperature chip to open")}); }
				chips[0].click();
			})()`,
			reactType(".chip-popover input.value", "0.9"),
			`document.querySelector(${JSON.stringify(OPEN_CHIP)}).click()`,
		],
		targets: [
			PARAMS_FRAME,
			`${PARAMS_FRAME} .toolbar.editor-actions`,
			`${PARAMS_FRAME} .editor-status`,
			`${PARAMS_FRAME} .editor-commit`,
			"#params-add-matcher",
		],
		toggle: [
			`(() => {
				const frame = document.querySelector(${JSON.stringify(PARAMS_FRAME)});
				[...frame.querySelectorAll("button")].find((b) => b.textContent.trim() === "Apply").click();
				const posted = window.__posted.filter((m) => m.method === "setModelParameters").pop();
				if (posted === undefined) { throw new Error(${marker("SETUP", ": Apply posted no setModelParameters request")}); }
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							kind: "fail",
							id: posted.id,
							method: "setModelParameters",
							message: "The write to models.parameters was refused by the configuration target.",
							failureKind: "validation",
						},
					})
				);
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .failure-note.error`)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .failure-note.error`)})` +
			`?.textContent.includes("refused by the configuration target") === true`,
	},
	{
		// A refused settings write covers the posting row's description slot (the
		// parse errors' covered-description mechanism; err-scalar.ts drives the
		// same flow for its shot) - the row and the row below must not move when
		// the refusal lands. Sibling pair of settings-row-error-overlay, which
		// toggles the slot's OTHER tenant.
		name: "settings-write-failure-overlay",
		fixture: "settings.ts",
		targets: [THRESHOLDS_ROW],
		siblingOf: THRESHOLDS_ROW,
		toggle: [
			`(() => {
				const box = document.getElementById("setting-usage.alertThresholds-warning");
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
				box.focus({ preventScroll: true });
				setter.call(box, "70%");
				box.dispatchEvent(new Event("input", { bubbles: true }));
				box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
				const posted = window.__posted.filter((m) => m.method === "setUsageAlertThresholds").pop();
				if (posted === undefined) { throw new Error(${marker("SETUP", ": Enter posted no setUsageAlertThresholds request")}); }
				// The reader tabs to the row's help before the refusal lands: the
				// swap must hand focus to the cover's glyph (the verify holds it),
				// because the resting one goes visibility-hidden and a hidden
				// control cannot keep the keyboard.
				const glyph = document.querySelector(${JSON.stringify(`${THRESHOLDS_ROW} .setting-rest button.help`)});
				if (glyph === null) { throw new Error(${marker("SETUP", ": no resting help glyph on the thresholds row")}); }
				glyph.focus({ preventScroll: true });
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							kind: "fail",
							id: posted.id,
							method: "setUsageAlertThresholds",
							message: "Alert thresholds must be above 0% and at most 100% - enter values like 80% or 0.8.",
							failureKind: "validation",
						},
					})
				);
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(THRESHOLDS_REFUSAL)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(THRESHOLDS_REFUSAL)}) !== null && ` +
			`(document.querySelector(${JSON.stringify(THRESHOLDS_COVER_GLYPH)})?.getBoundingClientRect().width ?? 0) > 0 && ` +
			`document.activeElement === document.querySelector(${JSON.stringify(THRESHOLDS_COVER_GLYPH)})`,
	},
	{
		// The server form's rename note holds its box as an invisible spacing
		// twin under the Label row (the connection note's idiom) - the first
		// renaming keystroke used to INSERT it and push every row below down
		// under the typing hand. err-serverform.ts opens the edit form with a
		// field error already standing, so this also proves the note speaks
		// without disturbing the covered-slot error above it.
		name: "form-rename-note",
		fixture: "err-serverform.ts",
		targets: ["#server-label", "#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-label", "prod-eu")],
		restVerify:
			`getComputedStyle(document.querySelector("#server-edit-page .rename-note"))` + `.visibility === "hidden"`,
		verify: `getComputedStyle(document.querySelector("#server-edit-page .rename-note"))` + `.visibility === "visible"`,
	},
	{
		// The add form's twin of the rename note: typing a label that matches a
		// declared entry speaks the collides note in the same reserved line
		// under the Label row - as an inserting hint, the first colliding
		// keystroke pushed the whole form down. form-apiversion-auto opens the
		// ADD form (the only state that renders .collides-note; the edit form
		// renders .rename-note in the same slot), and "prod" is a declared
		// label in the shared base state, so the toggle is a real collision.
		name: "form-collides-note",
		fixture: "form-apiversion-auto.ts",
		targets: ["#server-label", "#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-label", "prod")],
		restVerify:
			`getComputedStyle(document.querySelector("#server-edit-page .collides-note"))` + `.visibility === "hidden"`,
		verify:
			`getComputedStyle(document.querySelector("#server-edit-page .collides-note"))` + `.visibility === "visible"`,
	},
	{
		// The matcher editor's own status line under the matcher input: the
		// grammar reading at rest, the parse verdict while one stands - one
		// reserved line (dashboard.css .matcher-status), so a verdict landing
		// must not move the Inherits control, the field rows, or the footer.
		// Before the merge these were two spans, and a typed matcher that
		// collided grew a second line under the kind reading - this toggle
		// (a reserved name, so the kind reading and the verdict apply at once)
		// is exactly the state that used to paint both.
		name: "record-overlay-prefix-error",
		fixture: "record-overlay.ts",
		targets: [".matcher-editor .matcher-line", ".matcher-editor .rows", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .editor-section",
		toggle: [reactType(".matcher-editor .matcher-line input.key", "__proto__")],
		restVerify: `document.querySelector(".matcher-editor .matcher-status.error") === null`,
		verify: `document.querySelector(".matcher-editor .matcher-status.error") !== null`,
	},
	{
		// The same slot's other swap, from the other resting state: an EMPTY
		// matcher's status line speaks the parse's own verdict ("Enter a model
		// matcher"), and the first keystroke swaps it for the grammar reading -
		// as two spans those wore two different font sizes, so the swap moved
		// the sections below by a rounding step on every keystroke into an
		// empty matcher. The setup drives the editor into the empty state the
		// fixture never rests in.
		name: "record-overlay-empty-matcher-status",
		fixture: "record-overlay.ts",
		setup: [reactType(".matcher-editor .matcher-line input.key", "")],
		targets: [".matcher-editor .matcher-line", ".matcher-editor .rows", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .editor-section",
		toggle: [reactType(".matcher-editor .matcher-line input.key", "gpt-4")],
		restVerify: `document.querySelector(".matcher-editor .matcher-status.error") !== null`,
		verify:
			`document.querySelector(".matcher-editor .matcher-status.error") === null && ` +
			`(document.querySelector(".matcher-editor .matcher-status")?.textContent.length ?? 0) > 0`,
	},
	{
		// The Edit-as-JSON side door's parse verdict lands in its reserved line
		// under the textarea (dashboard.css .json-status) - the frame, the
		// textarea, and the action bar must not move on the first bad character.
		name: "record-json-status",
		fixture: "settings.ts",
		setup: [
			`(() => {
				const frame = document.querySelector(${JSON.stringify(PARAMS_FRAME)});
				if (frame === null) { throw new Error(${marker("SETUP", ": no element matches ")} + ${JSON.stringify(PARAMS_FRAME)}); }
				const door = [...frame.querySelectorAll("button")].find((b) => b.textContent.trim() === "Edit as JSON");
				if (door === undefined) { throw new Error(${marker("SETUP", ": no Edit as JSON button in the params frame")}); }
				door.click();
			})()`,
		],
		// JSON_PARAMS_FRAME, not PARAMS_FRAME: the side door replaces the Add
		// action the resting anchor rides on, so the frame is re-anchored by
		// the door's own textarea for every measurement after setup.
		targets: [
			JSON_PARAMS_FRAME,
			`${JSON_PARAMS_FRAME} .record-json textarea`,
			`${JSON_PARAMS_FRAME} .toolbar.editor-actions`,
		],
		toggle: [
			`(() => {
				const box = document.querySelector(${JSON.stringify(`${JSON_PARAMS_FRAME} .record-json textarea`)});
				if (box === null) { throw new Error(${marker("SETUP", ": no JSON side-door textarea")}); }
				const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
				box.focus({ preventScroll: true });
				setter.call(box, "not json");
				box.dispatchEvent(new Event("input", { bubbles: true }));
				box.blur();
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${JSON_PARAMS_FRAME} .json-status.error`)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(`${JSON_PARAMS_FRAME} .json-status.error`)})` +
			`?.textContent.length > 0`,
	},
	{
		// The card's verdict mounts in the footer's inline message slot when a
		// popover closes over an invalid draft: the row, the row below, the
		// table, the frame, the footer, the slot's own box, and both button
		// groups must all hold still.
		name: "record-row-status",
		fixture: "record-popover.ts",
		targets: [
			GPT5_RECORD_ROW,
			".record-table",
			PARAMS_FRAME,
			`${PARAMS_FRAME} .toolbar.editor-actions`,
			`${PARAMS_FRAME} .editor-status`,
			`${PARAMS_FRAME} .editor-commit`,
			"#params-add-matcher",
		],
		siblingOf: GPT5_RECORD_ROW,
		toggle: [
			reactType(".chip-popover input.value", "not json"),
			`document.querySelector(${JSON.stringify(OPEN_CHIP)}).click()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .record-verdict`)}) === null`,
		verify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .record-verdict`)}) !== null`,
	},
	{
		// The same claim driven from the LAST row, whose verdict lands in the
		// footer directly under it: the bar, the message slot, the Add action,
		// and the commit trio must not move. The chip's own width/x change is
		// the record-chip-invalid pair's intended delta, not measured here.
		name: "record-last-row-status",
		fixture: "settings.ts",
		setup: [
			`(() => {
				const chips = [...document.querySelectorAll("button.chip-field")]
					.filter((chip) => chip.querySelector(".chip-key")?.textContent === "temperature");
				if (chips.length < 3) { throw new Error(${marker("SETUP", ": no last-row temperature chip to open")}); }
				chips[2].click();
			})()`,
		],
		targets: [
			LAST_RECORD_ROW,
			PARAMS_FRAME,
			`${PARAMS_FRAME} .toolbar.editor-actions`,
			`${PARAMS_FRAME} .editor-status`,
			`${PARAMS_FRAME} .editor-commit`,
			"#params-add-matcher",
		],
		toggle: [
			reactType(".chip-popover input.value", "not json"),
			`document.querySelector(${JSON.stringify(OPEN_CHIP)}).click()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .record-verdict`)}) === null`,
		verify: `document.querySelector(${JSON.stringify(`${PARAMS_FRAME} .record-verdict`)}) !== null`,
	},
	{
		// The chip popover's verdict lands in its reserved status slot AFTER the
		// actions - Remove field must not move down under the pointer when the
		// value goes invalid. Width is INTENDED on both: the popover hugs its
		// content (width: max-content) and the value input echoes the draft's
		// text, so a longer draft widens the box by design - the claim this pair
		// holds is the vertical one.
		name: "chip-popover-status",
		fixture: "record-popover.ts",
		targets: [".chip-popover", ".chip-popover .chip-popover-actions"],
		toggle: [reactType(".chip-popover input.value", "not json")],
		restVerify: `document.querySelector(".chip-popover-status .error") === null`,
		verify: `document.querySelector(".chip-popover-status .error") !== null`,
		intended: {
			".chip-popover": ["width"],
			".chip-popover .chip-popover-actions": ["width"],
		},
	},
];

interface WidthSurface {
	readonly name: string;
	readonly fixture: string;
	/** The surface's structural container, whose right edge is the claim. */
	readonly selector: string;
	/** How close to the pane's content edge the container must reach, in px. */
	readonly within?: number;
}

/**
 * The width extremes: each surface rendered at 2000px, asserting its
 * structural container's right edge lands on the pane's content edge - the
 * charter's width ruling (structure runs full-bleed to the pane; only prose
 * keeps a reading measure, and reading measures are not structural
 * containers). measure.test.ts pins the ruling in source; this pins that the
 * rendered box actually reaches the edge, which is the failure that stranded
 * half the pane once.
 */
const WIDTH_SURFACES: readonly WidthSurface[] = [
	{ name: "models-list-full-bleed", fixture: "models.ts", selector: ".model-list" },
	{ name: "servers-list-full-bleed", fixture: "servers-spend.ts", selector: "ul.server-list" },
	{ name: "diagnostics-problems-full-bleed", fixture: "diagnostics.ts", selector: ".config-diagnostics" },
	{ name: "diagnostics-resolution-full-bleed", fixture: "diagnostics.ts", selector: ".resolved-scroll" },
];

/**
 * Fixtures that drive a flow through steps WITHOUT a throwing assertion on
 * their own subject, grandfathered as found - each pinned to a digest of its
 * steps, so MODIFYING a grandfathered flow invalidates the exemption along
 * with adding a new one. THIS LIST ONLY SHRINKS: a new or changed
 * flow-driving fixture must throw when its subject is not on the page,
 * because a fixture that runs its steps against the wrong page exits 0 with
 * a plausible PNG - twenty-two renders once photographed the Servers page
 * while claiming to show something else. An entry whose fixture now throws
 * (or lost its steps, or is gone) fails as stale until removed.
 *
 * To update a digest here is to re-grandfather changed steps, which defeats
 * the leg: add the throwing assertion instead and DELETE the entry.
 */
const UNGUARDED_FIXTURE_PINS: readonly (readonly [string, string])[] = [
	["confirm-discard.ts", "8bca510c05ad"],
	["diagnostics-empty.ts", "da182ff33932"],
	["diagnostics-inspector.ts", "8a1701a0f708"],
	["diagnostics.ts", "da182ff33932"],
	["form-apikey.ts", "d1121e72b575"],
	["form-apiversion-auto.ts", "f9159772b925"],
	["form-apiversion-custom.ts", "d1121e72b575"],
	["form-apiversion-none.ts", "d1121e72b575"],
	["form-caps-open.ts", "8273f2c88f65"],
	["form-oauth.ts", "d1121e72b575"],
	["form-records-overlay.ts", "8273f2c88f65"],
	["form-records.ts", "62f3c8e68bd2"],
	["form-vk-storedkey.ts", "9be5ebf832e0"],
	["hc-forced-record-invalid.ts", "e6f86d9eb7ab"],
	["inspector-model-notes.ts", "5ef021c0554c"],
	["inspector-model.ts", "5ef021c0554c"],
	["record-jump.ts", "0db9cae39f56"],
	["record-overlay.ts", "0c38ae0f98c1"],
	["record-popover-flip.ts", "7d7a07d525d6"],
	["record-popover-invalid.ts", "e6f86d9eb7ab"],
	["record-popover.ts", "09c360d3a746"],
	["servers-endpoint-hints.ts", "45844f265eaa"],
	["settings-filter.ts", "72273e6f6374"],
	["statusbar.ts", "b519826d19a2"],
	["suggest-capability.ts", "f2e38615ae1a"],
	["suggest-matcher.ts", "3ec18f42049b"],
	["thresholds-both.ts", "43c20b956022"],
	["thresholds-custom.ts", "a55530d1cc7f"],
	["thresholds-error-only.ts", "47864ae45868"],
];

const UNGUARDED_FIXTURES: ReadonlyMap<string, string> = new Map(UNGUARDED_FIXTURE_PINS);

/** The steps digest an exemption pins: content-addressed, so any edit to the flow re-opens the question. */
function stepsDigest(steps: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(steps)).digest("hex").slice(0, 12);
}

/**
 * The static guard sweep, over each fixture's EXPORTED shape rather than its
 * text: steps arrive by spread and import as well as by literal (one
 * high-contrast fixture reuses another's whole flow), and a "throw" in a
 * comment proves nothing - the assertion has to live in the steps that run.
 */
/**
 * Whether a step contains a real throw STATEMENT, by parsing it: a substring
 * test is satisfied by the word in a comment or a string literal inside the
 * step, and a guard leg that can be met by prose is met by prose eventually.
 */
function stepThrows(step: string): boolean {
	let found = false;
	const walk = (node: ts.Node): void => {
		if (ts.isThrowStatement(node)) {
			found = true;
			return;
		}
		if (!found) {
			ts.forEachChild(node, walk);
		}
	};
	walk(ts.createSourceFile("step.ts", step, ts.ScriptTarget.Latest, true));
	return found;
}

async function fixtureGuardFindings(): Promise<string[]> {
	const findings: string[] = [];
	const names = readdirSync(FIXTURE_DIR)
		.filter((name) => name.endsWith(".ts") && name !== "shared.ts")
		.sort();
	for (const name of names) {
		const module = (await import(pathToFileURL(path.join(FIXTURE_DIR, name)).href)) as {
			default?: { steps?: readonly string[] };
		};
		const steps = Array.isArray(module.default?.steps) ? module.default.steps : [];
		const drivesFlow = steps.length > 0;
		const throws = steps.some(stepThrows);
		const pinned = UNGUARDED_FIXTURES.get(name);
		if (drivesFlow && !throws) {
			if (pinned === undefined) {
				findings.push(`${name} drives a flow through steps with no throwing assertion on its own subject`);
			} else if (pinned !== stepsDigest(steps)) {
				findings.push(
					`${name}'s steps changed since they were grandfathered; add a throwing assertion on its subject ` +
						"and remove its UNGUARDED_FIXTURE_PINS entry"
				);
			}
		}
		if (pinned !== undefined && (!drivesFlow || throws)) {
			findings.push(`${name} no longer needs its UNGUARDED_FIXTURE_PINS entry; the list only shrinks - remove it`);
		}
	}
	for (const name of UNGUARDED_FIXTURES.keys()) {
		if (!existsSync(path.join(FIXTURE_DIR, name))) {
			findings.push(`${name} is in UNGUARDED_FIXTURE_PINS but no longer exists; remove the entry`);
		}
	}
	return findings;
}

/** Two frames after a scroll re-pin, so every measurement reads a settled, identically-scrolled page. */
const SETTLE_JS = `window.scrollTo(0, 0);
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));`;

/** The in-page rect reader both probes share; throws the SETUP marker so a vanished selector reads as "never ran". */
function grabJs(): string {
	return `const grab = (selector) => {
			const node = document.querySelector(selector);
			if (node === null) { throw new Error(${marker("SETUP", ": no element matches ")} + selector); }
			const rect = node.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				throw new Error(${marker("SETUP", ": nothing is painted for ")} + selector);
			}
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		};`;
}

function measureStep(pair: StatePair): string {
	return `(async () => {
		${SETTLE_JS}
		if (!(${pair.restVerify})) {
			throw new Error(${marker("SETUP", `: the baseline is already in the toggled state (${pair.restVerify})`)});
		}
		${grabJs()}
		const baseline = { rects: ${JSON.stringify(pair.targets)}.map(grab), siblingTop: null };
		const siblingOf = ${JSON.stringify(pair.siblingOf ?? null)};
		if (siblingOf !== null) {
			const anchor = document.querySelector(siblingOf);
			if (anchor === null || anchor.nextElementSibling === null) {
				throw new Error(${marker("SETUP", ": no next sibling to hold under ")} + siblingOf);
			}
			baseline.siblingTop = anchor.nextElementSibling.getBoundingClientRect().top;
		}
		window.__geometryBaseline = baseline;
	})()`;
}

function compareStep(pair: StatePair): string {
	const siblingCheck =
		pair.siblingOf === undefined
			? ""
			: `const anchor = document.querySelector(${JSON.stringify(pair.siblingOf)});
		if (anchor === null || anchor.nextElementSibling === null) {
			throw new Error(${marker("SETUP", ": no next sibling to hold under ")} + ${JSON.stringify(pair.siblingOf)});
		}
		hold("next sibling of " + ${JSON.stringify(pair.siblingOf)}, "y", [],
			window.__geometryBaseline.siblingTop, anchor.nextElementSibling.getBoundingClientRect().top);`;
	// With an expectedDrift marker the probe itself decides between "the named
	// drifts still stand" (XDRIFT, the green outcome), "a drift outside the
	// list" (DRIFT, a real failure a known defect must not hide), and "no
	// drift at all" (STALE, the marker outlived its defect).
	const verdict =
		pair.expectedDrift === undefined
			? `if (drifts.length > 0) {
			throw new Error(${marker("DRIFT", ` ${pair.name}:`)} + "\\n  " + drifts.join("\\n  "));
		}`
			: `const where = ${JSON.stringify(pair.expectedDrift.where)};
		const unexpected = drifts.filter((line) => !where.some((prefix) => line.startsWith(prefix)));
		if (unexpected.length > 0) {
			throw new Error(${marker("DRIFT", ` ${pair.name} (outside its expectedDrift list):`)} + "\\n  " + unexpected.join("\\n  "));
		}
		// Dead prefixes fail too: a partially fixed defect must shrink the
		// where-list with the fix, or the list quietly stops describing main.
		const dead = where.filter((prefix) => !drifts.some((line) => line.startsWith(prefix)));
		if (dead.length > 0) {
			throw new Error(
				${marker("STALE", ` ${pair.name}: expected drift no longer occurs at `)} + dead.join(", ") +
				"; shrink or remove the expectedDrift marker"
			);
		}
		throw new Error(${marker("XDRIFT", ` ${pair.name} (expected on today's main):`)} + "\\n  " + drifts.join("\\n  "));`;
	return `(async () => {
		${SETTLE_JS}
		if (!(${pair.verify})) {
			throw new Error(${marker("SETUP", `: the toggle never induced the state (${pair.verify})`)});
		}
		${grabJs()}
		const baseline = window.__geometryBaseline;
		const intended = ${JSON.stringify(intendedByTarget(pair))};
		const targets = ${JSON.stringify(pair.targets)};
		const drifts = [];
		const hold = (what, dim, exempt, was, now) => {
			const delta = now - was;
			if (!exempt.includes(dim) && Math.abs(delta) > ${TOLERANCE_PX}) {
				drifts.push(
					what + " " + dim + " " + was.toFixed(2) + "px -> " + now.toFixed(2) +
					"px (moved " + delta.toFixed(2) + "px)"
				);
			}
		};
		targets.forEach((target, index) => {
			const now = grab(target);
			for (const dim of ["x", "y", "width", "height"]) {
				hold(target, dim, intended[index], baseline.rects[index][dim], now[dim]);
			}
		});
		${siblingCheck}
		${verdict}
	})()`;
}

/** The intended-dimension exemptions as an array parallel to targets; a key naming no target is a registry typo. */
function intendedByTarget(pair: StatePair): readonly (readonly Dim[])[] {
	for (const key of Object.keys(pair.intended ?? {})) {
		if (!pair.targets.includes(key)) {
			throw new Error(`${pair.name}: intended names "${key}", which is not one of its targets`);
		}
	}
	return pair.targets.map((target) => pair.intended?.[target] ?? []);
}

function widthStep(surface: WidthSurface): string {
	const within = surface.within ?? 1;
	return `(async () => {
		${SETTLE_JS}
		// The steps run before the harness's own asserted setWidth, on whatever
		// viewport --window-size produced - and a platform minimum can silently
		// hand back something narrower. At a shrunken width every surface fills
		// whatever pane is left and the extreme goes untested, so it must fail
		// as never-ran, not pass.
		if (document.documentElement.clientWidth < ${WIDE_VIEWPORT_PX}) {
			throw new Error(
				${marker("SETUP", `: the viewport is `)} + document.documentElement.clientWidth +
				"px, not the ${WIDE_VIEWPORT_PX}px this surface must be measured at"
			);
		}
		const pane = document.querySelector(".pane");
		if (pane === null) { throw new Error(${marker("SETUP", ": no .pane on the page")}); }
		const style = getComputedStyle(pane);
		const paneRect = pane.getBoundingClientRect();
		const contentRight = paneRect.right - parseFloat(style.paddingRight) - (parseFloat(style.borderRightWidth) || 0);
		const node = document.querySelector(${JSON.stringify(surface.selector)});
		if (node === null) {
			throw new Error(${marker("SETUP", ": no element matches ")} + ${JSON.stringify(surface.selector)});
		}
		const actualRight = node.getBoundingClientRect().right;
		if (Math.abs(actualRight - contentRight) > ${within}) {
			throw new Error(
				${marker("WIDTH", ` ${surface.name}: `)} + ${JSON.stringify(surface.selector)} + " right edge at " +
				actualRight.toFixed(2) + "px, the pane's content edge at " + contentRight.toFixed(2) + "px (off by " +
				(actualRight - contentRight).toFixed(2) + "px at ${WIDE_VIEWPORT_PX}px)"
			);
		}
	})()`;
}

interface SweepCase {
	readonly name: string;
	readonly fixture: string;
	readonly steps: readonly string[];
	/** A viewport width forced onto the fixture; pairs keep the fixture's own. */
	readonly viewportWidth?: number;
	/** Whether the case carries an expectedDrift marker (its probe then never exits green). */
	readonly expectsDrift: boolean;
}

function pairCase(pair: StatePair): SweepCase {
	return {
		name: pair.name,
		fixture: pair.fixture,
		steps: [...(pair.setup ?? []), measureStep(pair), ...pair.toggle, compareStep(pair)],
		expectsDrift: pair.expectedDrift !== undefined,
	};
}

function widthCase(surface: WidthSurface): SweepCase {
	return {
		name: surface.name,
		fixture: surface.fixture,
		steps: [widthStep(surface)],
		viewportWidth: WIDE_VIEWPORT_PX,
		expectsDrift: false,
	};
}

/**
 * The generated fixture: the real one plus this case's steps, so the harness
 * builds the page, replays the messages, and runs the probes exactly as it
 * runs any fixture's own steps. Generated under tmp and imported by absolute
 * path; the base fixture's own relative imports still resolve at its real
 * location.
 */
async function writeCaseFixture(dir: string, sweep: SweepCase, index: number): Promise<string> {
	const basePath = path.join(FIXTURE_DIR, sweep.fixture);
	await fs.access(basePath);
	const viewport =
		sweep.viewportWidth === undefined
			? ""
			: `\tviewport: { width: ${sweep.viewportWidth}, height: base.viewport?.height ?? 950 },\n`;
	const source =
		`import base from ${JSON.stringify(basePath)};\n` +
		`export default {\n\t...base,\n${viewport}` +
		`\tsteps: [...(base.steps ?? []), ...${JSON.stringify(sweep.steps)}],\n};\n`;
	const file = path.join(dir, `${String(index).padStart(2, "0")}-${sweep.name}.ts`);
	await fs.writeFile(file, source);
	return file;
}

type Outcome = "held" | "drifted" | "expected-drift" | "stale-expectation" | "never-ran";

interface Result {
	readonly name: string;
	readonly outcome: Outcome;
	readonly output: string;
}

/**
 * One case through the harness. --widths "" puts it in measurement-only mode
 * (no PNG, no extra sweep widths) while the steps and the own-width overflow
 * assertion still run; a probe's throw surfaces as exit 1 with its runtime-
 * assembled marker in the output, which is the whole wire protocol between
 * the two scripts (the probe source never spells a marker whole, so the
 * harness's expression echo cannot satisfy these greps).
 */
async function run(sweep: SweepCase, fixtureFile: string): Promise<Result> {
	const child = spawn(process.execPath, [HARNESS, "--fixture", fixtureFile, "--widths", ""], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
	let outcome: Outcome;
	if (code === 0) {
		// A green exit under an expectedDrift marker cannot happen through the
		// probe (it always throws one of its three verdicts); reaching it means
		// the compare step never ran, which is a stale entry, not a pass.
		outcome = sweep.expectsDrift ? "stale-expectation" : "held";
	} else if (output.includes("GEOMETRY-XDRIFT")) {
		outcome = "expected-drift";
	} else if (output.includes("GEOMETRY-STALE")) {
		outcome = "stale-expectation";
	} else if (output.includes("GEOMETRY-DRIFT") || output.includes("GEOMETRY-WIDTH")) {
		outcome = "drifted";
	} else {
		outcome = "never-ran";
	}
	return { name: sweep.name, outcome, output };
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { only: { type: "string" }, jobs: { type: "string" } } });
	const jobs = values.jobs === undefined ? 4 : Number(values.jobs);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`--jobs takes a positive integer; got ${values.jobs}`);
	}
	const cases = [...STATE_PAIRS.map(pairCase), ...WIDTH_SURFACES.map(widthCase)].filter(
		(sweep) => values.only === undefined || sweep.name.includes(values.only)
	);
	if (cases.length === 0) {
		throw new Error(`No pairs matched ${values.only ?? "(everything)"}`);
	}
	// Always swept, --only or not: the guard leg is static and instant, and a
	// filtered run that silently skipped it would be a green nobody earned.
	const unguarded = await fixtureGuardFindings();
	for (const finding of unguarded) {
		console.log(`GUARD ${finding}`);
	}
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "check-geometry-"));
	try {
		const results: Result[] = [];
		// A case whose base fixture is gone is a case that never ran - the
		// renamed-fixture failure belongs to exit 2's vocabulary, not to a
		// runner crash that would take the rest of the sweep with it.
		const queue: { sweep: SweepCase; file: string }[] = [];
		for (const [index, sweep] of cases.entries()) {
			try {
				queue.push({ sweep, file: await writeCaseFixture(tmpDir, sweep, index) });
			} catch (error) {
				results.push({
					name: sweep.name,
					outcome: "never-ran",
					output: error instanceof Error ? error.message : String(error),
				});
			}
		}
		console.log(
			`sweeping ${cases.length} case(s): ${STATE_PAIRS.length} state pair(s), ${WIDTH_SURFACES.length} width surface(s) registered`
		);
		// The same pool and stagger as check-overflow.ts, for the same reason:
		// each run launches its own Chrome, and cold-starting them all at once
		// starves the harness's DevTools deadline on a busy runner.
		await Promise.all(
			Array.from({ length: Math.min(jobs, queue.length) }, async (_, worker) => {
				await delay(worker * 400);
				for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
					const result = await run(next.sweep, next.file);
					results.push(result);
					const tag = {
						held: "ok  ",
						drifted: "FAIL",
						"expected-drift": "xfail",
						"stale-expectation": "STALE",
						"never-ran": "FAIL",
					}[result.outcome];
					console.log(`${tag} ${result.name}`);
				}
			})
		);
		const failed = results
			.filter(
				(result) =>
					result.outcome === "drifted" || result.outcome === "never-ran" || result.outcome === "stale-expectation"
			)
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const result of failed) {
			console.log(`\n--- ${result.name} ---\n${result.output.trim()}`);
		}
		const drifted = results.filter((result) => result.outcome === "drifted");
		const expected = results.filter((result) => result.outcome === "expected-drift");
		const stale = results.filter((result) => result.outcome === "stale-expectation");
		const unrunnable = results.filter((result) => result.outcome === "never-ran");
		const held = results.filter((result) => result.outcome === "held");
		console.log(`\n${held.length}/${results.length} cases held their geometry`);
		if (expected.length > 0) {
			console.log(
				`${expected.length} drifted as expected (known defects): ${expected.map((result) => result.name).join(", ")}`
			);
		}
		if (drifted.length > 0) {
			console.log(`${drifted.length} moved: ${drifted.map((result) => result.name).join(", ")}`);
		}
		if (stale.length > 0) {
			console.log(
				`${stale.length} stale expectedDrift marker(s) - the defect is fixed, remove the marker: ` +
					stale.map((result) => result.name).join(", ")
			);
		}
		if (unrunnable.length > 0) {
			console.log(`${unrunnable.length} never ran: ${unrunnable.map((result) => result.name).join(", ")}`);
		}
		if (unguarded.length > 0) {
			console.log(`${unguarded.length} fixture guard finding(s), listed above the sweep`);
		}
		if (drifted.length > 0 || unguarded.length > 0) {
			process.exitCode = 1;
		} else if (unrunnable.length > 0 || stale.length > 0) {
			process.exitCode = 2;
		}
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
