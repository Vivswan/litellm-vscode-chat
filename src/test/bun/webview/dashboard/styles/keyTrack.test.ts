import { expect, test } from "bun:test";
import { compileDashboard, rulesFor } from "./compileStyles";

/**
 * The record field grid's no-reflow-while-typing property, as a stylesheet fact: the key
 * track carries no content-sized function (fit-content, min-content, max-content, auto)
 * and no JS-fed custom property, so typing a key can never re-solve the tracks and shove
 * the value column sideways. The record-overlay-key-typing geometry pair proves the
 * property in a real layout; this pin keeps the template itself content-independent.
 */
test("the record grids' key track is a fixed range, never content-sized", async () => {
	const css = await compileDashboard();
	for (const selector of [".rows", ".row"]) {
		const rules = rulesFor(css, selector).filter((rule) => rule.declarations.includes("grid-template-columns"));
		expect(rules.length, `${selector} declares its template`).toBeGreaterThan(0);
		for (const rule of rules) {
			const template = /grid-template-columns:\s*([^;}]*)/.exec(rule.declarations)?.[1]?.trim() ?? "";
			expect(template, `${selector} first track is a fixed ch range`).toMatch(/^minmax\(\d+ch,\s*\d+ch\)/);
			// The remaining tracks may hug content (flags, actions); only the two
			// INPUT tracks decide whether typing reflows, and the value track is
			// a floor-plus-fr, also content-independent.
			expect(template).toMatch(/minmax\(10em,\s*1fr\)/);
			expect(template).not.toContain("fit-content");
			expect(template).not.toContain("var(--key-track");
		}
	}
});
