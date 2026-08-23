/**
 * The pre-proof window: a declared entry whose secret locations the first sync
 * pass has not proven yet, beside a proven row for contrast. The subject is the
 * credential verdict's third state - the unproven row's drawer says the key
 * location is not read yet (dim dash plus reason, never a false "none"), and
 * its header carries no auth badge while the proven row keeps its "API key".
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, minutesAgoMs, provenSecrets } from "./shared.ts";

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
						credentials: "unknown",
						hasOAuth: false,
						state: "unchecked",
						config: { secrets: { kind: "unproven" } },
					},
					{
						origin: "declared",
						label: "staging",
						baseUrl: "https://staging.example.com",
						servedModelCount: 2,
						credentials: "present",
						hasOAuth: false,
						state: "ok",
						lastChecked: minutesAgoMs(3),
						config: { secrets: provenSecrets({ apiKey: "secure" }) },
					},
				],
				models: [],
			}),
		},
	],
	steps: [
		// Two steps, not one: React commits the click's state on its own schedule,
		// so the open assertion runs a step later, after the harness's settle.
		`(() => {
			for (const label of ["prod", "staging"]) {
				const line = Array.from(document.querySelectorAll("button.server-line")).find(
					(candidate) => candidate.querySelector(".server-label-text")?.textContent?.trim() === label
				);
				if (!line) {
					throw new Error("no server row named " + label);
				}
				line.click();
			}
		})()`,
		`(() => {
			for (const label of ["prod", "staging"]) {
				const line = Array.from(document.querySelectorAll("button.server-line")).find(
					(candidate) => candidate.querySelector(".server-label-text")?.textContent?.trim() === label
				);
				if (line?.getAttribute("aria-expanded") !== "true") {
					throw new Error(label + "'s drawer did not open");
				}
			}
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 900 },
};

export default fixture;
