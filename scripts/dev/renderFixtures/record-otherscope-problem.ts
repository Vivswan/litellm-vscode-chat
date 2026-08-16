/**
 * A read-only other-scope frame with a standing problem: the workspace record
 * stores a `_force` value the directive grammar rejects, so the frame mounts
 * its footer-position message row - the editors' status slot, message alone -
 * under the plain chips, naming the matcher and the problem.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state = baseState();
const workspaceRecords = {
	"gpt-5*": { temperature: 0.5, _force: "yes" },
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
