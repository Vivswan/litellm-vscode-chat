/**
 * Sweeps registered STATE PAIRS for geometry drift: renders a fixture, measures
 * a target, induces a state, measures again, and fails when the geometry moved.
 * check-overflow.ts proves "the page fits"; this proves "a state change does
 * not move what it marks", plus a width leg asserting each registered surface
 * reaches the pane's content edge at 2000px.
 *
 * THE REGISTRIES ARE THE COVERAGE CLAIM. A new stateful element - anything that
 * gains a mark, a reveal, an error, or an overlay without meaning to move -
 * gets a STATE_PAIRS entry; a new destination or structural container gets a
 * WIDTH_SURFACES entry. Disclosure is deliberately not a pair: open-vs-closed
 * EXISTS to move geometry. Pairs are for "same box, different paint".
 *
 * Every case runs in the harness's measurement mode, so it measures the
 * pinned font faces (render-dashboard.ts), not the platform's: a green sweep
 * here predicts the Linux-only CI gate. A text-bearing slot additionally
 * names itself in metricProbe to prove its height survives divergent fonts.
 *
 * Exit 1 means geometry moved, a fixture guard is missing, or the runner itself
 * failed. Exit 2 means a case never ran (a vanished selector, a toggle that no
 * longer induces its state, a baseline already toggled) or an expectedDrift
 * marker whose drift is gone: a stale entry is its own failure, never a green.
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
 * Sub-pixel slack for antialiased layout: two paints of the same box can differ
 * by a rounding step without any rule having moved. Past half a pixel is a rule.
 */
const TOLERANCE_PX = 0.5;

/** The width-extreme viewport: past the pane's 1560px cap plus the rail, so every surface is at its widest. */
const WIDE_VIEWPORT_PX = 2000;

/**
 * A marker as probe SOURCE: two halves joined at runtime, so the assembled word
 * exists only in a thrown message and never in the expression the harness
 * echoes under it, where it would match every failure the probe can have. The
 * runner greps the whole word.
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
	/**
	 * The largest magnitude the marker accepts, in px, for every drift it
	 * names. Required, because a prefix alone would bless a 40px regression in
	 * the same place as a known 1px one.
	 */
	readonly maxAbsPx: number;
}

interface StatePairBase {
	readonly name: string;
	/** The render fixture (a renderFixtures/ file name) whose page hosts the element. */
	readonly fixture: string;
	/** Selectors measured before and after the toggle; each must hold every non-intended dimension. */
	readonly targets: readonly string[];
	/** A selector whose nextElementSibling's top edge is also held: "the row below must not move". */
	readonly siblingOf?: string;
	/** Steps run before the baseline measurement (open the popover the pair lives in). */
	readonly setup?: readonly string[];
	/**
	 * A viewport width forced onto the pair's fixture, for a tier the fixture's
	 * own width never reaches; the restVerify should then also prove the tier
	 * engaged, since a platform minimum can hand back something wider.
	 */
	readonly viewportWidth?: number;
	/**
	 * An inline width forced onto .pane itself, for a tier below what any
	 * viewport can reach (the platform's window minimum is ~500px on macOS,
	 * and the armed cover's floor tier lives under a 400px pane). The pane's
	 * container queries answer to its content box, so an inline width engages
	 * the tier directly; the restVerify should still prove it engaged.
	 */
	readonly paneWidth?: number;
	/** Steps that induce the second state. */
	readonly toggle: readonly string[];
	/**
	 * A page expression that must be truthy at the BASELINE, proving the rest
	 * state is really at rest: a fixture that one day starts in the toggled state
	 * would otherwise compare the state against itself.
	 */
	readonly restVerify: string;
	/** The mirror guard after the toggle: truthy proves the state was actually induced. */
	readonly verify: string;
	/**
	 * Dimensions a NAMED target is allowed to change, with the reason in the
	 * entry's comment. Per target on purpose: an exemption one element earns must
	 * not silently cover its neighbours.
	 */
	readonly intended?: Readonly<Record<string, readonly Dim[]>>;
}

/**
 * metricProbe and expectedDrift are mutually exclusive by type: an
 * expected-drift compare never returns, so a probe behind one would never run.
 */
