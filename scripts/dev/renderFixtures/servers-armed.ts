/**
 * The armed remove state on the merged Servers page: prod's Remove clicked, so
 * the two-step confirm pair ("Confirm remove?" beside Cancel) is in frame.
 *
 * The shot exists for the no-reflow contract: the actions track is fixed at
 * the RESTING pair's width and the armed pair WRAPS vertically inside it, so
 * arming a remove must not shift any column of any row - the columns belong to
 * the list, and the reader's pointer is over the button that is about to
 * confirm. The steps MEASURE that rather than trusting the eye, on the cell
 * that would actually move: a sibling row's STATUS pill sits to the right of
 * the flexible URL column, so a widened actions track shrinks the URL and
 * drags the status leftward - that x is recorded before arming and compared
 * after, and the fixture throws on any movement. (The name cell would not do:
 * it sits left of every flexible track and stays put even under the faulty
 * template this guards against.) What it should photograph: the wrapped pair
 * stacked on prod's row, every other row's columns exactly where the resting
 * shot puts them.
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
