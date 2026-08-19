/**
 * The dashboard owns the webview's scrollbars. The webview's injected defaults
 * (@layer vscode-default) decide them otherwise: current hosts set
 * html { scrollbar-color: slider editor-background } - an opaque
 * editor-background track that inherits into every scroller and disables all
 * ::-webkit-scrollbar styling until it is reset - and older hosts injected
 * always-on 10px webkit bars with an editor-background corner. Below the
 * shell's 320px floor either generation's band crosses the webview bottom
 * UNDER the rail, reading as a broken gap at the rail's foot. The owned
 * design: the scrollbar-color: auto reset first, then transparent track and
 * corner (only the page's color shows through the band), thumbs resting
 * transparent until the pointer is over the page or focus is inside it, the
 * editor's slider tokens for every thumb state, and high contrast never
 * hiding the thumb and drawing it a contrastBorder edge. The render fixture
 * rail-band-subfloor.ts holds the band's geometry; a file:// page cannot read
 * CSSOM rules, so the paint contract is pinned here against the COMPILED
 * sheet - what ships - not the source text.
 */
import { expect, test } from "bun:test";
import type { StyleRule } from "./compileStyles";
import { compileDashboard, rulesFor } from "./compileStyles";

/** The one rule for a selector, floored: an absent rule must fail, not pass vacuously. */
function only(css: string, selector: string): StyleRule {
	const rules = rulesFor(css, selector);
	expect(rules.length, `expected exactly one rule for ${selector}`).toBe(1);
	const rule = rules[0];
	if (rule === undefined) {
		throw new Error(`no rule for ${selector}`);
	}
	return rule;
}

test("track, corner and resting thumb are transparent; hover or inner focus reveals the slider tokens", async () => {
	const css = await compileDashboard();
	// The reset first: the host injects html { scrollbar-color: slider
	// editor-background }, which inherits everywhere and disables every
	// ::-webkit-scrollbar rule below - without auto here the whole contract is
	// dead code in a real webview.
	expect(only(css, ":root").declarations).toMatch(/scrollbar-color:\s*auto/);
	// Bun's CSS bundler prints `transparent` as `none`; accept either spelling.
	const transparent = /background:\s*(?:none|transparent);?/;
	expect(only(css, "::-webkit-scrollbar-track").declarations).toMatch(transparent);
	expect(only(css, "::-webkit-scrollbar-corner").declarations).toMatch(transparent);
	expect(only(css, "::-webkit-scrollbar-thumb").declarations).toMatch(transparent);
	// The mid-drag keeper: :root:hover drops when the pointer leaves the window
	// during a drag, and the grabbed thumb must not blank.
	expect(only(css, "::-webkit-scrollbar-thumb:active").declarations).toContain(
		"var(--vscode-scrollbarSlider-activeBackground)"
	);
	// The reveal pairs: the root's own scrollbar and every descendant's, since a
	// descendant selector cannot reach the root's; :focus-within beside :hover,
	// so keyboard focus summons the same indicator a pointer does. Each state
	// reads its own slider token, so a forced theme that moves the tokens moves
	// the bars too.
	for (const selector of [
		":root:hover::-webkit-scrollbar-thumb",
		":root:hover ::-webkit-scrollbar-thumb",
		":root:focus-within::-webkit-scrollbar-thumb",
		":root:focus-within ::-webkit-scrollbar-thumb",
	]) {
		expect(only(css, selector).declarations).toContain("var(--vscode-scrollbarSlider-background)");
	}
	for (const [state, token] of [
		[":hover", "--vscode-scrollbarSlider-hoverBackground"],
		[":active", "--vscode-scrollbarSlider-activeBackground"],
	] as const) {
		for (const selector of [
			`:root:hover::-webkit-scrollbar-thumb${state}`,
			`:root:hover ::-webkit-scrollbar-thumb${state}`,
		]) {
			expect(only(css, selector).declarations, `${selector} must read ${token}`).toContain(`var(${token})`);
		}
	}
	// 10px, the webview default's own width: the models list's track arithmetic
	// budgets exactly it (dashboard.css says where).
	expect(only(css, "::-webkit-scrollbar").declarations).toMatch(/width:\s*10px/);
	expect(only(css, "::-webkit-scrollbar").declarations).toMatch(/height:\s*10px/);
});

test("high contrast never hides the thumb and draws it a contrastBorder edge", async () => {
	const css = await compileDashboard();
	// Both HC classes named, the house spelling; :has reaches the ROOT's
	// scrollbar, which no body-keyed descendant selector can.
	for (const selector of [
		":root:has(body.vscode-high-contrast)::-webkit-scrollbar-thumb",
		":root:has(body.vscode-high-contrast) ::-webkit-scrollbar-thumb",
		":root:has(body.vscode-high-contrast-light)::-webkit-scrollbar-thumb",
		":root:has(body.vscode-high-contrast-light) ::-webkit-scrollbar-thumb",
	]) {
		const rule = only(css, selector);
		expect(rule.declarations).toContain("var(--vscode-contrastBorder)");
		expect(rule.declarations).toContain("var(--vscode-scrollbarSlider-background)");
	}
});
