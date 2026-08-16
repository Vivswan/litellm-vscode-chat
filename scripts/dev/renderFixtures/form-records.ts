/**
 * The per-entry record tables inside the server edit form: prod's entry
 * carries model parameters AND capabilities, so both disclosures open with
 * their compact matcher tables (chips wrap in the narrow panel).
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
				modelParameters: {
					"gpt-5*": { temperature: 0.2, _force: ["temperature"] },
					"*": { top_p: 0.9, _inheritable: true },
				},
				modelCapabilities: {
					"deepseek-r1": { context_length: 131072, supports_vision: false },
					"my-alias": { _openrouter_model: "anthropic/claude-sonnet-4" },
				},
				budget: 50,
			},
		} as DashboardServer,
	],
	models: MODELS.filter((model) => model.serverLabel === "prod"),
});

const fixture: RenderFixture = {
	messages: [{ kind: "push", state }],
	steps: [
		`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Edit").click()`,
		// The subject guard, plus the form's two alignment claims. One label
		// edge: each FormSection owns its grid, kept uniform by the flat 10rem
		// gutter - this asserts the construction stays flat, because a
		// content-sized track would drift per section under longer translated
		// labels the English-only harness can never render. One right edge: a
		// help-less wide row spans through the glyph track, so each record
		// table ends on the field rows' help-glyph column instead of ~10px
		// short of it.
		`(() => {
			const labels = [...document.querySelectorAll("#server-edit-page .label-row")];
			if (labels.length < 10) {
				throw new Error("only " + labels.length + " label rows; this is not the full server edit form");
			}
			const edges = labels.map((label) => label.getBoundingClientRect().right);
			const spread = Math.max(...edges) - Math.min(...edges);
			if (spread > 1) {
				throw new Error("the label gutters disagree across sections by " + spread.toFixed(1) + "px; one section's track grew alone");
			}
			const tables = [...document.querySelectorAll("#server-edit-page .record-table")];
			if (tables.length !== 2) {
				throw new Error("expected the edit form's two record tables, found " + tables.length);
			}
			const glyph = document.querySelector('#server-edit-page button.help[aria-label="Help: Base URL"]');
			if (glyph === null) {
				throw new Error("no Base URL help glyph on the page; this is not the server edit form");
			}
			const edge = glyph.getBoundingClientRect().right;
			for (const table of tables) {
				const off = table.getBoundingClientRect().right - edge;
				if (Math.abs(off) > 1) {
					throw new Error("a record table's right edge is " + off.toFixed(1) + "px off the help-glyph column's");
				}
			}
		})()`,
		`(() => {
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 2400 },
	settleMs: 400,
};

export default fixture;
