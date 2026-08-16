/**
 * The Servers page with drawers open: the labelled inventory a row expands
 * onto, over a fully reported server (prod), one whose numbers are partly
 * missing (gateway - its proxy serves no activity endpoint), and one a denied
 * key leaves without usage numbers (locked-down - entry facts only, with the
 * degraded diagnostic carrying the denial below). The point of the shot is
 * the absence rendering - a dim dash plus the reason in place, never a zero -
 * and the entry facts (Base URL, Authentication, Models, Discovery last checked)
 * leading the usage inventory. Two later tenants also land here: gateway's
 * warn-tier budget sentence sits INSIDE its drawer (the collapsed row keeps
 * only the tinted meter), and a declared entry's own model records list
 * read-only under the facts.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import serversSpend from "./servers-spend.ts";

const fixture: RenderFixture = {
	...serversSpend,
	steps: [
		// Two steps, not one: React commits the click's state on its own schedule,
		// so the open assertion runs a step later, after the harness's settle.
		`(() => {
			for (const label of ["prod", "gateway", "locked-down"]) {
				const line = Array.from(document.querySelectorAll("button.server-line")).find(
					(candidate) => candidate.querySelector(".server-label-text")?.textContent?.trim() === label
				);
				if (!line) {
					throw new Error("no server row named " + label);
				}
				line.click();
			}
		})()`,
		`(() => {
			for (const label of ["prod", "gateway", "locked-down"]) {
				const line = Array.from(document.querySelectorAll("button.server-line")).find(
					(candidate) => candidate.querySelector(".server-label-text")?.textContent?.trim() === label
				);
				if (line?.getAttribute("aria-expanded") !== "true") {
					throw new Error(label + "'s drawer did not open");
				}
			}
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 1750 },
};

export default fixture;
