/**
 * The stale-key question over the server edit form: Save with the base URL
 * re-pointed away from the stored key's address raises the centered
 * alertdialog with the three verbs (Keep editing / Use same key / Clear key)
 * and the detail line naming the old URL. Clipped like confirm-discard: the
 * scrim is position: fixed, so a full-page capture would photograph undimmed
 * page below the viewport.
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
		// Re-point the base URL through React's own value tracker (a bare
		// .value write is swallowed as a non-change by the controlled input).
		`{
			const input = document.getElementById("server-baseUrl");
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "https://litellm-new.example.com");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}`,
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Save").click()`,
		// The subject must be on screen, or this fixture photographs a form
		// that silently saved instead of asking.
		`{
			const dialog = document.querySelector(".confirm-dialog");
			if (dialog === null) { throw new Error("the stale-key confirm dialog did not open"); }
			if (!(dialog.textContent ?? "").includes("Use same key")) { throw new Error("the dialog is not the stale-key question"); }
		}`,
	],
	viewport: { width: 1300, height: 950 },
	clipViewport: true,
	settleMs: 400,
};

export default fixture;
