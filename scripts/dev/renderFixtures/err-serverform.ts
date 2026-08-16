/**
 * The server form in a field-error state: the edit form open on prod with an
 * unusable Base URL typed and blurred, so the URL's problem stands in the row's
 * covered hint slot, and a bad custom-header name has its verdict in the row's
 * reserved status line. The reviewable evidence for the form's transient-slot
 * reservations, and what check-geometry's form pairs anchor on.
 */
import type { DashboardServer, DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, MODELS, PROD_SERVER } from "./shared.ts";

const state: DashboardState = baseState({
	servers: [
		{
			...PROD_SERVER,
			config: {
				secrets: { apiKey: "secure", oauthClientSecret: "none", virtualKeyValue: "none" },
				headers: { "x-routing-env": "prod" },
			},
		} as DashboardServer,
	],
	models: MODELS.filter((model) => model.serverLabel === "prod"),
});

/** A React-safe input write: the native setter plus the events React listens to, ending on blur (touch). */
function type(selector: string, value: string): string {
	return `(() => {
		const input = document.querySelector(${JSON.stringify(selector)});
		if (input === null) { throw new Error("no input matches " + ${JSON.stringify(selector)}); }
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
		input.focus({ preventScroll: true });
		setter.call(input, ${JSON.stringify(value)});
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.blur();
	})()`;
}

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`,
		type("#server-baseUrl", "not a url"),
		type('#server-edit-page .row input[aria-label="Header name"]', "bad header"),
		`window.scrollTo(0, 0)`,
		// The shot's own subject, asserted: the URL problem must stand in the
		// field's covered hint slot and the header verdict in its reserved
		// status line, or the render exits green while photographing a form
		// without the states it exists to show.
		`(() => {
			const urlError = document.querySelector('[id="server-baseUrl-error"] .error');
			if (urlError === null || urlError.textContent.length === 0) {
				throw new Error("The Base URL problem never rendered in the field's covered hint slot");
			}
			const headerVerdict = document.querySelector("#server-edit-page .row .row-status.error");
			if (headerVerdict === null) {
				throw new Error("The header row's verdict never rendered in its reserved status line");
			}
			const note = document.querySelector("#server-edit-page .rename-note");
			if (note === null || getComputedStyle(note).visibility !== "hidden") {
				throw new Error("The rename note is not holding its box as an invisible spacing twin");
			}
		})()`,
	],
	viewport: { width: 1300, height: 1400 },
	settleMs: 400,
};

export default fixture;