type StatePair = StatePairBase &
	(
		| {
				/**
				 * Text-bearing slots whose HEIGHT must not depend on font metrics: after
				 * the pair holds, each is re-measured under the harness's divergent font
				 * faces (same glyph sources, deliberately different vertical metrics, so
				 * the swap changes nothing but the metrics) - once with only the mono
				 * token diverging (the mixed sans+mono line box that broke on Linux) and
				 * once with both. A height that moves would pass on one platform's fonts
				 * and fail on another's, so it fails here on every platform instead.
				 */
				readonly metricProbe?: readonly string[];
				readonly expectedDrift?: undefined;
		  }
		| {
				/**
				 * The pair drifts on today's main and the defect is known: the sweep stays
				 * green by asserting the NAMED drifts are still there, within the marker's
				 * bound, and nothing else moved. Remove the marker in the same change that
				 * fixes the defect - a marker whose drift is gone fails as stale.
				 */
				readonly expectedDrift: ExpectedDrift;
				readonly metricProbe?: undefined;
		  }
	);

/** The theme appearance row, the settings row every pair on that page anchors to. */
const THEME_ROW = '.setting-row:has([id="setting-ui.theme"])';
/** The usage-thresholds row, whose error contract is "the overlay never changes the row's height". */
const THRESHOLDS_ROW = '.setting-row:has([id="setting-usage.alertThresholds-warning"])';
/**
 * That row's PARSE-error overlay, named by the id its inputs' aria-describedby
 * points at rather than by `.setting-hint .error`: a refused write renders its
 * own overlay in the same covered slot with the same class, and guards that
 * cannot tell the two apart stop naming the state they induce.
 */
const THRESHOLDS_PARSE_ERROR = `${THRESHOLDS_ROW} .setting-hint span.error[id="setting-usage.alertThresholds-problem"]`;
/**
 * The same row's write-REFUSAL overlay: the covered slot's other tenant,
 * identified by NOT carrying the parse error's id (err-scalar.ts pins the same
 * disambiguation).
 */
const THRESHOLDS_REFUSAL = `${THRESHOLDS_ROW} .setting-hint .setting-cover > span.error:not([id])`;
/** The row's ONE help glyph, in the live flow beside whichever tenant the covered slot shows. */
const THRESHOLDS_GLYPH = `${THRESHOLDS_ROW} .setting-hint .setting-live button.help`;
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
/** The Copy diagnostics tool in the Diagnostics page's vertical action stack (third of the four tools). */
const COPY_TOOL = ".diagnostics-tools li:nth-child(3) button";

/**
 * The armed cover's own claim, stated in the pair's verify because the pair
 * cannot see it: the cover is out of flow, so one that fails to fill the row
 * moves no target and every held dimension still passes. Edges must MATCH,
 * not merely contain: a cover spilling past the row would cover neighbours it
 * has no business covering. Top, bottom, and right are equal at every tier
 * and the left edge never crosses the row's; "both" makes left an equality
 * too, for the floor tier where the cover takes the whole row and a
 * shrink-to-fit box would leave the row's first characters readable beside
 * the confirm.
 */
function coversTheRow(item: string, axes: "block" | "both"): string {
	// Left is containment at the wider tiers (the cover may end where its
	// content does, but never past the row) and equality at the floor.
	const left = axes === "both" ? "Math.abs(box.left - covered.left) <= 0.5" : "box.left >= covered.left - 0.5";
	return `(() => {
		const cover = document.querySelector(${JSON.stringify(`${item} .server-actions.armed`)});
		const row = document.querySelector(${JSON.stringify(`${item} .server-row`)});
		if (cover === null || row === null) { return false; }
		const box = cover.getBoundingClientRect();
		const covered = row.getBoundingClientRect();
		return Math.abs(box.top - covered.top) <= 0.5 && Math.abs(box.bottom - covered.bottom) <= 0.5 &&
			Math.abs(box.right - covered.right) <= 0.5 && ${left};
	})()`;
}

/** Narrows .pane to an inline width, engaging container-query tiers no viewport width can reach. */
function paneWidthStep(width: number): string {
	return `(() => {
		const pane = document.querySelector(".pane");
		if (pane === null) { throw new Error(${marker("SETUP", ": no .pane to narrow")}); }
		pane.style.flex = "0 0 auto";
		pane.style.width = ${JSON.stringify(`${width}px`)};
		pane.style.minWidth = "0";
		pane.style.maxWidth = "none";
	})()`;
}

