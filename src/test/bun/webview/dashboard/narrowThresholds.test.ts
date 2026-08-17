/**
 * The narrow system's own arithmetic, checked against the stylesheet rather than a memory of it. Two hazards,
 * neither of which any suite can observe (happy-dom has no layout), both of which are arithmetic:
 *
 * The rail collapses on a WINDOW query while every other threshold asks the PANE, so the pane's width is
 * DISCONTINUOUS at the collapse and every width in that band happens twice - a breakpoint inside it fires in
 * REVERSE as the window widens, folding the page as the reader drags a splitter rightward.
 *
 * Spelling: Tailwind compiles `@max-[Npx]/pane:` to `width < N` while `@container pane (max-width: N)` is
 * `<= N`, so a rule and the utility it PAIRS with disagree at exactly N. The third test therefore enforces
 * ONE PAIR - `width < N` and `width >= N`, which partition at N - and reports every other spelling.
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
 * The trees a class string can live in, READ from theme.css's `@source` lines rather than copied here: a scan
 * narrower than the compiler's is a scan with a blind spot, and a third `@source` would open one silently.
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
 * The window width the rail collapses at, from the media block that actually contains the rail's own rule.
 * Brace-matched rather than pattern-anchored: the anchored regex could not tell membership from adjacency and
 * captured a decoy query's number, putting 235 in the band's floor where 735 belongs. A rule counts only when
 * it opens at depth 1 and `.rail` is a whole member of its selector list; comments come out first.
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
 * The band of PANE widths that occur on both sides of the rail's collapse. Every input is read from the
 * stylesheet, because the band moves whenever any of them does - a change to the pane's padding alone moves
 * the band's top by 8px, enough to swallow a threshold that was clear of it.
 */
function reversalBand(): { readonly low: number; readonly high: number } {
	const railWidth = declared(/\.rail \{[^}]*flex: 0 0 (\d+)px/s, "the rail's width");
	const collapsedWidth = declared(/\.rail \{\s*flex: 0 0 (\d+)px;\s*\}/s, "the collapsed rail's width");
	// Anchored to the block it belongs to: unanchored, this takes the FIRST padding pair in the file.
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
 * Does this prelude constrain the PANE's width, which is the only thing the one-pixel argument is about?
 * Scoped rather than blanket: a container that is not the pane is a different box on a different axis, and a
 * query with no size in it cannot disagree at a pixel.
 */
function constrainsPaneWidth(text: string): boolean {
	// A style query is stripped rather than skipped: `((max-width: 620px) and style(...))` does BOTH, and
	// skipping the whole prelude on sight of `style(` waved it through. Stripping decides SCOPE only.
	const size = text.replace(/style\([^)]*\)/gi, "");
	// `inline-size` as well as `width`: the pane is an `inline-size` container, so that is the feature's other
	// name, and `max-inline-size: 620px` is the same inclusive mistake wearing it.
	if (!/\b(?:width|inline-size)\b/i.test(size)) {
		return false;
	}
	// An UNNAMED query is in scope: the pane is the only container this app declares, so `@container (width <
	// N)` asks the pane whether it says so or not. `not`, `and`, `or` and `none` are excluded from
	// <container-name> by the spec, so a prelude starting with one of them is unnamed, not a container.
	const named = /^@container\s+([a-zA-Z_-][\w-]*)/i.exec(text);
	const name = named?.[1]?.toLowerCase();
	return name === undefined || name === "pane" || name === "not" || name === "and" || name === "or" || name === "none";
}

/**
 * Every pane width query in the webview, legal or not. Both halves match BROADLY and judge afterwards: a
 * matcher recognizing only the spellings someone thought of would report a sheet full of `max-width` as a
 * sheet with no thresholds, and every assertion below passes over an empty list - hence the floors.
 * Regexes over source, not a parser: CSS built by a template literal or a variant minted by `@variant`
 * is invisible here (there are none of either).
 */
