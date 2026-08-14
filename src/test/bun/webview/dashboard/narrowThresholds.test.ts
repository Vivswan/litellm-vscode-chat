/**
 * The narrow system's own arithmetic, checked against the stylesheet rather
 * than against a memory of it.
 *
 * The rail collapses on a WINDOW query while every other threshold asks the
 * PANE, and those two are not the same axis: collapsing hands the pane 168px
 * back, so the pane's width is DISCONTINUOUS at the collapse. A window growing
 * through it drops the pane from about 903 to about 735 and then grows again,
 * which means every pane width in that band happens twice - once on each side -
 * and a breakpoint inside it fires in REVERSE as the window widens. A reader
 * dragging a splitter rightward watches the page fold instead of unfold.
 *
 * That is not a bug any suite can see: happy-dom has no layout, the pixel gate
 * is gone, and a render only catches it if someone thinks to shoot the two
 * widths either side of 1000. It is arithmetic, though, and arithmetic can be
 * checked - so this reads the numbers out of the stylesheet and the components
 * and fails when they stop agreeing.
 *
 * The other hazard is spelling. Tailwind compiles `@max-[Npx]/pane:` to
 * `width < N` while `@container pane (max-width: N)` is `<= N`, so a rule and
 * the utility it PAIRS with disagree at exactly N - a one-pixel band where a row
 * takes half of each layout. 620 was spelled both ways for a while, excused
 * because the two rules sat on surfaces that never meet: an exemption resting on
 * where a rule happens to live, which expires the day a component moves.
 *
 * So the third test does not enumerate the bad spellings - `max-width` is only
 * the first of them, and `620px >= width`, `max-inline-size`, `@max-lg/pane:`
 * and `@max-[620px]:` are all valid and all either inclusive or a second way to
 * write the legal one. It names the good spelling instead and reports the rest:
 * `@container pane (width < Npx)` in a stylesheet, `@max-[Npx]/pane:` in a class
 * string. "One spelling per number" then holds because there is only one
 * spelling at all.
 *
 * The two halves are strict in different ways, which is worth knowing before
 * reading a failure. The stylesheet half judges only queries that constrain the
 * PANE's width, so a differently named container and a `style()` query pass
 * untouched, and it judges the prelude WHOLE - the legal form has no compound
 * spelling, so a query mixing a legal width with anything else is still
 * reported. The component half judges every container variant it finds,
 * including one naming another container, because an unnamed variant lands on
 * the pane and there is no cheap way to tell the two apart in a class string.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RAIL_COLLAPSE_QUERY } from "../../../../webview/dashboard/rail";

const ROOT = join(import.meta.dir, "../../../../..");
const STYLESHEET = join(ROOT, "src/webview/dashboard/styles/dashboard.css");
const WEBVIEW = join(ROOT, "src/webview/dashboard");
const WEBVIEW_TREE = join(ROOT, "src/webview");
const THEME = join(WEBVIEW, "styles/theme.css");

/**
 * The trees a class string can live in: the ones theme.css hands Tailwind in its
 * `@source` lines, READ from there rather than copied here. A scan narrower than
 * the compiler's is a scan with a blind spot in it, and a third `@source` would
 * open one silently if this were a list.
 */
function classRoots(): string[] {
	const roots = [...readFileSync(THEME, "utf8").matchAll(/@source\s+"([^"]+)"/g)].map((match) =>
		resolve(dirname(THEME), match[1] ?? "")
	);
	if (roots.length === 0) {
		throw new Error("could not read any @source root from theme.css");
	}
	return roots;
}

function stylesheet(): string {
	return readFileSync(STYLESHEET, "utf8");
}

/** A number the stylesheet states once and everything else derives from. */
function declared(pattern: RegExp, what: string): number {
	const found = pattern.exec(stylesheet());
	if (found?.[1] === undefined) {
		throw new Error(`could not read ${what} from dashboard.css`);
	}
	return Number(found[1]);
}

/**
 * The band of PANE widths that occur on both sides of the rail's collapse.
 *
 * Everything in it is read from the stylesheet, because the band moves whenever
 * any of these do: the rail's width, its border, the pane's padding, and the
 * window width the collapse happens at. A change to the pane's padding alone
 * moves the band's top by 8px, which is enough to swallow a threshold that was
 * clear of it.
 */
