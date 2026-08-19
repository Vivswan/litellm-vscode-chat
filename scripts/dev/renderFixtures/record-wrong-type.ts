/**
 * Wrong-record-type directives on both editors: the parameters record's gpt-5*
 * group carries `_openrouter_model` (a capabilities directive) and the
 * capabilities record's `*` group carries `_force` (a parameters directive), so
 * both chips wear the "ignored" badge; the gpt-5* matcher editor is opened so
 * the same badge also shows in the overlay's directive-flag cell.
 */
import type { DashboardState } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

function wrongTypeState(): DashboardState {
	const base = baseState();
	const params = {
		"*": { temperature: 0.7, top_p: 0.9, _inheritable: true },
		"gpt-5*": { temperature: 0.3, _force: ["temperature"], _openrouter_model: "openai/gpt-5" },
	};
	const caps = {
		"*": { context_length: 131072, _fallback: ["context_length"], _force: ["temperature"] },
	};
	return {
		...base,
		settings: {
			...base.settings,
			modelParameters: { editScope: "global", value: params, otherScopes: [], effective: params },
			modelCapabilities: { editScope: "global", value: caps, otherScopes: [], effective: caps },
		},
	};
}

const fixture: RenderFixture = {
	messages: [
		{ kind: "push", state: wrongTypeState() },
		{ kind: "focusSection", section: "settings" },
	],
	steps: [
		`(() => {
			const badges = [...document.querySelectorAll(".record-frame .chip-flag-ignored")];
			if (badges.length !== 2) { throw new Error("expected two ignored chip badges, got " + badges.length); }
			const opener = [...document.querySelectorAll("button")]
				.find((button) => button.getAttribute("aria-label") === 'Open the full editor for "gpt-5*"');
			if (opener === undefined) { throw new Error('no full-editor opener for "gpt-5*"'); }
			opener.click();
		})()`,
		`(() => {
			if (document.querySelector(".matcher-editor .row .directive-flag .chip-flag-ignored") === null) {
				throw new Error("no ignored badge in the matcher editor's flag cell");
			}
			window.scrollTo(0, 0);
		})()`,
	],
	viewport: { width: 1800, height: 1100 },
	settleMs: 400,
};

export default fixture;
