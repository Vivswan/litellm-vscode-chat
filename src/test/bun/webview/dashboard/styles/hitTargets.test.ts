import { expect, test } from "bun:test";
import { compileDashboard, rulesFor } from "./compileStyles";

/**
 * The 24px pointer target the page's glyph-sized controls wear (WCAG 2.5.8),
 * as a stylesheet fact. The rule must grow the HIT AREA and
 * nothing else: an out-of-flow pseudo-element, so the "?" ring stays 14px and
 * the line box it sits in keeps its height. A padding or size declaration on
 * the class itself is the regression - it would pass a "target is 24px" check
 * while enlarging every glyph and every line they sit on.
 */

const MINIMUM_PX = 24;

test("the shared hit-target rule expands only an out-of-flow pseudo-element", async () => {
	const css = await compileDashboard();
	const host = rulesFor(css, ".hit-24");
	expect(host.length, ".hit-24 declares its own rule").toBe(1);
	// A containing block is all the host may contribute; anything sizing the
	// control itself defeats the point of the pseudo.
	expect(host[0]?.declarations).toContain("position: relative");
	for (const sizing of ["padding", "width", "height", "min-width", "min-height", "inset"]) {
		expect(host[0]?.declarations, `.hit-24 must not size the control (${sizing})`).not.toContain(`${sizing}:`);
	}

	// The single-colon spelling: Bun's CSS printer normalizes `::after` down to
	// the legacy form, and the pin reads what SHIPS.
	const expander = rulesFor(css, ".hit-24:after");
	expect(expander.length, ".hit-24::after carries the expansion").toBe(1);
	const declarations = expander[0]?.declarations ?? "";
	expect(declarations).toContain("position: absolute");
	// Never smaller than the control it covers, and at least the minimum in
	// both axes - so one rule fits a 14px circle and a wider icon button alike.
	expect(declarations).toContain(`min-width: ${MINIMUM_PX}px`);
	expect(declarations).toContain(`min-height: ${MINIMUM_PX}px`);
	expect(declarations).toContain("width: 100%");
	expect(declarations).toContain("height: 100%");
});
