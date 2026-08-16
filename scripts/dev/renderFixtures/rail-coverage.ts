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
 */
import type { RenderFixture } from "../render-dashboard.ts";
import base from "./diagnostics-empty.ts";

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

const fixture: RenderFixture = {
	...base,
	// Tall and past the rail's 1000px collapse threshold, so the EXPANDED rail
	// is what must reach the bottom.
	viewport: { width: 1100, height: 1500 },
	clipViewport: true,
	steps: [
		...(base.steps ?? []),
		`(async () => {
			// Subject guard: this must be the empty diagnostics page, or the rail
			// is being measured over content this fixture never meant.
			if (!document.querySelector("#panel-diagnostics")) {
				throw new Error("not the diagnostics page; the rail coverage claim was measured over the wrong subject");
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
	],
};

export default fixture;
