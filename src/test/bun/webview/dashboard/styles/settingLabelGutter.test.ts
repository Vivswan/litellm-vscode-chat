import { expect, test } from "bun:test";
import { compileDashboard, rulesFor } from "./compileStyles";

/**
 * The Features and Settings pages share ONE label gutter, as a stylesheet fact. Both render the same row anatomy onto
 * .settings-groups, but they live on separate panes, so a content-sized gutter measured each page's own longest title
 * and put their control edges ~20px apart - the whole form slid sideways on every tab switch.
 *
 *   The gutter is a fixed token instead, read by the track list and the label cell alike
 *     -> makes the drift unrepresentable rather than merely absent today
 */

/** The content-sized track functions: any of these in the gutter re-opens the drift. */
const CONTENT_SIZED = ["max-content", "min-content", "fit-content", "auto"];

test("the settings label gutter is a fixed token, never a content-sized track", async () => {
	const css = await compileDashboard();
	const rules = rulesFor(css, ".settings-groups").filter((rule) => rule.declarations.includes("grid-template-columns"));
	expect(rules.length, ".settings-groups declares the shared template").toBe(1);
	const template = /grid-template-columns:\s*([^;}]*)/.exec(rules[0]?.declarations ?? "")?.[1]?.trim() ?? "";
	const gutter = template.split(" ")[0] ?? "";
	expect(gutter, "the gutter track reads the shared token").toBe("var(--setting-label-gutter)");
	for (const sizing of CONTENT_SIZED) {
		expect(gutter, `the gutter must not be ${sizing}-sized`).not.toContain(sizing);
	}
	// Declared, and as a length: a token that resolved to a content function would satisfy the spelling above while
	// sizing to content anyway.
	const declaring = rulesFor(css, ".settings-groups").filter((rule) =>
		rule.declarations.includes("--setting-label-gutter:")
	);
	expect(declaring.length, "the token is declared on the track owner").toBe(1);
	const value = /--setting-label-gutter:\s*([^;}]*)/.exec(declaring[0]?.declarations ?? "")?.[1]?.trim() ?? "";
	expect(value).toMatch(/^\d+(?:\.\d+)?rem$/);
	// The label cell's own bound reads the same token, so the two can never name different widths for one gutter.
	const title = rulesFor(css, ".setting-title").filter((rule) => rule.declarations.includes("max-width"));
	expect(title.length, ".setting-title bounds itself").toBe(1);
	expect(title[0]?.declarations).toContain("max-width: var(--setting-label-gutter)");
});
