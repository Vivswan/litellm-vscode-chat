/**
 * The four pill tones side by side at BOTH sizes the product renders them:
 * the 8px row dot and the 11px collapsed-rail dot. This is the tone-parity
 * specimen - circle ok, triangle warn, square error, hollow ring muted; one
 * shape per tone so the vocabulary survives a reader who cannot separate the
 * hues - and it is the fixture --dpr runs against, because the shapes'
 * strokes and clips are where display densities disagree (the muted ring sat
 * under the 2px state floor once, snapping to a hairline at some densities).
 *
 * The window is 900px wide ON PURPOSE: the 11px size exists only inside the
 * collapsed-rail media query (width < 1000px), so a wider render would
 * photograph two identical 8px rows and call them a comparison. The step
 * ASSERTS both computed dot sizes and fails loudly when either is off.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [{ kind: "push", state: baseState() }],
	steps: [
		`(() => {
			const pill = (tone, word) => {
				const chip = document.createElement("span");
				chip.className = "pill tone-" + tone;
				const dot = document.createElement("span");
				dot.className = "dot";
				chip.append(dot);
				if (word !== undefined) { chip.append(word); }
				return chip;
			};
			const tones = [["ok", "Connected"], ["warn", "Attention"], ["error", "Error"], ["muted", "Not checked"]];
			const specimen = document.createElement("section");
			specimen.className = "tone-specimen";
			const rowTitle = document.createElement("h3");
			rowTitle.textContent = "Row size (8px dot)";
			const rowLine = document.createElement("p");
			for (const [tone, word] of tones) { rowLine.append(pill(tone, word), " "); }
			// The rail's own structure, so the 11px size arrives through the same
			// rules the product uses (.rail-state supplies the gap variables, the
			// collapsed-rail query scales .rail-status dots); dot-only pills,
			// because the collapsed rail hides the word and the dot IS the verdict.
			const railTitle = document.createElement("h3");
			railTitle.textContent = "Collapsed-rail size (11px dot)";
			const railBlock = document.createElement("div");
			railBlock.className = "rail-state";
			const railLine = document.createElement("p");
			railLine.className = "rail-status";
			for (const [tone] of tones) { railLine.append(pill(tone)); }
			railBlock.append(railLine);
			specimen.append(rowTitle, rowLine, railTitle, railBlock);
			// Into the pane, not <main>: main is the shell's flex row (rail beside
			// pane), so a child prepended there becomes a third column.
			const pane = document.querySelector("main .pane");
			if (!pane) { throw new Error("no pane to hold the specimen"); }
			pane.prepend(specimen);
			window.scrollTo(0, 0);
			const eight = getComputedStyle(rowLine.querySelector(".dot")).width;
			const eleven = getComputedStyle(railLine.querySelector(".dot")).width;
			if (eight !== "8px" || eleven !== "11px") {
				throw new Error(
					"expected 8px row dots and 11px rail dots, got " + eight + " and " + eleven +
					"; the 11px size exists only below the 1000px collapsed-rail query, so this shot would compare nothing"
				);
			}
		})()`,
	],
	viewport: { width: 900, height: 480 },
	clipViewport: true,
};

export default fixture;
