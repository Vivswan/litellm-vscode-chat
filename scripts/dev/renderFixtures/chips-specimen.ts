/**
 * Every chip family the dashboard speaks, side by side: the status pill, the
 * soft-fill Badge, the filter pill toggle, the provenance chip, and the record
 * editors' field chip. For vocabulary-distinguishability review - five different
 * "small labelled box" registers must read as five, not one - and built by
 * CLONING the live page's own chips (every tab panel stays mounted, merely
 * hidden), so each specimen is the product's exact markup. Any host theme is
 * reachable via --theme; the harvest step THROWS on any missing chip.
 */
import type { DashboardServer } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, EXTERNAL_SERVER, GATEWAY_SERVER, NO_SECRETS, PROD_SERVER, RESOLVED_VIEW } from "./shared.ts";

/** A just-declared server before its first sync: the muted "Not checked" pill. */
const UNCHECKED_SERVER: DashboardServer = {
	origin: "declared",
	label: "staging",
	baseUrl: "https://staging.example.com",
	modelCount: 0,
	hasApiKey: true,
	hasOAuth: false,
	state: "unchecked",
	config: { secrets: NO_SECRETS },
};

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({ servers: [PROD_SERVER, GATEWAY_SERVER, EXTERNAL_SERVER, UNCHECKED_SERVER] }),
		},
		// Diagnostics is the active tab because its resolution table only loads
		// while visible, and it is the one place provenance chips render.
		{ kind: "focusSection", section: "diagnostics" },
	],
	respond: {
		readResolvedModels: { kind: "response", payload: { view: RESOLVED_VIEW } },
	},
	steps: [
		`(() => {
			const grab = (selector, description) => {
				const node = document.querySelector(selector);
				if (!node) { throw new Error("no " + description + " to clone: " + selector); }
				return node.cloneNode(true);
			};
			const families = [
				["status pill", [
					grab("#panel-overview .pill.tone-ok", "ok status pill"),
					grab("#panel-overview .pill.tone-muted", "muted Not-checked status pill"),
				]],
				["Badge", [grab('#panel-overview [data-slot="badge"]', "Badge")]],
				["filter pill", [grab("#panel-models button.filter-pill", "filter pill")]],
				["provenance chip", [grab("#panel-diagnostics .chip-prov", "provenance chip")]],
				["field chip", [grab("#panel-settings button.chip-field:not(.chip-add)", "field chip")]],
			];
			const specimen = document.createElement("section");
			specimen.className = "chip-specimen";
			const title = document.createElement("h3");
			title.textContent = "Chip families";
			specimen.append(title);
			for (const [label, clones] of families) {
				const row = document.createElement("p");
				const name = document.createElement("span");
				name.className = "hint";
				name.textContent = label + ": ";
				row.append(name);
				for (const clone of clones) { row.append(clone, " "); }
				specimen.append(row);
			}
			// Into the pane, not <main>: main is the shell's flex row (rail beside
			// pane), so a child prepended there becomes a third column.
			const pane = document.querySelector("main .pane");
			if (!pane) { throw new Error("no pane to hold the specimen"); }
			pane.prepend(specimen);
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1300, height: 620 },
	clipViewport: true,
};

export default fixture;
