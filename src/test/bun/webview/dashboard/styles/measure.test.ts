import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { blocks, compileDashboard, rulesFor } from "./compileStyles";

/**
 * Structure runs FULL-BLEED, prose keeps its reading measure (the
 * visual-language charter's width rule under the widescreen ruling): the
 * diagnostics and servers pages used to cap their headers, lists, and the
 * resolution table at a shared 64rem surface measure, and a user review at a
 * ~2000px window read the ~500px of dead pane beside the resolution table as
 * a defect - "not covering the full space on the right side, same issue
 * settings had before". The ruling: structural surfaces (tables, lists,
 * rows) fill the pane at every window size, exactly like the settings page,
 * while the prose inside them keeps its own reading cap. These tests pin
 * both halves, so neither a resurrected surface cap nor a dropped reading
 * cap can land silently. happy-dom runs no cascade, so the sources and the
 * compiled stylesheet are the only places the contract is checkable.
 */

const dashboardDir = path.resolve(import.meta.dir, "../../../../../webview/dashboard");

function componentSource(file: string): string {
	return readFileSync(path.join(dashboardDir, file), "utf8");
}

/**
 * Whether one selector-list part styles the surface ELEMENT itself: the
 * class in the part's final compound. `.pane .resolved-scroll` and
 * `.table-scroll.resolved-scroll` cap the surface; `.notice p` caps a
 * descendant, which is exactly where the reading measures live.
 */
function targetsSurface(selectorPart: string, className: string): boolean {
	const compounds = selectorPart.trim().split(/[\s>+~]+/);
	return new RegExp(`\\.${className}(?![\\w-])`).test(compounds[compounds.length - 1] ?? "");
}

test("the Servers and Diagnostics pages wear no surface measure", () => {
	// The full-bleed ruling removed SERVERS_MEASURE and DIAGNOSTICS_MEASURE
	// outright: no header cap, no list cap, so header and body share the
	// pane's right edge the way the settings rows do. A `_MEASURE` constant
	// or a header cap reappearing in either file is the regression.
	for (const file of ["servers.tsx", "diagnostics.tsx"]) {
		const source = componentSource(file);
		expect(source, `${file} must not reintroduce a surface-measure constant`).not.toMatch(/_MEASURE\b/);
		expect(source, `${file} must not cap a section header`).not.toContain("headerClassName");
	}
	// The structural wrappers run bare of width utilities: any `max-w-`
	// beside these classes would be a cap the stylesheet scan below cannot
	// see. Exact spellings, so a second class sneaking in fails loudly.
	expect(componentSource("servers.tsx")).toContain(`<ul className="server-list">`);
	const diagnostics = componentSource("diagnostics.tsx");
	expect(diagnostics).toContain(`<ul className="config-diagnostics">`);
	expect(diagnostics).toContain(`<div className="table-scroll resolved-scroll">`);
	// Nothing on the diagnostics page carries a width utility at all.
	expect(diagnostics, "diagnostics.tsx must not cap a surface with a width utility").not.toContain("max-w-");
});

test("the compiled stylesheet leaves the structural surfaces uncapped", async () => {
	// The problem list, the resolution table's scrollport, the server list,
	// and the servers page's notice card: each fills the pane, so no rule
	// styling the surface element itself may declare a max-width - grouped
	// selector lists and qualified spellings (`.pane .resolved-scroll`)
	// included. The COMPILED sheet, so a commented-out declaration cannot
	// satisfy or trip the scan.
	const css = await compileDashboard();
	const surfaces = ["config-diagnostics", "resolved-scroll", "server-list", "notice"];
	for (const block of blocks(css)) {
		if (block.prelude.startsWith("@")) {
			continue; // At-rule wrappers; their inner rules are their own blocks.
		}
		for (const surface of surfaces) {
			if (block.prelude.split(",").some((part) => targetsSurface(part, surface))) {
				expect(block.body, `\`${block.prelude}\` must leave .${surface} full-bleed (no max-width)`).not.toContain(
					"max-width"
				);
			}
		}
	}
});

test("prose inside the full-bleed surfaces keeps its reading measure", async () => {
	// Full-bleed is a structure ruling, not a prose one: sentences still stop
	// where reading stops being comfortable (charter R7's 72ch hint measure,
	// the diagnostics' own 84ch).
	const css = await compileDashboard();
	const readingCaps: readonly (readonly [string, string])[] = [
		["p.hint", "72ch"],
		[".row-diagnostic-headline", "84ch"],
		[".row-diagnostic-detail", "84ch"],
		[".notice p", "84ch"],
	];
	for (const [selector, cap] of readingCaps) {
		const capped = rulesFor(css, selector).filter((rule) => rule.declarations.includes("max-width"));
		expect(capped.length, `${selector} must declare its reading measure`).toBeGreaterThan(0);
		for (const rule of capped) {
			expect(rule.declarations, `${selector} must keep the ${cap} reading measure`).toMatch(
				new RegExp(`max-width:\\s*${cap}`)
			);
		}
	}
});
