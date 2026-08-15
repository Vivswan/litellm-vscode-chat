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
 * What the third test enforces is therefore not "one spelling" but ONE PAIR:
 * `width < N` and `width >= N`, which partition at N - every pane width belongs
 * to exactly one of them, so no width can wear half of each layout. A tier that
 * starts at a width (the models list's columnar form) needs the second, and it
 * is safe for the same reason the first is.
 *
 * Everything else is reported, for one of two reasons. `max-width: N` and
 * `620px >= width` and `max-inline-size: N` are `<= N`, so they OVERLAP the
 * `>= N` side at exactly N: that is the bug itself. `min-width: N` overlaps
 * nothing - it is exactly `width >= N` - and is reported for the other reason,
 * that a second way to write a form already spelled is how two rules at one
 * number stop looking like two rules at one number.
 *
 * The two halves are strict in different ways, which is worth knowing before
 * reading a failure. The stylesheet half judges only queries that constrain the
 * PANE's width, so a differently named container and a `style()` query pass
 * untouched, and it judges the prelude WHOLE - neither legal form has a compound
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

/** Is `.rail` one of this selector list's own parts, rather than the tail of a descendant? */
function selectsRailItself(selectorList: string): boolean {
	return selectorList.split(",").some((part) => part.trim() === ".rail");
}

/**
 * The window width the rail collapses at, read from the media block that
 * actually contains the rail's own rule.
 *
 * Brace-matched rather than pattern-anchored, because the anchor this replaces
 * could not tell membership from adjacency: `@media (...) \{[^@]*?\.rail \{`
 * lets the gap run straight through a closing brace, so a decoy width query
 * with no at-rule between it and the next `.rail \{` captured the decoy's
 * number - and both readers of this number believed it. One above the rail's
 * top-level rule put 235 in the band's floor where 735 belongs.
 *
 * The walk answers the question in the form it is actually asked. A rule counts
 * only when it opens at depth 1 of the block, so a rule NESTED in another one
 * (`.decoy { .rail { } }`, which means `.decoy .rail`) is not the rail's own,
 * and only when `.rail` is a whole member of its selector list, so `.decoy
 * .rail` is not either - on one line or broken across two, which a pattern over
 * text cannot tell apart but a walk over structure never has to.
 *
 * Comments come out first, for the reason paneQueries strips them too: a brace
 * or a selector inside prose is text, and counting it as structure is the same
 * membership-for-text mistake one level down. What is left is CSS's own brace
 * grammar, not a tokenizer - a brace inside a quoted value would still count,
 * and neither stylesheet has one.
 *
 * One reader would be enough to matter; there are two, and they used to spell
 * the pattern separately. Now they cannot disagree.
 */
function railCollapseWidth(): number {
	const css = stylesheet().replace(/\/\*.*?\*\//gs, "");
	for (const match of css.matchAll(/@media \(width < (\d+)px\) \{/g)) {
		const open = match.index + match[0].length - 1;
		let depth = 0;
		let selectorStart = open + 1;
		for (let index = open; index < css.length; index++) {
			const char = css[index];
			if (char === "{") {
				depth += 1;
				if (depth === 2 && selectsRailItself(css.slice(selectorStart, index))) {
					return Number(match[1]);
				}
				selectorStart = index + 1;
			} else if (char === "}") {
				depth -= 1;
				selectorStart = index + 1;
				if (depth === 0) {
					break;
				}
			} else if (char === ";") {
				selectorStart = index + 1;
			}
		}
	}
	throw new Error("could not read the rail's collapse width from dashboard.css");
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
	// Anchored to the block it belongs to. Unanchored, this takes the FIRST
	// padding pair in the file, which would quietly re-point the arithmetic at
	// someone else's rule.
	const panePadding = declared(
		/\.pane \{[^}]*padding: \d+px (\d+)px[^}]*container-name: pane/s,
		"the pane's horizontal padding"
	);
	const collapseAt = railCollapseWidth();
	// One border on the rail's trailing edge, at both widths.
	const border = 1;
	return {
		low: collapseAt - (railWidth + border) - panePadding * 2,
		high: collapseAt - (collapsedWidth + border) - panePadding * 2,
	};
}

/**
 * The pair a pane width query may be spelled as, and the pair a component may
 * use. `<` and `>=` at the same number partition; anything else is reported.
 */
const LEGAL_CSS_QUERY = /^@container pane \(width (?:<|>=) (\d+)px\)$/;
const LEGAL_VARIANT = /^@(?:max|min)-\[(\d+)px\]\/pane:$/;

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
 * and each is judged against the legal pair afterwards.
 *
 * It is regexes over source, not a parser over the bundle, so it does not see
 * CSS built by a template literal or a container variant minted by a `@variant`
 * directive. There are none of either; the floors below are what turn a matcher
 * that stopped matching into a failure rather than a silence.
 */
function paneQueries(): PaneQuery[] {
	const found: PaneQuery[] = [];
	for (const { file, css } of stylesheetSources()) {
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

/**
 * Every stylesheet under the webview tree, comments stripped, with its path.
 *
 * Not just styles/: both live there today, and a component-local sheet
 * somewhere else is exactly the file nobody would think to scan. Comments go
 * because the prose ABOUT a rule otherwise reads as a rule - the note above the
 * 700px block spells the legal form to explain itself. CSS's comment grammar,
 * not a tokenizer: an unterminated comment opener inside a quoted value would
 * swallow the rules after it, which only the stylesheet floor below could
 * notice, and only if it ate enough of them.
 */
function stylesheetSources(): { readonly file: string; readonly css: string }[] {
	const sheets: { file: string; css: string }[] = [];
	for (const file of readdirSync(WEBVIEW_TREE, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".css")) {
			continue;
		}
		sheets.push({ file, css: readFileSync(join(WEBVIEW_TREE, file), "utf8").replace(/\/\*.*?\*\//gs, "") });
	}
	return sheets;
}

/** Split on any of `separators`, but only at paren depth zero: `:is(a, b)` is one token. */
function splitTopLevel(text: string, separators: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of text) {
		if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth = Math.max(0, depth - 1);
		}
		if (depth === 0 && separators.includes(char)) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.filter((part) => part.trim() !== "");
}

/** The root box, wherever it is named: `html`, `:root`, or either inside `:is()`/`:where()`. */
const ROOT_SUBJECT = /(?:^|[^\w-])(?:html|:root)\b/i;

/** The root box unnamed: a universal selector matches every element, and html is one. */
const UNIVERSAL_SUBJECT = /^(?:\*|:is\(\*\)|:where\(\*\))$/i;

/**
 * What one selector in a list points AT - its subject, which is its last
 * compound, not everything it mentions. `html[data-theme] body` names html and
 * styles body.
 *
 * A bare `*` is the root too, and only a bare one: `*` matches html, while
 * `.x *` cannot, since the root has no ancestor to sit under. So the universal
 * case asks the whole selector rather than its subject alone. `*::before` is
 * not the root either - it is a box the root grows, not the root - which is why
 * the pattern is exact rather than a prefix.
 *
 * "parent" is the nesting answer: `&[data-theme]` styles whatever `&` resolves
 * to, so the question moves outward a level. Contains rather than starts with,
 * because `:is(&)` and `&.x` are the same question in different clothes. `&
 * body` is not - its subject is body whatever the parent was.
 */
function subjectKind(part: string): "root" | "parent" | "other" {
	const compounds = splitTopLevel(part, " \t\n\r>+~");
	const subject = compounds.at(-1)?.trim() ?? "";
	if (ROOT_SUBJECT.test(subject)) {
		return "root";
	}
	if (compounds.length === 1 && UNIVERSAL_SUBJECT.test(subject)) {
		return "root";
	}
	return subject.includes("&") ? "parent" : "other";
}

/**
 * Does a rule nested this deep style the root box?
 *
 * Walks the prelude stack outward, since a `&`-rooted selector answers with its
 * parent's subject. At-rule preludes are transparent: `@media`, `@layer` and
 * `@container` wrap rules without changing what they select.
 */
function selectsRoot(stack: readonly string[]): boolean {
	for (let index = stack.length - 1; index >= 0; index -= 1) {
		const prelude = stack[index] ?? "";
		if (prelude.startsWith("@")) {
			continue;
		}
		const kinds = splitTopLevel(prelude, ",").map(subjectKind);
		if (kinds.includes("root")) {
			return true;
		}
		if (!kinds.includes("parent")) {
			return false;
		}
	}
	return false;
}

/** `font-size`, and the `font` shorthand that sets it too. Not `font-family`, not `--font-size`. */
const FONT_SIZE_DECLARATION = /^\s*font(?:-size)?\s*:/i;

/**
 * Every rule setting a font size on the ROOT box - the one `rem` resolves
 * against, and so the one that decides what this page's rem sizes are worth
 * against its px thresholds.
 *
 * A brace walk rather than a regex per rule, because CSS nesting hides the
 * answer from any regex that reads one block at a time: theme.css already nests
 * with `&`, and `html { &[data-theme="dark"] { font-size } }` styles html while
 * its own prelude says only `&[data-theme="dark"]`. The walk keeps the prelude
 * stack, so the nested rule is judged by what its `&` resolves to.
 *
 * It is still a walk over source rather than a parse: it assumes braces and
 * semicolons outside strings mean what they say (string literals are blanked
 * first, so a brace inside `content` cannot desync it), and it does not see CSS
 * built by a template literal. There is none.
 */
function rootFontSizeDeclarations(): string[] {
	const found: string[] = [];
	for (const { file, css } of stylesheetSources()) {
		const stack: string[] = [];
		let buffer = "";
		// Strings blanked, not removed: an attribute value reading "html" is not a
		// selector on html, and a brace inside one is not a block.
		for (const char of css.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')) {
			if (char === "{") {
				stack.push(buffer.trim());
				buffer = "";
			} else if (char === "}" || char === ";") {
				// Checked before the pop: a block's last declaration may drop its
				// semicolon, and the stack top is still the rule it belongs to.
				if (FONT_SIZE_DECLARATION.test(buffer) && selectsRoot(stack)) {
					found.push(`${file}: ${stack.join(" > ")} { ${buffer.trim()} }`);
				}
				if (char === "}") {
					stack.pop();
				}
				buffer = "";
			} else {
				buffer += char;
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
	const inCss = railCollapseWidth();
	expect(RAIL_COLLAPSE_QUERY).toBe(`(width < ${inCss}px)`);
	// And the utilities that give the collapsed rail its geometry.
	const railSource = readFileSync(join(WEBVIEW, "rail.tsx"), "utf8");
	for (const match of railSource.matchAll(/max-\[(\d+)px\]:/g)) {
		expect(Number(match[1])).toBe(inCss);
	}
});

test("every pane query is spelled one of the two legal ways", () => {
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
	// query outside the pair `width < Npx` / `width >= Npx`, and a variant
	// outside `@max-[Npx]/pane:` / `@min-[Npx]/pane:`, fail the same way,
	// because they are the same mistake seen from two files.
	const illegal = queries.filter((query) => query.value === undefined).map((query) => `${query.source}: ${query.text}`);
	expect(illegal).toEqual([]);
});

test("the settings rows' fixed tracks leave the description a working column at the stack threshold", () => {
	// The Settings page runs full-bleed on a four-track row - label, control,
	// description, actions - and stacks on a pane query. The description is
	// the one elastic track, so the middle state to guard against is a pane
	// just above the threshold where the fixed tracks and gaps eat almost all
	// of it and the description prints a word per line. That is arithmetic:
	// fixed rem tracks plus the three 1rem gaps, against the px threshold.
	// Both numbers are class strings no runtime assertion can see, so this
	// reads them out of the source the way the spelling test does.
	const source = readFileSync(join(WEBVIEW, "settings.tsx"), "utf8");
	// Anchored to the constant's DECLARATION rather than to the first grid in
	// the file, the same first-match hazard the rail arithmetic documents. The
	// tail pins the stacked template too, so a redesign of either tier moves
	// this test with it deliberately.
	const grid =
		/SETTING_ROW_GRID =\s*"grid grid-cols-\[(\d+(?:\.\d+)?)rem_minmax\(0,(\d+(?:\.\d+)?)rem\)_minmax\(0,1fr\)_(\d+(?:\.\d+)?)rem\] gap-x-4[\s\S]{0,80}?@max-\[(\d+)px\]\/pane:grid-cols-\[auto_minmax\(0,1fr\)\]/.exec(
			source
		);
	if (grid?.[1] === undefined || grid[2] === undefined || grid[3] === undefined || grid[4] === undefined) {
		throw new Error("could not read the settings row tracks and stack threshold from SETTING_ROW_GRID in settings.tsx");
	}
	// The rem resolves against the ROOT font size, and the 16 below is the CSS
	// default. That is a fact about the stylesheets rather than a constant, so
	// it is checked: the tracks are rem and the threshold px, and a root font
	// size other than the default moves one side of the comparison.
	expect(rootFontSizeDeclarations()).toEqual([]);
	const gaps = 3;
	const fixed = (Number(grid[1]) + Number(grid[2]) + Number(grid[3]) + gaps) * 16;
	const threshold = Number(grid[4]);
	// 240px is about 34 characters of 0.95em prose: a real column, not a sliver.
	expect(threshold - fixed).toBeGreaterThanOrEqual(240);
});
