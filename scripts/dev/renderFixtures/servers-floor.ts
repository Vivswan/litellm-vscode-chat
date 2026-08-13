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
 * the long label ellipsized rather than pushing the page, and the armed pair
 * wrapped rather than overflowing.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const fixture: RenderFixture = {
	messages: overview.messages.map((message) => {
		const push = message as { kind: string; state?: { servers?: readonly Record<string, unknown>[] } };
		return push.kind === "push" && push.state?.servers !== undefined
			? {
					...push,
					state: {
						...push.state,
						servers: push.state.servers.map((server, index) =>
							index === 0 ? { ...server, label: "production-eu-west-gateway-primary" } : server
						),
					},
				}
			: message;
	}),
	steps: [
		`Array.from(document.querySelectorAll(".server-actions button")).find((b) => b.textContent.trim() === "Remove")?.click()`,
	],
	viewport: { width: 320, height: 900 },
};

export default fixture;
