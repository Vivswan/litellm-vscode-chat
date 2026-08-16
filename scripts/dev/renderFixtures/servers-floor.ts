/**
 * The narrowest supported pane, holding the two states that broke it.
 *
 * 320px is the width the shell promises to reflow at, and two states took the
 * page into a horizontal scrollbar there, each because an unbreakable run of
 * text was charged to tracks the whole list shares: a long server LABEL, and the
 * two-step confirm, which covers its own row out of flow and must fit inside the
 * row's width at the floor. The steps arm the first row, so both are in one shot
 * alongside the overview's full cast (the misconfigured row is the only one
 * whose action cluster is wider than two short buttons).
 *
 * Usage joins the rows by LABEL, so the rename below renames the row's usage
 * card too, or the floor tier's spend cell would silently vanish from the shot.
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