function reversalBand(): { readonly low: number; readonly high: number } {
	const railWidth = declared(/\.rail \{[^}]*flex: 0 0 (\d+)px/s, "the rail's width");
	const collapsedWidth = declared(/\.rail \{\s*flex: 0 0 (\d+)px;\s*\}/s, "the collapsed rail's width");
	// Both anchored to the block they belong to. Unanchored, each takes the
	// FIRST match in the file, so a second width media query or another padding
	// pair would quietly re-point the arithmetic at someone else's rule.
	const panePadding = declared(
		/\.pane \{[^}]*container-name: pane[^}]*\}/s.source.length > 0
			? /\.pane \{[^}]*padding: \d+px (\d+)px[^}]*container-name: pane/s
			: /$^/,
		"the pane's horizontal padding"
	);
	const collapseAt = declared(/@media \(width < (\d+)px\) \{[^@]*?\.rail \{/s, "the rail's collapse width");
	// One border on the rail's trailing edge, at both widths.
	const border = 1;
	return {
		low: collapseAt - (railWidth + border) - panePadding * 2,
		high: collapseAt - (collapsedWidth + border) - panePadding * 2,
	};
}

/** The one form a pane width query may take in a stylesheet, and the one a component may use. */
const LEGAL_CSS_QUERY = /^@container pane \(width < (\d+)px\)$/;
const LEGAL_VARIANT = /^@max-\[(\d+)px\]\/pane:$/;

interface PaneQuery {
	/** The threshold, when the query is spelled legally; absent when it is not. */
	readonly value: number | undefined;
	readonly source: string;
	/** Which harvest found it, so each can be floored against its own population. */
	readonly side: "stylesheet" | "component";
	/** What was actually written, for a failure message that can be acted on. */
	readonly text: string;
}

/**
 * Does this prelude constrain the PANE's width, which is the only thing the
 * one-pixel argument is about?
 *
 * Scoped rather than blanket, because a guard that fails legitimate CSS gets
 * widened by whoever it blocks, and it is easier to widen a rule than to argue
 * with one. A container that is not the pane is a different box on a different
 * axis, and a query with no size in it cannot disagree at a pixel; both pass
 * untouched.
 */
function constrainsPaneWidth(text: string): boolean {
	// A style query asks about custom properties, so it is stripped rather than
	// skipped: `((max-width: 620px) and style(--density: compact))` does BOTH, and
	// skipping the whole prelude on sight of `style(` waved it through. Stripping
	// decides SCOPE only - what is judged afterwards is the prelude entire - and
	// it also stops a `--width` property inside a style query reading as a width.
	const size = text.replace(/style\([^)]*\)/gi, "");
	// `inline-size` as well as `width`: the pane is an `inline-size` container,
	// so that is the feature's other name, and `max-inline-size: 620px` is the
	// same inclusive mistake wearing it.
	if (!/\b(?:width|inline-size)\b/i.test(size)) {
		return false;
	}
	// An UNNAMED query is in scope: the pane is the only container this app
	// declares, so `@container (width < N)` asks the pane whether it says so or
	// not - and having no name, it is not the legal form and will be reported.
	// `not`, `and`, `or` and `none` are excluded from <container-name> by the
	// spec, so a prelude starting with one of them is unnamed, not a container
	// called "not".
	const named = /^@container\s+([a-zA-Z_-][\w-]*)/i.exec(text);
	const name = named?.[1]?.toLowerCase();
	return name === undefined || name === "pane" || name === "not" || name === "and" || name === "or" || name === "none";
}

/**
 * Every pane width query in the webview, legal or not.
 *
 * Both halves match BROADLY and judge afterwards, which is the whole design: a
 * matcher that only recognizes the spellings someone thought of reports a sheet
 * full of `max-width` as a sheet with no thresholds in it, and every assertion
 * below passes over the empty list. So the stylesheet half takes every
 * `@container` prelude and the component half every `@`-run ending in a colon,
 * and each is judged against the one legal form afterwards.
 *
 * It is regexes over source, not a parser over the bundle, so it does not see
 * CSS built by a template literal or a container variant minted by a `@variant`
 * directive. There are none of either; the floors below are what turn a matcher
 * that stopped matching into a failure rather than a silence.
 */
