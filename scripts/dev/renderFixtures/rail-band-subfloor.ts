/**
 * The state the harness could never see before scrollbars could be shown: a
 * sub-floor panel, where the page scrolls sideways BY DESIGN and a classic
 * horizontal scrollbar lays a band across the webview bottom - under the rail
 * included, which is where an unowned band read as a broken gap at the rail's
 * foot. The webview's injected defaults decide that band unless the dashboard
 * does: current hosts set html { scrollbar-color: slider editor-background }
 * (an opaque track, and a declaration that disables ::-webkit-scrollbar rules
 * until dashboard.css resets it to auto); older hosts injected always-on 10px
 * webkit bars with an editor-background corner. Held by throwing steps: the
 * band must be present AND measure the dashboard's own 10px - a UA-width band
 * (~15px classic, 0 overlay) means the reset lost and the injected paint is
 * back - and the rail must reach the band's edge with no strip of page between
 * them. That the band's paint is transparent track and corner with
 * editor-colored thumbs is pinned against the compiled sheet by
 * src/test/bun/webview/dashboard/styles/scrollbars.test.ts, because file://
 * pages cannot read CSSOM rules to assert it here.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import base from "./diagnostics-empty.ts";

const fixture: RenderFixture = {
	...base,
	steps: [
		...(base.steps ?? []),
		// Subject and state guard: the right page, sideways-scrolled, with a real
		// band consuming viewport height. Each failure names what is missing.
		`(() => {
			if (!document.querySelector("#panel-diagnostics:not([hidden])")) {
				throw new Error("the diagnostics panel is not the active tab; the band was measured over the wrong subject");
			}
			const doc = document.documentElement;
			if (doc.scrollWidth <= doc.clientWidth + 0.5) {
				throw new Error("no sideways scroll at 300px; the sub-floor state this fixture guards is not on screen");
			}
			if (doc.clientHeight >= window.innerHeight) {
				throw new Error(
					"no horizontal scrollbar band: the viewport lost no height to it, so scrollbars are hidden" +
					" (showScrollbars regressed?) and this fixture is photographing nothing"
				);
			}
			// Exactly the dashboard's declared 10px, not merely present: a band at
			// the UA's own width means the scrollbar-color reset lost and the
			// injected defaults are painting again - which a presence check passes
			// on any classic-scrollbar platform.
			const band = window.innerHeight - doc.clientHeight;
			if (Math.abs(band - 10) > 0.5) {
				throw new Error(
					"the horizontal scrollbar band measures " + band.toFixed(1) + "px, not the dashboard's declared 10px;" +
					" the owned ::-webkit-scrollbar rules are not the ones painting (scrollbar-color reset lost?)"
				);
			}
		})()`,
		// The seam: the rail paints to the band's top edge (the layout viewport's
		// bottom) and to the document bottom - no raw page strip under the rail.
		`(() => {
			const rail = document.querySelector(".rail");
			if (rail === null) {
				throw new Error("no .rail on the page");
			}
			const doc = document.documentElement;
			const rect = rail.getBoundingClientRect();
			if (rect.bottom < doc.clientHeight - 0.5) {
				throw new Error(
					"the rail stops " + (doc.clientHeight - rect.bottom).toFixed(1) +
					"px short of the scrollbar band's edge (rail " + rect.bottom.toFixed(1) + "px, viewport " +
					doc.clientHeight + "px): raw page background shows between the rail and the band"
				);
			}
			if (rect.bottom + window.scrollY < doc.scrollHeight - 0.5) {
				throw new Error(
					"the rail stops " + (doc.scrollHeight - rect.bottom - window.scrollY).toFixed(1) +
					"px short of the document bottom: the surface strips below the fold"
				);
			}
		})()`,
	],
	viewport: { width: 300, height: 700 },
	showScrollbars: true,
	belowFloor: true,
	// The band exists only under the floor; wider sweeps would measure a page
	// without the subject.
	measuredAtOwnWidth: true,
	// The subject is the viewport's own bottom edge; a full-page capture would
	// expand it away.
	clipViewport: true,
};

export default fixture;