/** The pane's content-box width is under the given tier threshold - the same measure its container queries read. */
function paneTierEngaged(below: number): string {
	return `(() => {
		const pane = document.querySelector(".pane");
		const style = getComputedStyle(pane);
		return pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) < ${below};
	})()`;
}

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
		// Marking a settings row modified may change the gutter border's COLOR and
		// reveal the Reset action (opacity only); the row's box and the row below
		// must not move.
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
		// A modified row's hover/focus reveal is opacity through the Reveal
		// primitive; revealing it must not move the row or the row below. Driven
		// through the focus half, because a fixture step cannot create :hover.
		name: "settings-row-reveal",
		fixture: "settings-appearance-set.ts",
		targets: [THEME_ROW],
		siblingOf: THEME_ROW,
		toggle: [
			`document.querySelector(${JSON.stringify(`${THEME_ROW} .setting-actions button.reveal-json`)})` +
				`.focus({ preventScroll: true })`,
		],
		// The opacity lives on the Reveal WRAPPER (ui/reveal.tsx's data-slot), not
		// the button: computed opacity does not inherit as a value, so a guard on
		// the button inside a faded wrapper would read "1" in both states.
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
		// A settings row's parse error COVERS the description, so the row must not
		// grow. The verify also holds the row's one help glyph, which trails the
		// error's own tail while the cover stands: a cover without a painted glyph
		// is a regression this pair names.
		name: "settings-row-error-overlay",
		fixture: "settings.ts",
		targets: [THRESHOLDS_ROW],
		siblingOf: THRESHOLDS_ROW,
		toggle: [reactType('[id="setting-usage.alertThresholds-warning"]', "abc")],
		restVerify: `document.querySelector(${JSON.stringify(THRESHOLDS_PARSE_ERROR)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(THRESHOLDS_PARSE_ERROR)}) !== null && ` +
			`(document.querySelector(${JSON.stringify(THRESHOLDS_GLYPH)})?.getBoundingClientRect().width ?? 0) > 0`,
	},
	{
		// The Copy diagnostics check-mark flash swaps the button's leading glyph
		// in place: it must not resize the button or move the action stack. The
		// rest glyph's path is stashed on the window so the verify proves the swap
		// happened rather than comparing the state against itself.
		name: "diagnostics-copy-flash",
		fixture: "diagnostics.ts",
		targets: [COPY_TOOL, ".diagnostics-tools"],
		siblingOf: ".diagnostics-tools",
		toggle: [`document.querySelector(${JSON.stringify(COPY_TOOL)}).click()`],
		restVerify:
			`(() => { const button = document.querySelector(${JSON.stringify(COPY_TOOL)}); ` +
			`if (button === null || !button.textContent.includes("Copy diagnostics")) { return false; } ` +
			`window.__copyGlyphAtRest = button.querySelector("svg path")?.getAttribute("d") ?? ""; ` +
			`return window.__copyGlyphAtRest.length > 0; })()`,
		verify:
			`(() => { const path = document.querySelector(${JSON.stringify(COPY_TOOL)})` +
			`?.querySelector("svg path")?.getAttribute("d") ?? ""; ` +
			`return path.length > 0 && path !== window.__copyGlyphAtRest; })()`,
	},
	{
		// The server row's actions cluster occupies a reserved track and reveals by
		// opacity: revealing it must not move the row, its name or URL text, or
		// the row below. Driven through :focus-within, the reveal's keyboard half.
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
		// Refresh now's busy label swaps in over a reserved width twin (both labels
		// stay mounted in one grid cell), so flipping to "Refreshing..." must not
		// resize the button, move Add server, or move the header line.
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
		// Arming Remove swaps the resting pair for a two-step confirm that leaves
		// the flow and COVERS the row's cells, and must move NOTHING. The cluster
		// itself is not a target: becoming the cover changes its box by design.
		name: "server-row-armed-cover",
		fixture: "servers-spend.ts",
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-line`,
			`${FIRST_SERVER_ITEM} .server-name`,
			`${FIRST_SERVER_ITEM} .server-usage`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const remove = [...document.querySelectorAll(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions button`)})]
					.find((button) => button.textContent.trim() === "Remove");
				if (remove === undefined) { throw new Error(${marker("SETUP", ": no Remove button on the first server row")}); }
				remove.click();
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) !== null && ` +
			coversTheRow(FIRST_SERVER_ITEM, "block"),
	},
	{
		// The folded tier's twin of the pair above, where the row is two lines and
		// a cover failing to fill it would leave the whole meta line readable
		// under the confirm. The restVerify also proves the tier really folded,
		// since a platform minimum can hand back something wider.
		name: "server-row-armed-cover-folded",
		fixture: "servers-spend.ts",
		viewportWidth: 500,
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-line`,
			`${FIRST_SERVER_ITEM} .server-name`,
			`${FIRST_SERVER_ITEM} .server-usage`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const remove = [...document.querySelectorAll(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions button`)})]
					.find((button) => button.textContent.trim() === "Remove");
				if (remove === undefined) { throw new Error(${marker("SETUP", ": no Remove button on the first server row")}); }
				remove.click();
			})()`,
		],
		restVerify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) === null && ` +
			`getComputedStyle(document.querySelector(".server-meta")).display === "flex"`,
		verify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) !== null && ` +
			coversTheRow(FIRST_SERVER_ITEM, "block"),
	},
	{
		// The floor tier's cover takes the WHOLE row (grid-column 1/-1,
		// inset-inline 0, justify-self stretch): one that shrink-to-fits leaves
		// the row's first characters readable beside the confirm, so the claim is
		// both axes. paneWidth reaches the sub-400 tier no viewport width can
		// (the platform window minimum), and the restVerify proves it engaged.
		name: "server-row-armed-cover-floor",
		fixture: "servers-spend.ts",
		paneWidth: 320,
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-line`,
			`${FIRST_SERVER_ITEM} .server-name`,
			`${FIRST_SERVER_ITEM} .server-usage`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const remove = [...document.querySelectorAll(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions button`)})]
					.find((button) => button.textContent.trim() === "Remove");
				if (remove === undefined) { throw new Error(${marker("SETUP", ": no Remove button on the first server row")}); }
				remove.click();
			})()`,
		],
		restVerify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) === null && ` +
			paneTierEngaged(400),
		verify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .server-actions.armed`)}) !== null && ` +
			coversTheRow(FIRST_SERVER_ITEM, "both"),
	},
	{
		// The "stale" qualifier lands INLINE before the spend figure and the
		// .server-usage floor absorbs it, so the mark must not move the row, the
		// cell, or the row below. The setup first makes every card fresh: the
		// fixture ships one already stale, whose composition would pre-widen the
		// shared track and let a dropped floor pass unmeasured. The unit's width
		// and x are INTENDED - "stale 42%" is more text, right-justified.
		name: "server-spend-stale",
		fixture: "servers-spend.ts",
		setup: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				for (const server of push.state.usage.servers) {
					if (server.kind === "usage") { server.fresh = true; }
				}
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-usage`,
			`${FIRST_SERVER_ITEM} .spend-unit`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				for (const server of push.state.usage.servers) {
					if (server.kind === "usage") { server.fresh = server.label !== "prod"; }
				}
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify: `document.querySelector(".spend-note") === null`,
		verify: `document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .spend-note`)}) !== null`,
		intended: { [`${FIRST_SERVER_ITEM} .spend-unit`]: ["width", "x"] },
	},
	{
		// The folded twin, where the spend cell sits on a WRAPPING flex meta line
		// and the word arriving without a reservation could re-wrap it. Only width
		// is intended there (the unit is left-aligned). No all-fresh setup on
		// purpose: the reservation under test is per-cell at this tier, and the
		// fixture's own stale row keeps the header's wrapping gloss constant. The
		// restVerify proves the tier folded, or the wide tier is measured twice.
		name: "server-spend-stale-folded",
		fixture: "servers-spend.ts",
		viewportWidth: 500,
		targets: [
			`${FIRST_SERVER_ITEM} .server-row`,
			`${FIRST_SERVER_ITEM} .server-usage`,
			`${FIRST_SERVER_ITEM} .spend-unit`,
		],
		siblingOf: FIRST_SERVER_ITEM,
		toggle: [
			`(() => {
				const push = structuredClone(window.__fixtureMessages.find((message) => message.kind === "push"));
				const prod = push.state.usage.servers.find((server) => server.label === "prod");
				if (prod === undefined) { throw new Error(${marker("SETUP", ": no prod usage card in the fixture push")}); }
				prod.fresh = false;
				window.dispatchEvent(new MessageEvent("message", { data: push }));
			})()`,
		],
		restVerify:
			`document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .spend-note`)}) === null && ` +
			`document.querySelector(".spend-note") !== null && ` +
			`getComputedStyle(document.querySelector(".server-meta")).display === "flex"`,
		verify: `document.querySelector(${JSON.stringify(`${FIRST_SERVER_ITEM} .spend-note`)}) !== null`,
		intended: { [`${FIRST_SERVER_ITEM} .spend-unit`]: ["width"] },
	},
	{
		// A record chip's invalid mark is a border-color change on a border that is
		// always there, and the popover is out of flow: the claim is the vertical
		// one, that the mark never adds a line or moves the row. Width and x are
		// INTENDED - the chip echoes the draft's text and resizes by design.
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
		// The server form's field problem is an overlay COVERING the row's reserved
		// hint slot, and the connection-consequence note holds its box as an
		// invisible twin: a field going invalid must not move the input or grow
		// the form.
		name: "form-url-error",
		fixture: "form-apikey.ts",
		targets: ["#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-baseUrl", "not a url")],
		restVerify: `document.querySelector('[id="server-baseUrl-error"] .error') === null`,
		verify: `document.querySelector('[id="server-baseUrl-error"] .error') !== null`,
		expectedDrift: {
			reason:
				"Under the pinned measurement fonts the sticky toolbar's trailing message span wraps to a second " +
				"line when the field problem speaks, growing the toolbar and the form 1px: the slot reserves one " +
				"line, not a wrap-proof box. The fix belongs to the form's toolbar message slot in src/webview.",
			where: ["#server-edit-page height"],
			maxAbsPx: 1.5,
		},
	},
	{
		// A custom-header row's parse verdict lands in the row's reserved status
		// line: the row, the row below, and the form must not move when a name
		// goes invalid.
		name: "form-header-row-error",
		fixture: "form-apikey.ts",
		targets: [FIRST_HEADER_ROW, "#server-edit-page"],
		siblingOf: FIRST_HEADER_ROW,
		toggle: [reactType(`${FIRST_HEADER_ROW} input[aria-label="Header name"]`, "bad header")],
		restVerify: `document.querySelector("#server-edit-page .row .row-status.error") === null`,
		verify: `document.querySelector("#server-edit-page .row .row-status.error") !== null`,
		expectedDrift: {
			reason: "The same wrapping toolbar message span as form-url-error, spoken to by the row verdict's summary.",
			where: ["#server-edit-page height"],
			maxAbsPx: 1.5,
		},
	},
	{
		// The matcher editor overlay's per-row verdict lands in the row's reserved
		// status line: the row, the rows grid, and the Add action under it must
		// not move. The capability twin below drives the same machinery.
		name: "record-overlay-row-error",
		fixture: "record-overlay.ts",
		targets: [".matcher-editor .rows > .row", ".matcher-editor .rows"],
		siblingOf: ".matcher-editor .rows",
		toggle: [reactType(".matcher-editor .rows input.value", "not json")],
		restVerify: `document.querySelector(".matcher-editor .row-status.error") === null`,
		verify: `document.querySelector(".matcher-editor .row-status.error") !== null`,
	},
	{
		// The capability twin, whose rows carry standing HINTS at rest: a problem
		// landing beside them must hold the grid and the overlay footer still.
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
		// A refused record Apply lands in the footer's inline message slot: the
		// frame, its action bar, the slot's own box, the Add action, and the
		// commit trio must not move. The toggle drives the real flow, quoting the
		// posted request's id off the harness stub like err-recordeditor.ts.
		name: "record-apply-failure-note",
		fixture: "settings.ts",
		setup: [
			// A dirty draft first, since that is the state the refusal lands on.
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
		metricProbe: [`${PARAMS_FRAME} .editor-status`],
	},
	{
		// A refused settings write covers the posting row's description slot: the
		// row and the row below must not move. Sibling pair of
		// settings-row-error-overlay, which toggles the slot's OTHER tenant.
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
				// The reader tabs to the row's help before the refusal lands: the row
				// has ONE glyph outside the swapping tenants, so the same element must
				// keep the keyboard through the cover mounting - no hand-off, no swap.
				const glyph = document.querySelector(${JSON.stringify(THRESHOLDS_GLYPH)});
				if (glyph === null) { throw new Error(${marker("SETUP", ": no help glyph on the thresholds row")}); }
				glyph.focus({ preventScroll: true });
				window.__thresholdsGlyph = glyph;
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							kind: "fail",
							id: posted.id,
							method: "setUsageAlertThresholds",
							message: "Alert thresholds must be above 0% and at most 100% - enter values like 80% or 0.8.",
							failureKind: "validation",
							row: "usage.alertThresholds",
						},
					})
				);
			})()`,
		],
		restVerify: `document.querySelector(${JSON.stringify(THRESHOLDS_REFUSAL)}) === null`,
		verify:
			`document.querySelector(${JSON.stringify(THRESHOLDS_REFUSAL)}) !== null && ` +
			`(document.querySelector(${JSON.stringify(THRESHOLDS_GLYPH)})?.getBoundingClientRect().width ?? 0) > 0 && ` +
			`document.activeElement === window.__thresholdsGlyph && ` +
			`document.activeElement === document.querySelector(${JSON.stringify(THRESHOLDS_GLYPH)})`,
	},
	{
		// The server form's rename note holds its box as an invisible spacing twin
		// under the Label row: speaking must not push the rows below down. The
		// fixture opens with a field error already standing, so this also proves
		// the note does not disturb the covered-slot error above it.
		name: "form-rename-note",
		fixture: "err-serverform.ts",
		targets: ["#server-label", "#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-label", "prod-eu")],
		restVerify:
			`getComputedStyle(document.querySelector("#server-edit-page .rename-note"))` + `.visibility === "hidden"`,
		verify: `getComputedStyle(document.querySelector("#server-edit-page .rename-note"))` + `.visibility === "visible"`,
	},
	{
		// The add form's twin: a label colliding with a declared entry speaks the
		// collides note in the same reserved line, and must not push the form
		// down. Only the ADD form renders .collides-note, and "prod" is a declared
		// label in the shared base state, so the toggle is a real collision.
		name: "form-collides-note",
		fixture: "form-apiversion-auto.ts",
		targets: ["#server-label", "#server-baseUrl", "#server-edit-page"],
		toggle: [reactType("#server-label", "prod")],
		restVerify:
			`getComputedStyle(document.querySelector("#server-edit-page .collides-note"))` + `.visibility === "hidden"`,
		verify:
			`getComputedStyle(document.querySelector("#server-edit-page .collides-note"))` + `.visibility === "visible"`,
		expectedDrift: {
			reason: "The same wrapping toolbar message span as form-url-error, spoken to by the collision summary.",
			where: ["#server-edit-page height"],
			maxAbsPx: 1.5,
		},
	},
	{
		// The matcher editor's status line under the matcher input is ONE reserved
		// line (the grammar reading at rest, the parse verdict while one stands),
		// so a verdict must not move the Inherits control, the field rows, or the
		// footer. The toggle uses a reserved name, so both readings apply at once.
		name: "record-overlay-prefix-error",
		fixture: "record-overlay.ts",
		targets: [".matcher-editor .matcher-line", ".matcher-editor .rows", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .editor-section",
		toggle: [reactType(".matcher-editor .matcher-line input.key", "__proto__")],
		restVerify: `document.querySelector(".matcher-editor .matcher-status.error") === null`,
		verify: `document.querySelector(".matcher-editor .matcher-status.error") !== null`,
	},
	{
		// The same slot's other swap: an EMPTY matcher's status speaks the parse's
		// verdict, and the first keystroke swaps it for the grammar reading, which
		// must not move the sections below. The setup drives the editor into the
		// empty state the fixture never rests in.
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
		// action the resting anchor rides on, so the frame is re-anchored by the
		// door's own textarea for every measurement after setup.
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
		// popover closes over an invalid draft: the row, the row below, the table,
		// the frame, the footer, the slot, and both button groups must hold still.
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
		metricProbe: [`${PARAMS_FRAME} .editor-status`],
	},
	{
		// The same claim from the LAST row, whose verdict lands in the footer
		// directly under it. The chip's own width/x change belongs to
		// record-chip-invalid, not measured here.
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
		metricProbe: [`${PARAMS_FRAME} .editor-status`],
	},
	{
		// The chip popover's verdict lands in its reserved status slot AFTER the
		// actions: Remove field must not move down under the pointer. Width is
		// INTENDED on both - the popover hugs its content and the value input
		// echoes the draft's text, so the claim is the vertical one.
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
	{
		// The record grid's key track is a fixed range in the stylesheet, so TYPING a
		// key - focus still in the input, no blur - must not re-solve the tracks: the
		// first row's value cell, the grid, and the footer hold while a name far past
		// the 24ch cap goes in. This is the no-reflow property the deleted JS
		// key-track freeze used to approximate; the setup adds a fresh row so the
		// typing strands no directive mark (a hint would legitimately fill a status
		// line elsewhere).
		name: "record-overlay-key-typing",
		fixture: "record-overlay.ts",
		setup: [
			`(() => {
				const add = [...document.querySelectorAll(".matcher-editor button")]
					.find((b) => b.textContent.trim() === "Add parameter");
				if (add === undefined) { throw new Error(${marker("SETUP", ": no Add parameter action in the overlay")}); }
				add.click();
			})()`,
		],
		targets: [".matcher-editor .rows", ".matcher-editor .rows > .row .cell.value", ".matcher-editor .editor-footer"],
		siblingOf: ".matcher-editor .rows",
		toggle: [
			`(() => {
				const inputs = [...document.querySelectorAll(".matcher-editor .rows input.key")];
				const input = inputs[inputs.length - 1];
				if (input === undefined) { throw new Error(${marker("SETUP", ": no key input in the overlay grid")}); }
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
				input.focus({ preventScroll: true });
				setter.call(input, "a_much_longer_parameter_name_than_any_track_should_chase");
				input.dispatchEvent(new Event("input", { bubbles: true }));
			})()`,
		],
		restVerify: `[...document.querySelectorAll(".matcher-editor .rows input.key")].at(-1)?.value === ""`,
		verify:
			`[...document.querySelectorAll(".matcher-editor .rows input.key")].at(-1)?.value === ` +
			`"a_much_longer_parameter_name_than_any_track_should_chase" && ` +
			`document.activeElement === [...document.querySelectorAll(".matcher-editor .rows input.key")].at(-1)`,
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
 * The width extremes: each surface rendered at 2000px, asserting its structural
 * container's right edge lands on the pane's content edge (the charter's ruling
 * that structure runs full-bleed and only prose keeps a reading measure).
 * measure.test.ts pins the ruling in source; this pins that the rendered box
 * actually reaches the edge.
 */
const WIDTH_SURFACES: readonly WidthSurface[] = [
	{ name: "models-list-full-bleed", fixture: "models.ts", selector: ".model-list" },
	{ name: "servers-list-full-bleed", fixture: "servers-spend.ts", selector: "ul.server-list" },
	{ name: "diagnostics-problems-full-bleed", fixture: "diagnostics.ts", selector: ".config-diagnostics" },
	{ name: "diagnostics-resolution-full-bleed", fixture: "diagnostics.ts", selector: ".resolved-scroll" },
	// The settings rows adopt .settings-groups' shared tracks through subgrid and
	// the label track auto-grows to the longest title, but the fixed trailing
	// actions slot must still land on the pane's content edge. The claim is on
	// the actions cell because the row's own box overhangs by 8px (the hover
	// tint), so the cell is where the CONTENT stops.
	{ name: "settings-rows-full-bleed", fixture: "settings.ts", selector: ".setting-row .setting-actions" },
];

/**
 * Fixtures that drive a flow through steps WITHOUT a throwing assertion on
 * their own subject, grandfathered as found - each pinned to a digest of its
 * steps, so MODIFYING a grandfathered flow invalidates the exemption along with
 * adding a new one. THIS LIST ONLY SHRINKS: a fixture running its steps against
 * the wrong page exits 0 with a plausible PNG, which has happened at scale. An
 * entry whose fixture now throws (or lost its steps, or is gone) fails as
 * stale. To update a digest is to re-grandfather changed steps, which defeats
 * the leg: add the throwing assertion and DELETE the entry.
 */
const UNGUARDED_FIXTURE_PINS: readonly (readonly [string, string])[] = [
	["confirm-discard.ts", "8bca510c05ad"],
	["diagnostics-inspector.ts", "8a1701a0f708"],
	["form-apikey.ts", "d1121e72b575"],
	["form-apiversion-auto.ts", "f9159772b925"],
	["form-apiversion-custom.ts", "d1121e72b575"],
	["form-apiversion-none.ts", "d1121e72b575"],
	["form-caps-open.ts", "8273f2c88f65"],
	["form-oauth.ts", "d1121e72b575"],
	["form-records-overlay.ts", "8273f2c88f65"],
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
 * Whether a step contains a real throw STATEMENT, by parsing it: a substring
 * test is satisfied by the word in a comment or a string literal, and a guard
 * leg that can be met by prose is met by prose eventually.
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

/**
 * The static guard sweep, over each fixture's EXPORTED shape rather than its
 * text: steps arrive by spread and import as well as by literal, and the
 * assertion has to live in the steps that actually run.
 */
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
	// With an expectedDrift marker the probe decides between "the named drifts
	// still stand within their bound" (XDRIFT, green), "a drift outside the
	// list or past the bound" (DRIFT, which a known defect must not hide), and
	// "no drift at all" (STALE).
	const verdict =
		pair.expectedDrift === undefined
			? `if (drifts.length > 0) {
			throw new Error(${marker("DRIFT", ` ${pair.name}:`)} + "\\n  " + drifts.map((drift) => drift.line).join("\\n  "));
		}`
			: `const where = ${JSON.stringify(pair.expectedDrift.where)};
		const maxAbsPx = ${pair.expectedDrift.maxAbsPx};
		const unexpected = drifts.filter(
			(drift) => !where.some((prefix) => drift.key.startsWith(prefix)) || Math.abs(drift.delta) > maxAbsPx
		);
		if (unexpected.length > 0) {
			throw new Error(
				${marker("DRIFT", ` ${pair.name} (outside its expectedDrift list or past its ${pair.expectedDrift.maxAbsPx}px bound):`)} +
				"\\n  " + unexpected.map((drift) => drift.line).join("\\n  ")
			);
		}
		// Dead prefixes fail too: a partially fixed defect must shrink the
		// where-list with the fix, or the list quietly stops describing main.
		const dead = where.filter((prefix) => !drifts.some((drift) => drift.key.startsWith(prefix)));
		if (dead.length > 0) {
			throw new Error(
				${marker("STALE", ` ${pair.name}: expected drift no longer occurs at `)} + dead.join(", ") +
				"; shrink or remove the expectedDrift marker"
			);
		}
		throw new Error(
			${marker("XDRIFT", ` ${pair.name} (expected on today's main):`)} + "\\n  " +
			drifts.map((drift) => drift.line).join("\\n  ")
		);`;
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
				drifts.push({
					key: what + " " + dim,
					delta,
					line:
						what + " " + dim + " " + was.toFixed(2) + "px -> " + now.toFixed(2) +
						"px (moved " + delta.toFixed(2) + "px)",
				});
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

/**
 * The font-metric divergence probe, run in the toggled state after the pair
 * held: re-measures each named slot with the divergent faces swapped in
 * through the font tokens and fails when a height moves. The harness has
 * already proven both face sets loaded with their declared metrics, so a
 * height that holds here holds under ANY platform's fonts.
 */
function metricProbeStep(pair: StatePair, selectors: readonly string[]): string {
	return `(async () => {
		${SETTLE_JS}
		${grabJs()}
		const root = document.documentElement;
		const rest = {
			sans: root.style.getPropertyValue("--vscode-font-family"),
			mono: root.style.getPropertyValue("--vscode-editor-font-family"),
		};
		if (!rest.sans.includes("geometry-pinned-sans") || !rest.mono.includes("geometry-pinned-mono")) {
			throw new Error(${marker("SETUP", ": the harness did not pin the fonts, so the divergence probe has nothing to toggle")});
		}
		const selectors = ${JSON.stringify(selectors)};
		const under = async (sans, mono) => {
			root.style.setProperty("--vscode-font-family", sans);
			root.style.setProperty("--vscode-editor-font-family", mono);
			await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
			return selectors.map((selector) => grab(selector).height);
		};
		const pinned = await under(rest.sans, rest.mono);
		const mixed = await under(rest.sans, "geometry-divergent-mono");
		const swapped = await under("geometry-divergent-sans", "geometry-divergent-mono");
		await under(rest.sans, rest.mono);
		const moved = [];
		selectors.forEach((selector, index) => {
			for (const [label, heights] of [["a divergent mono face", mixed], ["divergent faces throughout", swapped]]) {
				if (Math.abs(heights[index] - pinned[index]) > ${TOLERANCE_PX}) {
					moved.push(
						selector + " height " + pinned[index].toFixed(2) + "px -> " + heights[index].toFixed(2) +
						"px under " + label
					);
				}
			}
		});
		if (moved.length > 0) {
			throw new Error(${marker("DRIFT", ` ${pair.name} (height depends on font metrics):`)} + "\\n  " + moved.join("\\n  "));
		}
	})()`;
}

function widthStep(surface: WidthSurface): string {
	const within = surface.within ?? 1;
	return `(async () => {
		${SETTLE_JS}
		// The steps run before the harness's own asserted setWidth, on whatever
		// viewport --window-size produced, and a platform minimum can hand back
		// something narrower. At a shrunken width every surface fills whatever
		// pane is left and the extreme goes untested, so it fails as never-ran.
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
	/** A viewport width forced onto the fixture; pairs without one keep the fixture's own. */
	readonly viewportWidth?: number;
	/** Whether the case carries an expectedDrift marker (its probe then never exits green). */
	readonly expectsDrift: boolean;
}

function pairCase(pair: StatePair): SweepCase {
	return {
		name: pair.name,
		fixture: pair.fixture,
		steps: [
			...(pair.paneWidth === undefined ? [] : [paneWidthStep(pair.paneWidth)]),
			...(pair.setup ?? []),
			measureStep(pair),
			...pair.toggle,
			compareStep(pair),
			...(pair.metricProbe === undefined ? [] : [metricProbeStep(pair, pair.metricProbe)]),
		],
		...(pair.viewportWidth === undefined ? {} : { viewportWidth: pair.viewportWidth }),
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
 * runs the probes exactly as it runs any fixture's own steps. Generated under
 * tmp and imported by absolute path, so the base fixture's relative imports
 * still resolve at its real location.
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
 * (no PNG) while the steps and the own-width overflow assertion still run; a
 * probe's throw surfaces as exit 1 with its runtime-assembled marker in the
 * output, which is the whole wire protocol between the two scripts.
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
		// probe (it always throws one of its three verdicts), so reaching it means
		// the compare step never ran: a stale entry, not a pass.
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
		// A case whose base fixture is gone never ran: the renamed-fixture failure
		// belongs to exit 2's vocabulary, not to a runner crash that would take
		// the rest of the sweep with it.
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
