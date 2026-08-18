/**
 * The zero-models state: every server answered and nothing failed, yet nothing
 * is served. The hero reads the shared warning ("Connected, no models"), the
 * row stays a healthy "Connected" - the warning is an aggregate claim, not a
 * server's fault.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, minutesAgoIso, NO_SECRETS } from "./shared.ts";

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [
					{
						origin: "declared",
						label: "prod",
						baseUrl: "https://litellm.example.com",
						servedModelCount: 0,
						hasApiKey: true,
						hasOAuth: false,
						state: "ok",
						lastChecked: minutesAgoIso(2),
						config: { secrets: { ...NO_SECRETS, apiKey: "secure" } },
					},
				],
				models: [],
			}),
		},
	],
	viewport: { width: 1300, height: 900 },
};

export default fixture;
