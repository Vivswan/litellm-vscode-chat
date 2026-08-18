/**
 * The server form switched to None over a STORED API key, after a Save
 * attempt: the block-and-tell appearance - warn line, Remove checkbox, and
 * the problem line naming the way out - must all render together.
 */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, PROD_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			config: {
				secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
			},
		} as DashboardServer,
	],
	models: [],
});

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`,
		`Array.from(document.querySelectorAll(".auth-selector label")).find((l) => l.textContent.trim() === "None").querySelector("input").click()`,
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Save").click()`,
		// The shot's own subject, asserted: the refusal must stand in the stored
		// key's covered hint slot with its Remove checkbox reachable beside it,
		// or the render exits green while photographing an unblocked form.
		`(() => {
			const problem = document.querySelector('[id="server-apiKey-error"] .error');
			if (problem === null || problem.textContent.length === 0) {
				throw new Error("The stored-key refusal never rendered in the row's covered hint slot");
			}
			if (document.querySelector("#server-edit-page .secret-remove input[type=checkbox]") === null) {
				throw new Error("The Remove checkbox that resolves the block never rendered");
			}
		})()`,
	],
	viewport: { width: 1300, height: 1600 },
	settleMs: 400,
};

export default fixture;
