/**
 * The armed remove state on the merged Servers page: prod's Remove clicked, so
 * the two-step confirm pair is in frame.
 *
 * The shot exists for the no-reflow contract: the actions track is fixed at the
 * RESTING pair's width and the armed pair leaves the flow to COVER the row's own
 * cells, so arming must shift no column of any row. The steps MEASURE that on
 * the cell that would actually move - a sibling row's STATUS pill, which sits
 * right of the flexible URL column, so a widened actions track drags it leftward
 * - recording its x before arming and throwing on any movement. (The name cell
 * would not do: it stays put even under the faulty template this guards
 * against.) The armed row's own height is the server-row-armed-cover pair's.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import serversSpend from "./servers-spend.ts";

/** The steps that arm prod's remove and assert zero column shift, shared with the folded variant. */
export const ARM_AND_ASSERT_NO_SHIFT: readonly string[] = [
	// Three steps, not one: React commits the click's state on its own
	// schedule, so the armed assertion runs a step later, after the harness's
	// settle.
	`(() => {
		const gatewayItem = Array.from(document.querySelectorAll(".server-item")).find(
			(candidate) => candidate.querySelector(".server-label-text")?.textContent === "gateway"
		);
		const status = gatewayItem?.querySelector(".server-status");
		if (!status) {
			throw new Error("no gateway status cell to measure");
		}
		window.__wpmStatusX = status.getBoundingClientRect().x;
	})()`,
	`(() => {
		const remove = Array.from(document.querySelectorAll(".server-actions button")).find(
			(candidate) => candidate.textContent?.trim() === "Remove"
		);
		if (!remove) {
			throw new Error("no Remove button to arm");
		}
		remove.click();
	})()`,
	`(() => {
		const confirm = Array.from(document.querySelectorAll(".server-actions button")).find(
			(candidate) => candidate.textContent?.trim() === "Confirm remove?"
		);
		if (!confirm) {
			throw new Error("arming Remove did not show the confirm pair");
		}
		const gatewayItem = Array.from(document.querySelectorAll(".server-item")).find(
			(candidate) => candidate.querySelector(".server-label-text")?.textContent === "gateway"
		);
		const after = gatewayItem?.querySelector(".server-status")?.getBoundingClientRect().x;
		if (after !== window.__wpmStatusX) {
			throw new Error(
				"arming the remove shifted a sibling row's columns: status x " + window.__wpmStatusX + " -> " + after
			);
		}
	})()`,
];

const fixture: RenderFixture = {
	...serversSpend,
	steps: [...ARM_AND_ASSERT_NO_SHIFT],
	viewport: { width: 1300, height: 1500 },
};

export default fixture;
