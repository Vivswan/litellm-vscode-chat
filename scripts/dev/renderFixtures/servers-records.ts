/**
 * The expanded drawer listing the entry's own model records: the settings
 * editors' matcher vocabulary on a reading surface, read-only - editing stays in
 * the edit page and the setting. prod carries both record kinds (parameters with
 * a forced field, capabilities with a fallback mark); sandbox carries none, so
 * its drawer ends at its facts with no records heading at all.
 */
import type { DashboardServer } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, minutesAgoMs, NO_SECRETS, provenSecrets } from "./shared.ts";

const RECORDS_SERVER: DashboardServer = {
	origin: "declared",
	label: "prod",
	baseUrl: "https://litellm.example.com",
	servedModelCount: 3,
	credentials: "present",
	hasOAuth: false,
	state: "ok",
	lastChecked: minutesAgoMs(2),
	config: {
		secrets: provenSecrets({ apiKey: "secure" }),
		modelParameters: { "gpt-5*": { temperature: 0.2, _force: ["temperature"] }, "*": { max_tokens: 4096 } },
		modelCapabilities: {
			"gpt-5*": { supports_reasoning: true, _fallback: ["supports_reasoning"] },
			"/claude-.*/i": { max_output_tokens: 8192 },
		},
		budget: 50,
	},
};

const SANDBOX_SERVER: DashboardServer = {
	origin: "declared",
	label: "sandbox",
	baseUrl: "http://localhost:4000",
	servedModelCount: 1,
	credentials: "absent",
	hasOAuth: false,
	state: "ok",
	lastChecked: minutesAgoMs(2),
	config: { secrets: NO_SECRETS },
};

const fixture: RenderFixture = {
	messages: [{ kind: "push", state: baseState({ servers: [RECORDS_SERVER, SANDBOX_SERVER] }) }],
	steps: [
		// Two steps, not one: React commits the click's state on its own
		// schedule, so the records assertion runs a step later, after the
		// harness's settle.
		`(() => {
			for (const label of ["prod", "sandbox"]) {
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
			const items = Array.from(document.querySelectorAll(".server-item"));
			const rowOf = (label) =>
				items.find((item) => item.querySelector(".server-label-text")?.textContent?.trim() === label);
			const prodRecords = rowOf("prod")?.querySelectorAll(".drawer-records") ?? [];
			if (prodRecords.length !== 2) {
				throw new Error("prod's drawer should list both record kinds; found " + prodRecords.length);
			}
			if ((rowOf("sandbox")?.querySelectorAll(".drawer-records").length ?? 0) !== 0) {
				throw new Error("sandbox has no records and must list none");
			}
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 1500 },
};

export default fixture;