function paneQueries(): PaneQuery[] {
	const found: PaneQuery[] = [];
	for (const { file, css } of stylesheetSources()) {
		// Case-insensitive because CSS at-rules are, so `@CONTAINER` is caught and reported rather than passing
		// as a second way to write the same rule.
		for (const match of css.matchAll(/@container[^{]*/gi)) {
			const text = match[0].trim();
			if (!constrainsPaneWidth(text)) {
				continue;
			}
			const legal = LEGAL_CSS_QUERY.exec(text);
			found.push({ value: legal === null ? undefined : Number(legal[1]), source: file, side: "stylesheet", text });
		}
	}
	// The components' own halves: a row's track template sits with the component because a utility always beats
	// the stylesheet. Read the trees TAILWIND reads, named in theme.css's `@source` lines.
	for (const root of classRoots()) {
		for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".tsx") && !file.endsWith(".ts")) {
				continue;
			}
			const source = readFileSync(join(root, file), "utf8");
			// Every container variant, named or not: an `@` run up to its colon. Unnamed counts because
			// `@max-[620px]:` compiles to an unnamed query, which lands on the pane anyway. Stopping at the colon
			// keeps a second variant on the same class from being swallowed whole.
			for (const match of source.matchAll(/@[^\s"'`{}:]+:/g)) {
				const text = match[0];
				// Tailwind's arbitrary at-rule variants put their `@` directly after a `[` and are not container
				// variants at all - except the one whose at-rule IS `@container`, a pane query wearing a bracket.
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
 * Every stylesheet under the webview tree, comments stripped, with its path. Not just styles/: a
 * component-local sheet elsewhere is exactly the file nobody would think to scan. Comments go because the
 * prose ABOUT a rule otherwise reads as a rule - the note above the 700px block spells the legal form.
 * CSS's comment grammar, not a tokenizer: an unterminated /* inside a quoted value would swallow the
 * rules after it.
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
 * What one selector points AT - its subject, its last compound, not everything it mentions. A bare `*` is the
 * root and only a bare one (`.x *` cannot match html), so that case asks the whole selector; the pattern is
 * exact-anchored, never a prefix, so `*::before` (a box the root grows, not the root) stays out. "parent" is
 * the nesting answer: `&[data-theme]` styles whatever `&` resolves to, while `& body` has body as its
 * subject - contains rather than starts-with, because `:is(&)` and `&.x` are the same question.
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
 * Does a rule nested this deep style the root box? Walks the prelude stack outward, since a `&`-rooted
 * selector answers with its parent's subject. At-rule preludes are transparent.
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
 * Every rule setting a font size on the ROOT box - the one `rem` resolves against, so the one that decides
 * what this page's rem sizes are worth against its px thresholds. A brace walk rather than a regex per rule:
 * CSS nesting hides the answer, since `html { &[data-theme="dark"] { font-size } }` styles html while its own
 * prelude says only `&[data-theme="dark"]`. String literals are blanked first so `content` cannot desync it.
 */
function rootFontSizeDeclarations(): string[] {
	const found: string[] = [];
	for (const { file, css } of stylesheetSources()) {
		const stack: string[] = [];
		let buffer = "";
		// Strings blanked, not removed: an attribute value reading "html" is not a selector on html.
		for (const char of css.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')) {
			if (char === "{") {
				stack.push(buffer.trim());
				buffer = "";
			} else if (char === "}" || char === ";") {
				// Checked before the pop: a block's last declaration may drop its semicolon.
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
	// Sanity on the EDGES, not the width: the width is the rail's two sizes subtracted from each other, so the
	// padding and the collapse width cancel and a misread of either would pass a width check untouched.
	expect(band.low).toBeGreaterThan(400);
	expect(band.low).toBeLessThan(band.high);
	expect(band.high).toBeLessThan(1400);
	expect(band.high - band.low).toBeGreaterThan(100);
	// This test reads only the legally spelled queries; the spelling test below is what keeps that set complete.
	const inside = paneThresholds().filter((threshold) => threshold.value > band.low && threshold.value < band.high);
	expect(inside.map((threshold) => `${threshold.value} (${threshold.source})`)).toEqual([]);
});

test("the rail's collapse width is the same number in its stylesheet and in its component", () => {
	// CSS decides what the rail looks like; the component decides what it can do. Neither can read the other.
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
	// A floor before the judgement, because every assertion here is "this derived list is empty" and an empty
	// INPUT satisfies all of them. One floor per side: the component half is four times the size of the
	// stylesheet half, so a single number big enough for the components could hide eight vanished CSS queries.
	expect(queries.filter((query) => query.side === "stylesheet").length).toBeGreaterThan(4);
	expect(queries.filter((query) => query.side === "component").length).toBeGreaterThan(12);
	// Both sides of the pane's one-pixel argument in one list: a stylesheet query outside `width < Npx` /
	// `width >= Npx` and a variant outside `@max-[Npx]/pane:` / `@min-[Npx]/pane:` are the same mistake.
	const illegal = queries.filter((query) => query.value === undefined).map((query) => `${query.source}: ${query.text}`);
	expect(illegal).toEqual([]);
});

test("the settings rows' shared tracks leave the description a working column at the stack threshold", () => {
	// The Settings page runs full-bleed on four shared tracks - label, control, description, actions - and
	// stacks on a pane query. The description is the one elastic track, so the state to guard is a pane just
	// above the threshold where the label cap, the fixed tracks, and the gaps leave it a word per line. The
	// geometry lives in dashboard.css (the .settings-groups block), so this reads it out of the stylesheet.
	const css = stylesheet();
	// Anchored to the wide-tier block: the tracks, the label cap, and the gap all live inside the ONE
	// `@container pane (width >= N px)` block that owns the settings grid, so the threshold cannot be spelled
	// twice and drift - membership in the block is checked by brace depth below.
	const wide =
		/@container pane \(width >= (\d+)px\) \{\s*\.settings-groups \{\s*display: grid;\s*grid-template-columns: minmax\((\d+(?:\.\d+)?)rem, max-content\) minmax\(0, (\d+(?:\.\d+)?)rem\) minmax\(0, 1fr\) (\d+(?:\.\d+)?)rem;\s*column-gap: (\d+)px;/.exec(
			css
		);
	if (
		wide?.[1] === undefined ||
		wide[2] === undefined ||
		wide[3] === undefined ||
		wide[4] === undefined ||
		wide[5] === undefined
	) {
		throw new Error("could not read the shared settings tracks from dashboard.css's .settings-groups block");
	}
	const threshold = Number(wide[1]);
	// The label cap sits in the SAME wide block (brace-balanced slice), so it flips at the same width the
	// tracks do; the two-column stacked band opens at the same threshold's other side.
	const blockStart = css.indexOf(wide[0]);
	let depth = 0;
	let blockEnd = blockStart;
	for (let index = css.indexOf("{", blockStart); index < css.length; index++) {
		if (css[index] === "{") {
			depth += 1;
		} else if (css[index] === "}") {
			depth -= 1;
			if (depth === 0) {
				blockEnd = index;
				break;
			}
		}
	}
	const wideBlock = css.slice(blockStart, blockEnd);
	const cap = /\.setting-title \{\s*max-width: (\d+(?:\.\d+)?)rem;/.exec(wideBlock);
	if (cap?.[1] === undefined) {
		throw new Error("could not read the label cap from the settings wide-tier block in dashboard.css");
	}
	expect(wideBlock).toContain("grid-template-columns: subgrid");
	// The stacked band opens where the wide tier closes: the `< threshold` block
	// (brace-balanced, like the wide one - an unbounded scan would be satisfied
	// by an "auto 1fr" template anywhere later in the file) carries the
	// two-column template, so the label column and the rows turn at one width.
	const stackedOpen = css.indexOf(`@container pane (width < ${threshold}px) {`, blockEnd);
	expect(stackedOpen, `no stacked band opens at ${threshold}`).toBeGreaterThan(-1);
	let stackedDepth = 0;
	let stackedEnd = stackedOpen;
	for (let index = css.indexOf("{", stackedOpen); index < css.length; index++) {
		if (css[index] === "{") {
			stackedDepth += 1;
		} else if (css[index] === "}") {
			stackedDepth -= 1;
			if (stackedDepth === 0) {
				stackedEnd = index;
				break;
			}
		}
	}
	expect(css.slice(stackedOpen, stackedEnd)).toContain("grid-template-columns: auto 1fr");
	// The cap is the growth limit over the floor, not under it.
	expect(Number(cap[1])).toBeGreaterThanOrEqual(Number(wide[2]));
	// The tracks are rem and the threshold px, so a root font size other than the CSS default of 16 would move
	// one side of the comparison. That is a fact about the stylesheets rather than a constant, so it is checked.
	expect(rootFontSizeDeclarations()).toEqual([]);
	const gaps = 3;
	const fixed = (Number(cap[1]) + Number(wide[3]) + Number(wide[4])) * 16 + Number(wide[5]) * gaps;
	// 240px is about 34 characters of 0.95em prose: a real column, not a sliver.
	expect(threshold - fixed).toBeGreaterThanOrEqual(240);
});
