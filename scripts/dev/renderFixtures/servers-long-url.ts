/**
 * A narrow pane holding a server whose URL is longer than the row's own line.
 *
 * Every other fixture's hosts are short, which hid two failures of the folded
 * row that broke the WHOLE list rather than the one row, because the row's
 * columns belong to the list: as nowrap text a URL is a single unbreakable
 * token, so its intrinsic width was charged to every track the second line
 * spans. It carries the overview's full cast, so the misconfigured row - the
 * only action cluster wider than two short buttons - is in it too.
 *
 * Every server name should stay intact, with no horizontal overflow and the
 * long URL wrapped onto a second line inside its own row.
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
