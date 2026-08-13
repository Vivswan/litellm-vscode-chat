/**
 * The narrowest supported pane, holding the two things that broke it.
 *
 * 320px is the width the shell promises to reflow at, and two states found by
 * review both took the page into a horizontal scrollbar there - each because an
 * unbreakable run of text was charged to tracks the whole list shares. One is a
 * long server LABEL (the name spanning into the flexible track hands it the
 * label's full nowrap width); the other is the two-step confirm, whose
 * "Confirm remove?" beside a nowrap verdict pill has a minimum wider than the
 * pane. The armed row is the first one, so the steps click its Remove.
 *
 * What it should photograph: no horizontal overflow, every row's name present,
 * the long label ellipsized rather than pushing the page, and the armed pair
 * wrapped rather than overflowing.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state = baseState();

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: {
				...state,
				servers: state.servers.map((server, index) =>
					index === 0 ? { ...server, label: "production-eu-west-gateway-primary" } : server
				),
			},
		},
	],
	steps: [
		`Array.from(document.querySelectorAll(".server-actions button")).find((b) => b.textContent.trim() === "Remove")?.click()`,
	],
	viewport: { width: 320, height: 900 },
};

export default fixture;
