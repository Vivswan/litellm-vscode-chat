/**
 * The verdict rows a fixture state publishes for its server rows, shared by the bun webview fixtures
 * (src/test/bun/webview/fixtures.ts) and the render fixtures' base state (scripts/dev/renderFixtures/shared.ts) so the
 * fixture-to-verdict conversion lives once. Pure data over protocol types - no vscode, no DOM, no runtime imports - so
 * every tsconfig project (root, bun, scripts) can consume it.
 *
 *   one row per server row -> the hidden-group rows, which have no server row, are the caller's to add
 *   the builder's rules  -> expectedness, the refused-entry flag, and the English error text ride along
 */
import type { DashboardServer, VerdictRow } from "../dashboard/viewModels";

export function verdictRowsOf(servers: readonly DashboardServer[]): VerdictRow[] {
	return servers.map((server) => ({
		state: server.state,
		servedModelCount: server.servedModelCount,
		...(server.expected === true ? { expected: true } : {}),
		...(server.origin === "misconfigured" ? { misconfigured: true } : {}),
		...(server.state === "error" ? { failure: { cause: server.cause, baseUrl: server.baseUrl } } : {}),
	}));
}
