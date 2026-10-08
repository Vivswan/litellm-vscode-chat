/**
 * Layout arithmetic, checked against the stylesheet because happy-dom has no layout to observe it in. The rail
 * collapses on a WINDOW query while every other threshold asks the PANE, so every pane width in the collapse band
 * happens twice and a breakpoint inside it fires in reverse as the window widens. Tailwind's `@max-[Npx]/pane:` is
 * `width < N` where `(max-width: N)` is `<= N`, so a rule and the utility it pairs with can disagree at exactly N.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Rule, type Selector, type SelectorComponent, transform } from "lightningcss";
import { RAIL_COLLAPSE_QUERY } from "../../../../webview/dashboard/rail";
import { REPO_ROOT } from "../../../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "../../childProcessTimeout";
import { compileDashboard, compileTheme } from "./styles/compileStyles";

const STYLESHEET = join(REPO_ROOT, "src/webview/dashboard/styles/dashboard.css");
const WEBVIEW = join(REPO_ROOT, "src/webview/dashboard");
const WEBVIEW_TREE = join(REPO_ROOT, "src/webview");
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
 * `<=`, the rail's own spelling (its block in dashboard.css derives it): layout applies a `< N` block AT N under the
 * render harness while matchMedia reports false there, and `<=` is the spelling both evaluate the same way at every
 * integer. Brace-matched rather than pattern-anchored: the anchored regex could not tell membership from adjacency and
 * captured a decoy query's number, putting 235 in the band's floor where 735 belongs.
 */
