/**
 * The rail's coverage claim, held by a throwing step rather than a screenshot:
 * the rail column paints to the BOTTOM of both the viewport and the document,
 * whatever the content height and wherever the page is scrolled.
 *
 * Both content heights are legs, because neither implies the other. SHORT pins
 * .rail-inner's 100vh, the only rule reaching the bottom edge where the document
 * does not scroll. TALL pulls the two bottoms apart, so .rail's stretch has to
 * reach them; asserted at the top, middle, and bottom of the scroll, with the
 * spacer growing the PANE the way real content grows the shell.
 *
 * This file measures the EXPANDED rail; rail-coverage-collapsed.ts runs the
 * same steps below the collapse, because the icon rail swaps the column's
 * basis and inner geometry and neither state's coverage implies the other's.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import base from "./diagnostics-empty.ts";

/**
 * Each fixture opens by proving the rail is in the state it claims to measure,
 * so a moved collapse threshold fails the claim instead of silently pointing
 * both fixtures at one state. 100 splits the two boxes: 49px collapsed and
 * 217px expanded (.rail's flex basis plus its 1px right border, which is its
 * whole width because nothing sets box-sizing on .rail and there is no preflight).
 */
const railStateGuard = (state: "expanded" | "collapsed") => `(() => {
	const rail = document.querySelector(".rail");
	if (rail === null) {
		throw new Error("no .rail on the page");
	}
	const width = rail.getBoundingClientRect().width;
	if (${state === "collapsed" ? "width >= 100" : "width < 100"}) {
		throw new Error(
			"the rail measures " + width.toFixed(1) + "px, not the ${state} state this fixture claims to cover;" +
			" the collapse threshold moved - re-point the fixture's viewport"
		);
	}
})()`;

/** The measurement both legs run: the rail's box against the viewport and document bottoms. */
const assertCovers = `(label) => {
	const rail = document.querySelector(".rail");
	if (rail === null) {
		throw new Error("no .rail on the page");
	}
	const doc = document.documentElement;
	const rect = rail.getBoundingClientRect();
	const bottomInDocument = rect.bottom + window.scrollY;
	if (rect.bottom < doc.clientHeight - 0.5) {
		throw new Error(
			label + ": the rail stops " + (doc.clientHeight - rect.bottom).toFixed(1) +
			"px short of the viewport bottom (rail " + rect.bottom.toFixed(1) +
			"px, viewport " + doc.clientHeight + "px): raw page background shows under the left nav"
		);
	}
	if (bottomInDocument < doc.scrollHeight - 0.5) {
		throw new Error(
			label + ": the rail stops " + (doc.scrollHeight - bottomInDocument).toFixed(1) +
			"px short of the document bottom (rail " + bottomInDocument.toFixed(1) +
			"px, document " + doc.scrollHeight + "px): the surface strips below the fold"
		);
	}
}`;

/** The whole run for one rail state, shared with the collapsed fixture: guard, base setup, both coverage legs. */
export const coverageSteps = (state: "expanded" | "collapsed"): readonly string[] => [
	railStateGuard(state),
	...(base.steps ?? []),
	`(async () => {
		// Subject guard: this must be the empty diagnostics page, or the rail
		// is being measured over content this fixture never meant. Every panel
		// stays mounted hidden (app.tsx's SectionPanel), so a bare
		// #panel-diagnostics exists on every page; :not([hidden]) is what
		// asserts diagnostics is the ACTIVE tab.
		if (!document.querySelector("#panel-diagnostics:not([hidden])")) {
			throw new Error(
				"the diagnostics panel is not the active tab; the rail coverage claim was measured over the wrong subject"
			);
		}
		const doc = document.documentElement;
		const covers = ${assertCovers};
		const settle = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		if (doc.scrollHeight > doc.clientHeight + 1) {
			throw new Error(
				"the empty page already scrolls at " + doc.clientHeight + "px (document " + doc.scrollHeight +
				"px); the short leg no longer measures a page shorter than its window - re-point the fixture"
			);
		}
		covers("short page");

		// The tall leg. The spacer goes in the pane, where real content
		// lives, so the shell grows as a long page grows it; it is removed
		// before the capture so the shot stays the short page.
		const pane = document.querySelector(".pane");
		if (pane === null) {
			throw new Error("no .pane on the page; the tall leg cannot grow the shell the way content does");
		}
		const spacer = document.createElement("div");
		spacer.style.height = "2200px";
		spacer.setAttribute("aria-hidden", "true");
		pane.appendChild(spacer);
		await settle();
		if (doc.scrollHeight <= doc.clientHeight + 1) {
			throw new Error("the spacer did not make the document taller than the viewport; the tall leg proved nothing");
		}
		for (const [label, top] of [
			["tall page, at the top", 0],
			["tall page, mid-scroll", Math.floor((doc.scrollHeight - doc.clientHeight) / 2)],
			["tall page, scrolled to the bottom", doc.scrollHeight],
		]) {
			window.scrollTo(0, top);
			await settle();
			covers(label);
		}
		spacer.remove();
		window.scrollTo(0, 0);
		await settle();
	})()`,
];

const fixture: RenderFixture = {
	...base,
	// Tall and past the rail's 1000px collapse threshold, so the EXPANDED rail
	// is what must reach the bottom.
	viewport: { width: 1100, height: 1500 },
	clipViewport: true,
	steps: coverageSteps("expanded"),
};

export default fixture;
