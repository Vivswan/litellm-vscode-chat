/**
 * The narrowest supported pane, holding the two states that broke it.
 *
 * 320px is the width the shell promises to reflow at, and two states found by
 * review both took the page into a horizontal scrollbar there - each because an
 * unbreakable run of text was charged to tracks the whole list shares. One is a
 * long server LABEL (the name spanning into the flexible track hands it the
 * label's full nowrap width); the other is the two-step confirm, whose
 * "Confirm remove?" beside a nowrap verdict pill has a minimum wider than the
 * pane. The steps arm the first row, so both are in one shot.
 *
 * It carries the overview's full cast, so the misconfigured row - the only one
 * whose action cluster is wider than two short buttons - is in frame too.
 *
 * What it should photograph: no horizontal overflow, every row's name present,
 * the long label ellipsized rather than pushing the page, the armed pair
 * wrapped rather than overflowing, and the relabeled row's own spend meter
 * still on it - usage joins the rows by LABEL, so the rename below renames the
 * row's usage card too, or the floor tier's spend cell would silently vanish
 * from the shot.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const RELABELED = "production-eu-west-gateway-primary";

const fixture: RenderFixture = {
	messages: overview.messages.map((message) => {
		const push = message as {
			kind: string;
			state?: {
				servers?: readonly { label?: string }[];
				usage?: { servers?: readonly { label?: string }[] };
			};
		};
		if (push.kind !== "push" || push.state?.servers === undefined) {
			return message;
		}
		const original = push.state.servers[0]?.label;
		const usage = push.state.usage;
		return {
			...push,
			state: {
				...push.state,
				servers: push.state.servers.map((server, index) => (index === 0 ? { ...server, label: RELABELED } : server)),
				...(usage?.servers === undefined
					? {}
					: {
							usage: {
								...usage,
								servers: usage.servers.map((card) => (card.label === original ? { ...card, label: RELABELED } : card)),
							},
						}),
			},
		};
	}),
	steps: [
		`Array.from(document.querySelectorAll(".server-actions button")).find((b) => b.textContent.trim() === "Remove")?.click()`,
		// The relabeled row must still carry its spend unit: an empty cell here
		// means the label rename severed the usage join and the shot no longer
		// photographs the floor tier's spend presentation at all.
		`(() => {
			const row = Array.from(document.querySelectorAll(".server-item")).find((item) =>
				item.querySelector(".server-label-text")?.textContent?.includes("production-eu-west")
			);
			if (!row?.querySelector(".spend-unit")) { throw new Error("the relabeled row lost its spend unit"); }
		})()`,
	],
	viewport: { width: 320, height: 900 },
};

export default fixture;
