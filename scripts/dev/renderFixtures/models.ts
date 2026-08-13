/**
 * The Models destination, which is its own page rather than the lower half of
 * the servers view. Enough rows to cross the windowing threshold, so the shot
 * covers the virtualized path (spacer rows, sticky header) and not just the
 * simple one, plus a declared model and an unpriced row.
 */
import type { DashboardModel } from "../../../src/dashboard/viewModels.ts";
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState, GATEWAY_SERVER, MODELS, PROD_SERVER } from "./shared.ts";

/** Past WINDOW_THRESHOLD (50), so the table renders windowed. */
const FILLER: readonly DashboardModel[] = Array.from({ length: 60 }, (_, index) => {
	const base = MODELS[index % MODELS.length] as DashboardModel;
	const suffix = String(index).padStart(2, "0");
	return {
		...base,
		id: `${base.id}-${suffix}`,
		rawId: `${base.rawId}-${suffix}`,
		name: `${base.name} ${suffix}`,
	};
});

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: baseState({
				servers: [PROD_SERVER, GATEWAY_SERVER],
				models: [...MODELS, ...FILLER],
			}),
		},
		{ kind: "focusSection", section: "models" },
	],
	viewport: { width: 1300, height: 1000 },
};

export default fixture;
