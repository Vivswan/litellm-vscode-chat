/** The add-server form with the API version disclosure clicked open: auto mode, the default select. */
import type { DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state: DashboardState = baseState();

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Add server").click()`,
		`document.querySelector("#server-apiVersion-mode")?.closest("details")?.querySelector("summary")?.click()`,
	],
	viewport: { width: 1300, height: 1600 },
	settleMs: 400,
};

export default fixture;
