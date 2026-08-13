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
 * One hazard it deliberately does NOT check, because the check could not tell a
 * real instance from a coincidence: Tailwind compiles `@max-[Npx]/pane:` to
 * `width < N` while `@container pane (max-width: N)` is `<= N`, so a rule and
 * the utility it PAIRS with disagree at exactly N - a one-pixel band where a row
 * takes half of each layout. Every pair here is spelled exclusively on both
 * sides for that reason. One number (620) is also spelled inclusively
 * elsewhere in the sheet for an unrelated surface (the model row's limits
 * drop), which is harmless - a models rule and a usage utility never meet -
 * and is why this is a rule for authors rather than an assertion.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RAIL_COLLAPSE_QUERY } from "../../../../webview/dashboard/rail";

const ROOT = join(import.meta.dir, "../../../../..");
const STYLESHEET = join(ROOT, "src/webview/dashboard/styles/dashboard.css");
const WEBVIEW = join(ROOT, "src/webview/dashboard");

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

/** Every pane threshold, wherever it is spelled. */
function paneThresholds(): { readonly value: number; readonly source: string; readonly inclusive: boolean }[] {
	const found: { value: number; source: string; inclusive: boolean }[] = [];
	// Four spellings, not two: `width <= N` is what the bundler emits for
	// `max-width`, so it is the form an author copying from dist would write,
	// and an unnamed `@container` is a pane query too - the pane is the nearest
	// container every one of these rules has.
	for (const match of stylesheet().matchAll(
		/@container (?:pane )?\((?:(max-width): (\d+)px|(width <=) (\d+)px|width < (\d+)px)\)/g
	)) {
		const inclusive = match[1] !== undefined || match[3] !== undefined;
		const value = Number(match[2] ?? match[4] ?? match[5]);
		found.push({ value, source: "dashboard.css", inclusive });
	}
	// The components' own halves: a row's track template has to sit with the
	// component, because a utility always beats the stylesheet. Read the tree
	// rather than a list of files - a list is a list of the files somebody
	// remembered, and the overlays (the inspector, the record editors) sit
	// inside the pane too, so their container queries are pane queries.
	for (const file of readdirSync(WEBVIEW, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".tsx") && !file.endsWith(".ts")) {
			continue;
		}
		const source = readFileSync(join(WEBVIEW, file), "utf8");
		for (const match of source.matchAll(/@max-\[(\d+)px\]\/pane:/g)) {
			found.push({ value: Number(match[1]), source: file, inclusive: false });
		}
	}
	return found;
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
	// `>= band.low` for an inclusive spelling: the band's floor is a width that
	// occurs in BOTH regimes, so `max-width: <floor>` fires on one side of the
	// collapse and not the other, while `width < <floor>` does not.
	const inside = paneThresholds().filter((threshold) =>
		threshold.inclusive
			? threshold.value >= band.low && threshold.value < band.high
			: threshold.value > band.low && threshold.value < band.high
	);
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
