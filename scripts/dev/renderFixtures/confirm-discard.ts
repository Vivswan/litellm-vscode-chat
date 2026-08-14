/**
 * The discard-unsaved-changes modal over a dirty server edit page: a rail
 * click with unedited-yet-unsaved changes raises the centered alertdialog,
 * scrim over the whole page, the safe verb focused. Shoot it with --theme
 * light and --theme forced-colors as well: the widget chrome's 1px border is
 * the part that must survive forced colors.
 */
import type { DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [PROD_SERVER],
	models: MODELS.filter((model) => model.serverLabel === "prod"),
});

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`,
		// Any patch dirties the draft; a radio click avoids the controlled-input
		// value-tracker dance a typed field would need.
		`Array.from(document.querySelectorAll(".auth-selector label")).find((l) => l.textContent.includes("Virtual key")).querySelector("input").click()`,
		// The dirty navigation that raises the question.
		`document.getElementById("tab-models").click()`,
	],
	viewport: { width: 1300, height: 950 },
	// The scrim is position: fixed, so a full-page capture would photograph
	// undimmed page below the viewport - a modal not over the page it blocks.
	clipViewport: true,
	settleMs: 400,
};

export default fixture;
