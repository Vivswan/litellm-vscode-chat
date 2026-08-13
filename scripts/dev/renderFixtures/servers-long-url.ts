/**
 * A narrow pane holding a server whose URL is longer than the row's own line.
 *
 * This shot exists because every other fixture's hosts are short, and that hid
 * two separate failures of the folded row - both of which broke the WHOLE list
 * rather than the one row, because the row's columns belong to the list. As
 * nowrap text a URL is a single unbreakable token, so its intrinsic width was
 * charged to every track the second line spans: the name column collapsed to
 * nothing on all five rows, and the page grew a horizontal scrollbar.
 *
 * What it should photograph: five intact server names, no horizontal overflow,
 * and the long URL wrapped onto a second line inside its own row - the damage
 * local to the row that owns it.
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
					index === 0
						? { ...server, baseUrl: "https://litellm-gateway-production-eu-west-1.internal.example.com/v1" }
						: server
				),
			},
		},
	],
	viewport: { width: 500, height: 900 },
};

export default fixture;