function paneQueries(): PaneQuery[] {
	const found: PaneQuery[] = [];
	// Every stylesheet under the webview tree, not just styles/: both live there
	// today, and a component-local sheet somewhere else is exactly the file
	// nobody would think to scan.
	for (const file of readdirSync(WEBVIEW_TREE, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".css")) {
			continue;
		}
		// Comments out, or the prose ABOUT a rule reads as a rule - the note above
		// the 700px block spells the legal form to explain itself. CSS's comment
		// grammar, not a tokenizer: a `/*` inside a quoted value would open a
		// comment that is not there and swallow the rules after it, which only the
		// stylesheet floor below could notice, and only if it ate enough of them.
		const css = readFileSync(join(WEBVIEW_TREE, file), "utf8").replace(/\/\*.*?\*\//gs, "");
		// Case-insensitive because CSS at-rules are; the legal form is the
		// canonical lower-case spelling, so `@CONTAINER` is caught and reported
		// rather than passing as a second way to write the same rule.
		for (const match of css.matchAll(/@container[^{]*/gi)) {
			const text = match[0].trim();
			if (!constrainsPaneWidth(text)) {
				continue;
			}
			const legal = LEGAL_CSS_QUERY.exec(text);
			found.push({ value: legal === null ? undefined : Number(legal[1]), source: file, side: "stylesheet", text });
		}
	}
	// The components' own halves: a row's track template has to sit with the
	// component, because a utility always beats the stylesheet. Read the trees
	// TAILWIND reads, named in theme.css's own `@source` lines, rather than a
	// list of the files somebody remembered.
	for (const root of classRoots()) {
		for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".tsx") && !file.endsWith(".ts")) {
				continue;
			}
			const source = readFileSync(join(root, file), "utf8");
			// Every container variant, named or not: an `@` run up to its colon.
			// Unnamed counts because `@max-[620px]:` compiles to an unnamed query,
			// which lands on the pane anyway. Stopping the run at the colon keeps a
			// second variant on the same class from being swallowed whole.
			for (const match of source.matchAll(/@[^\s"'`{}:]+:/g)) {
				const text = match[0];
				// Tailwind's arbitrary at-rule variants put their `@` directly after
				// a `[` - `[@media_print]:`, `[@supports(display:grid)]:` - and are
				// not container variants at all. The exception is the one whose
				// at-rule IS `@container`: that is a pane query wearing a bracket,
				// so it is judged like any other.
				if (source[(match.index ?? 0) - 1] === "[" && !text.startsWith("@container")) {
					continue;
				}
				const legal = LEGAL_VARIANT.exec(text);
				found.push({ value: legal === null ? undefined : Number(legal[1]), source: file, side: "component", text });
			}
		}
	}
	return found;
}

/** The legal ones, which are the only ones with a number to do arithmetic on. */
function paneThresholds(): { readonly value: number; readonly source: string }[] {
	const thresholds: { value: number; source: string }[] = [];
	for (const query of paneQueries()) {
		if (query.value !== undefined) {
			thresholds.push({ value: query.value, source: query.source });
		}
	}
	return thresholds;
}

test("no pane threshold sits inside the band the rail's collapse creates", () => {
	const band = reversalBand();
	// Sanity on the EDGES, not the width: the width is the rail's two sizes
	// subtracted from each other, so the padding and the collapse width cancel
	// and a misread of either would pass a width check untouched. These bounds
	// are wide enough to survive a redesign and tight enough to catch a regex
	// that started matching something else.
	expect(band.low).toBeGreaterThan(400);
	expect(band.low).toBeLessThan(band.high);
	expect(band.high).toBeLessThan(1400);
	expect(band.high - band.low).toBeGreaterThan(100);
	// This test reads only the legally spelled queries, so an illegal one would
	// be invisible to it rather than caught by it. The spelling test below is
	// what keeps that set complete, and it fails the build when it is not.
	const inside = paneThresholds().filter((threshold) => threshold.value > band.low && threshold.value < band.high);
	expect(inside.map((threshold) => `${threshold.value} (${threshold.source})`)).toEqual([]);
});

test("the rail's collapse width is the same number in its stylesheet and in its component", () => {
	// CSS decides what the rail looks like; the component decides what it can do
	// (whether the fleet's verdict is worth a tab stop). Neither can read the
	// other, so the only thing keeping them together is this.
	const inCss = declared(/@media \(width < (\d+)px\)/, "the rail's collapse width");
	expect(RAIL_COLLAPSE_QUERY).toBe(`(width < ${inCss}px)`);
	// And the utilities that give the collapsed rail its geometry.
	const railSource = readFileSync(join(WEBVIEW, "rail.tsx"), "utf8");
	for (const match of railSource.matchAll(/max-\[(\d+)px\]:/g)) {
		expect(Number(match[1])).toBe(inCss);
	}
});

test("every pane query is spelled the one legal way", () => {
	const queries = paneQueries();
	// A floor before the judgement, because every assertion here is "this derived
	// list is empty" and an empty INPUT satisfies all of them. One floor per side,
	// not one over the total: the component half is four times the size of the
	// stylesheet half, so a single number big enough to matter for the components
	// is one the eight CSS queries could vanish underneath. Both are well under
	// today's counts, so ordinary edits do not touch them.
	expect(queries.filter((query) => query.side === "stylesheet").length).toBeGreaterThan(4);
	expect(queries.filter((query) => query.side === "component").length).toBeGreaterThan(12);
	// Both sides of the pane's one-pixel argument, in one list: a stylesheet
	// query that is not `width < Npx` and a variant that is not `@max-[Npx]/pane:`
	// fail the same way, because they are the same mistake seen from two files.
	const illegal = queries.filter((query) => query.value === undefined).map((query) => `${query.source}: ${query.text}`);
	expect(illegal).toEqual([]);
});