function railCollapseWidth(): number {
	const css = stylesheet().replace(/\/\*.*?\*\//gs, "");
	for (const match of css.matchAll(/@media \(width <= (\d+)px\) \{/g)) {
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
 * Every input is read from the stylesheet, because the band moves whenever any of them does - a change to the pane's
 * padding alone moves the band's top by 8px, enough to swallow a threshold that was clear of it.
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

/** `<` and `>=` at the same number partition; anything else is reported. */
const LEGAL_CSS_QUERY = /^@container pane \(width (?:<|>=) (\d+)px\)$/;
const LEGAL_VARIANT = /^@(?:max|min)-\[(\d+)px\]\/pane:$/;

interface PaneQuery {
	readonly value: number | undefined;
	readonly source: string;
	/** Which harvest found it, so each can be floored against its own population. */
	readonly side: "stylesheet" | "component";
	/** What was actually written, for a failure message that can be acted on. */
	readonly text: string;
}

/**
 * Scoped rather than blanket: a container that is not the pane is a different box on a different axis, and a query
 * with no size in it cannot disagree at a pixel.
 */
function constrainsPaneWidth(text: string): boolean {
	// A style query is stripped rather than skipped: `((max-width: 620px) and style(...))` does BOTH, and skipping
	// the whole prelude on sight of `style(` waved it through.
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
 * Both halves match BROADLY and judge afterwards: a matcher recognizing only the spellings someone thought of would
 * report a sheet full of `max-width` as a sheet with no thresholds, and every assertion below passes over an empty
 * list - hence the floors. Regexes over source, not a parser: CSS built by a template literal or a variant minted by
 * `@variant` is invisible here (there are none of either).
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
	// The components' own halves: a row's track template sits with the component because a utility always beats the
	// stylesheet.
	for (const root of classRoots()) {
		for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
			if (!file.endsWith(".tsx") && !file.endsWith(".ts")) {
				continue;
			}
			const source = readFileSync(join(root, file), "utf8");
			// Unnamed counts because `@max-[620px]:` compiles to an unnamed query, which lands on the pane anyway.
			// Stopping at the colon keeps a second variant on the same class from being swallowed whole.
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
 * Not just styles/: a component-local sheet elsewhere is exactly the file nobody would think to scan. Comments go
 * because the prose ABOUT a rule otherwise reads as a rule - the note above the 700px block spells the legal form.
 *
 *   an unterminated /* inside a quoted value would swallow the rules after it -> CSS's comment grammar, not a tokenizer
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

type SubjectKind = "root" | "parent" | "other";

/**
 * What one selector points AT: its subject, the compound after the last combinator (`& body` styles body). `root`
 * names the root box (`html`, `:root`) or is the bare universal selector, which matches html too; `*::before` is a
 * box the root grows and `.x *` cannot match html. `parent` is whatever `&` resolves to, `:is(&)` and `&.x` alike.
 * Every selector list a pseudo-class nests is looked through, so `:not()` and `:has()` err toward root.
 */
function subjectKind(selector: Selector, lone = true): SubjectKind {
	const lastCombinator = selector.findLastIndex((component) => component.type === "combinator");
	const compound = selector.slice(lastCombinator + 1);
	const bare = lone && lastCombinator === -1 && compound.length === 1;
	if (compound.some((component) => component.type === "pseudo-element")) {
		return "other";
	}
	const kinds = compound.map((component): SubjectKind => {
		switch (component.type) {
			case "type":
				return component.name.toLowerCase() === "html" ? "root" : "other";
			case "universal":
				return bare ? "root" : "other";
			case "nesting":
				return "parent";
			case "pseudo-class":
				if (component.kind === "root") {
					return "root";
				}
				return strongest(nestedSelectors(component).map((inner) => subjectKind(inner, bare)));
			default:
				return "other";
		}
	});
	return strongest(kinds);
}

function nestedSelectors(component: Extract<SelectorComponent, { type: "pseudo-class" }>): readonly Selector[] {
	switch (component.kind) {
		case "is":
		case "where":
		case "not":
		case "any":
		case "has":
			return component.selectors;
		case "nth-child":
		case "nth-last-child":
			return component.of ?? [];
		default:
			return [];
	}
}

const strongest = (kinds: readonly SubjectKind[]): SubjectKind =>
	kinds.includes("root") ? "root" : kinds.includes("parent") ? "parent" : "other";

interface EnclosingRule {
	readonly selectors: Selector[];
	/** The compiled line that opened the rule, for the report. */
	readonly line: string;
}

/** A `&` subject defers to its parent's. */
function selectsRoot(stack: readonly EnclosingRule[]): boolean {
	for (const { selectors } of stack.toReversed()) {
		const kinds = selectors.map((selector) => subjectKind(selector));
		if (kinds.includes("root")) {
			return true;
		}
		if (!kinds.includes("parent")) {
			return false;
		}
	}
	return false;
}

const styleOf = (rule: Rule) =>
	rule.type === "style" ? rule.value : rule.type === "nesting" ? rule.value.style : undefined;

/**
 * Every rule setting a font size on the ROOT box - the one `rem` resolves against, so the one that decides what this
 * page's rem sizes are worth against its px thresholds. Read from the COMPILED sheets, which is what ships: the raw
 * Tailwind entry carries a `source(none)` import no CSS parser accepts. The parser enters a style rule, then its own
 * declarations, then its nested rules (declarations after one arrive as a rule of their own), so the rules entered
 * and not yet exited are the ones enclosing a declaration: `html { &[data-theme="dark"] { font-size } }` styles html
 * while its own selector says only `&[data-theme="dark"]`. The `font` shorthand sets the size too.
 */
async function rootFontSizeDeclarations(): Promise<string[]> {
	const found: string[] = [];
	const compiled = [
		{ file: "theme.css", css: await compileTheme() },
		{ file: "dashboard.css", css: await compileDashboard() },
	];
	for (const { file, css } of compiled) {
		const lines = css.split("\n");
		const enclosing: EnclosingRule[] = [];
		const report = (property: string) => (): undefined => {
			if (selectsRoot(enclosing)) {
				found.push(`${file}: ${property} under ${enclosing.map((rule) => rule.line).join(" > ")}`);
			}
		};
		transform({
			filename: file,
			code: Buffer.from(css),
			visitor: {
				Rule: (rule) => {
					const style = styleOf(rule);
					if (style !== undefined) {
						enclosing.push({ selectors: style.selectors, line: lines[style.loc.line]?.trim() ?? "" });
					}
				},
				RuleExit: (rule) => {
					if (styleOf(rule) !== undefined) {
						enclosing.pop();
					}
				},
				Declaration: { "font-size": report("font-size"), font: report("font") },
			},
		});
	}
	return found;
}

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
	expect(RAIL_COLLAPSE_QUERY).toBe(`(width <= ${inCss}px)`);
	// And the utilities that give the collapsed rail its geometry, which ride the same `<=` spelling as raw arbitrary
	// variants. Floored before judging, since every per-match assertion passes over an empty list.
	const railSource = readFileSync(join(WEBVIEW, "rail.tsx"), "utf8");
	const raw = [...railSource.matchAll(/\[@media\(width<=(\d+)px\)\]:/g)];
	expect(raw.length).toBeGreaterThan(0);
	for (const match of raw) {
		expect(Number(match[1])).toBe(inCss);
	}
	// max-[N] compiles to `< N` and may not return: it re-opens the boundary integer where the paint and the hook
	// disagreed.
	expect(railSource).not.toMatch(/max-\[\d+px\]:/);
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

test(
	"the settings rows' shared tracks leave the description a working column at the stack threshold",
	async () => {
		// The Settings page runs full-bleed on four shared tracks - label, control, description, actions - and stacks on a
		// pane query. The description is the one elastic track, so the state to guard is a pane just above the threshold
		// where the label cap, the fixed tracks, and the gaps leave it a word per line.
		const css = stylesheet();
		// The gutter is a fixed token both settings pages read, declared on the track owner; settingLabelGutter.test.ts
		// owns WHY it is fixed, this reads its width so the arithmetic below prices the real column.
		const gutter = /\.settings-groups \{\s*--setting-label-gutter: (\d+(?:\.\d+)?)rem;/.exec(css);
		if (gutter?.[1] === undefined) {
			throw new Error("could not read --setting-label-gutter from dashboard.css's .settings-groups block");
		}
		// Anchored to the wide-tier block: the tracks, the label cap, and the gap all live inside the ONE
		// `@container pane (width >= N px)` block that owns the settings grid, so the threshold cannot be spelled
		// twice and drift - membership in the block is checked by brace depth below.
		const wide = new RegExp(
			String.raw`@container pane \(width >= (\d+)px\) \{\s*\.settings-groups \{\s*display: grid;\s*` +
				String.raw`grid-template-columns: var\(--setting-label-gutter\) minmax\(0, (\d+(?:\.\d+)?)rem\) ` +
				String.raw`minmax\(0, 1fr\) (\d+(?:\.\d+)?)rem;\s*column-gap: (\d+)px;`
		).exec(css);
		if (wide?.[1] === undefined || wide[2] === undefined || wide[3] === undefined || wide[4] === undefined) {
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
		// The cell's own bound reads the SAME token as the track, so the gutter has one width rather than a track and a cap
		// that can disagree.
		expect(wideBlock).toContain("max-width: var(--setting-label-gutter)");
		expect(wideBlock).toContain("grid-template-columns: subgrid");
		// The stacked band opens where the wide tier closes: the `< threshold` block (brace-balanced, like the wide one -
		// an unbounded scan would be satisfied by an "auto 1fr" template anywhere later in the file) carries the two-column
		// template, so the label column and the rows turn at one width.
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
		// The tracks are rem and the threshold px, so a root font size other than the CSS default of 16 would move
		// one side of the comparison. That is a fact about the stylesheets rather than a constant, so it is checked.
		expect(await rootFontSizeDeclarations()).toEqual([]);
		const gaps = 3;
		const fixed = (Number(gutter[1]) + Number(wide[2]) + Number(wide[3])) * 16 + Number(wide[4]) * gaps;
		// 240px is about 34 characters of 0.95em prose: a real column, not a sliver.
		expect(threshold - fixed).toBeGreaterThanOrEqual(240);
	},
	CHILD_PROCESS_TIMEOUT_MS
);
