/**
 * The spinner's rest contract, pinned against the compiled dashboard sheet: a
 * spinner inside an aria-hidden subtree does not turn. `visibility: hidden`
 * stops paint but NOT animation in Chromium, so an always-mounted invisible
 * width twin (the Refresh button's busy label) would turn forever without the
 * stand-down rule. The DOM half is pinned by the servers suites; this suite
 * pins the CSS half, which those tests cannot see.
 */
import { expect, test } from "bun:test";
import { compileDashboard, rulesFor } from "./compileStyles";

const STAND_DOWN_SELECTOR = '[aria-hidden="true"] .spinner';

test("a spinner under an aria-hidden ancestor stands down, and the visible spinner still turns", async () => {
	const compiled = await compileDashboard();

	// The stand-down: keyed off the aria-hidden ANCESTOR, never the `invisible`
	// utility the twins also carry, which this sheet must not style
	// (theme.test.ts pins that separation). Scoped to the idiom rather than one
	// twin's class, and unconditional: the twin rests hidden at every width.
	const standDown = rulesFor(compiled, STAND_DOWN_SELECTOR);
	expect(standDown).toHaveLength(1);
	const standDownRule = standDown[0];
	if (standDownRule === undefined) {
		throw new Error("the stand-down rule vanished between the length assertion and the read");
	}
	expect(standDownRule.declarations).toContain("animation: none");
	expect(standDownRule.unconditional).toBe(true);

	// It must stay a DESCENDANT rule: every decorative spinner marks itself
	// aria-hidden while running, so a rule matching the spinner's own attribute
	// would freeze the in-flight spinners this contract keeps turning.
	expect(compiled).not.toContain('.spinner[aria-hidden="true"]');

	// The pin only means something while the base spinner animates infinitely;
	// a renamed or de-animated base rule must fail here.
	const base = rulesFor(compiled, ".spinner");
	const animated = base.filter((rule) => rule.declarations.includes("animation:"));
	expect(animated).toHaveLength(1);
	const animatedRule = animated[0];
	if (animatedRule === undefined) {
		throw new Error("the animated base rule vanished between the length assertion and the read");
	}
	expect(animatedRule.declarations).toContain("spinner-turn");
	expect(animatedRule.declarations).toContain("infinite");
});
