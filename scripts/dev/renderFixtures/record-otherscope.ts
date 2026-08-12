/**
 * The read-only other-scope table: workspace-scoped records render under the
 * editable global table as the same matcher table without edit affordances -
 * plain chips (flag badges included), no popovers, no add chip, no pencil.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state = baseState();
const workspaceRecords = {
	"gpt-5*": { temperature: 0.5, top_p: 0.95, _force: ["temperature"], _inherit_from: false },
	"*": { seed: 7 },
};

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: {
				...state,
				settings: {
					...state.settings,
					modelParameters: {
						...state.settings.modelParameters,
						otherScopes: [{ scope: "workspace", value: workspaceRecords }],
					},
				},
			},
		},
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 1300, height: 2400 },
	settleMs: 400,
};

export default fixture;
