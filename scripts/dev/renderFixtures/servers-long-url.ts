/**
 * A narrow pane holding a server whose URL is longer than the row's own line.
 *
 * This shot exists because every other fixture's hosts are short, and that hid
 * two separate failures of the folded row - both of which broke the WHOLE list
 * rather than the one row, because the row's columns belong to the list. As
 * nowrap text a URL is a single unbreakable token, so its intrinsic width was
 * charged to every track the second line spans: the name column collapsed to
 * nothing on all the rows at once, and the page grew a horizontal scrollbar.
 *
 * It carries the overview's full cast rather than a bare state, so the
 * misconfigured row is in it: that row's action cluster is the only one wider
 * than two short buttons, which is the other way this list has broken.
 *
 * What it should photograph: every server name intact, no horizontal overflow,
 * and the long URL wrapped onto a second line inside its own row - the damage
 * local to the row that owns it.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import overview from "./overview.ts";

const long = "https://litellm-gateway-production-eu-west-1.internal.example.com/v1";

const fixture: RenderFixture = {
	messages: overview.messages.map((message) => {
		const push = message as { kind: string; state?: { servers?: readonly Record<string, unknown>[] } };
		return push.kind === "push" && push.state?.servers !== undefined
			? {
					...push,
					state: {
						...push.state,
						servers: push.state.servers.map((server, index) => (index === 0 ? { ...server, baseUrl: long } : server)),
					},
				}
			: message;
	}),
	viewport: { width: 500, height: 900 },
};

export default fixture;
