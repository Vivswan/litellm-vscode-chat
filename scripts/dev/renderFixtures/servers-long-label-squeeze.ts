/**
 * The wide tier at its LOW end, with the row genuinely out of space: the
 * content-sized name track (minmax to max-content) lets the sibling's long
 * label push the URL's fr track all the way DOWN to its 12ch floor, and only
 * then does the label itself start giving characters to an ellipsis - the
 * yield order the base template promises. servers-long-label.ts shoots the
 * slack end of the same tier (label whole, URLs untouched) and lends this one
 * its state; this sibling guards the floor end, where the template's "the 12ch
 * floor keeps the URL identifying its row" claim is actually load-bearing.
 * Both clipped cells are by design: the drawer's Label and Base URL facts are
 * the full-text path out of this state.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { LONG_LABEL_MESSAGES } from "./servers-long-label.ts";

const fixture: RenderFixture = {
	messages: LONG_LABEL_MESSAGES,
	steps: [
		`(() => {
			const list = document.querySelector(".server-list");
			if (!list) { throw new Error("no server list rendered"); }
			// The one-line tier's own shape (eight tracks; the folded tiers run
			// four): a shot that fell into a folded tier would wrap URLs by design
			// and assert nothing about the wide tier's floor.
			const tracks = getComputedStyle(list).gridTemplateColumns.split(" ");
			if (tracks.length !== 8) {
				throw new Error("expected the wide tier's 8 list tracks, got " + tracks.length + "; the pane sits below 920px");
			}
			const row = document.querySelector(".server-list > li.server-item");
			const label = row === null ? null : row.querySelector(".server-label-text");
			if (!(label instanceof HTMLElement)) { throw new Error("no server label rendered"); }
			const url = row.querySelector(".server-url");
			if (!(url instanceof HTMLElement)) { throw new Error("the long-label row rendered without its URL cell"); }
			// The rule first, because it is the one this pane reproduces and the
			// one whose absence would otherwise be reported as something else: a
			// squeezed track is exactly where the URL's <wbr> opportunities
			// folded every row onto three lines, and a wrapped cell fills its
			// width, so the ellipsis check below would fire instead and send the
			// next reader after the pane width. Counting line boxes cannot see
			// it either - the cell is a blockified grid item, so getClientRects()
			// returns one rect whether it holds one line or three.
			const wbr = url.querySelector("wbr");
			if (wbr === null) { throw new Error("the row URL carries no wbr; the markup stopped offering the break opportunities this pins"); }
			const wbrDisplay = getComputedStyle(wbr).display;
			if (wbrDisplay !== "none") {
				throw new Error("the row URL's wbr computes display: " + wbrDisplay + " at the wide tier; its break opportunities are back and a squeezed track will wrap instead of ellipsizing");
			}
			// Both ellipsize HERE and only in this order: a whole label or an
			// unclipped URL means the pane found slack and this shot stopped
			// photographing the floor state it exists for.
			if (url.scrollWidth <= url.clientWidth) {
				throw new Error("the long-label row's URL is not ellipsized; the pane has slack and this shot proves nothing about the floor");
			}
			if (label.scrollWidth <= label.clientWidth) {
				throw new Error("the long label renders whole; the name stopped yielding after the URL's floor and this is not the exhausted state");
			}
			// 12ch measured in the page, in the list's own font, exactly as the
			// track's minmax(12ch, 1fr) resolves it. The TRACK carries the floor;
			// the url element inside sits a subgrid gap narrower than its track.
			const probe = document.createElement("div");
			probe.style.cssText = "position: absolute; width: 12ch; visibility: hidden";
			list.append(probe);
			const floor = probe.getBoundingClientRect().width;
			probe.remove();
			const urlTrack = Number.parseFloat(tracks[2]);
			if (!(urlTrack >= floor - 0.5)) {
				throw new Error("the squeezed URL track is " + tracks[2] + ", below its 12ch floor of " + floor + "px; the URL no longer identifies its row");
			}
			// Parked AT the floor, not merely above it: a track with slack left
			// means the squeeze drifted (a wider pane, a changed floor) and the
			// shot stopped photographing the floor state - re-tune the fixture.
			if (!(urlTrack <= floor + 1)) {
				throw new Error("the squeezed URL track is " + tracks[2] + " against a 12ch floor of " + floor + "px; the track is no longer parked on its floor and this is not the state the fixture pins");
			}
		})()`,
	],
	// A 983px pane as the CONTAINER QUERY counts it: 1248 window - 216 rail -
	// 1 rail border - 48 pane padding. Not the pane's clientWidth, which keeps
	// the padding (the sibling's gate reads that one), so the two files quote
	// different quantities. Past the 920px fold, but short enough that the
	// label's max-content run exhausts the row - which is what parks the URL
	// on its floor and starts the label's own ellipsis.
	viewport: { width: 1248, height: 800 },
	clipViewport: true,
};

export default fixture;
