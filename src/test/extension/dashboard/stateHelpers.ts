/**
 * Shared fixtures for the dashboard state suites: a declared-server view, a
 * SettingsReader over fixture values, and buildDashboardState in the positional
 * shorthand the suites were written against.
 */
import type { DashboardStateInputs, SettingsInspection, SettingsReader } from "../../../extension/dashboard/state";
import { buildDashboardState, EMPTY_CATALOG_STATUS, readDashboardSettings } from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync";

/** A declared-server view with every secret absent; overrides fill in the specifics. */
export function makeDeclared(overrides: Partial<DeclaredServerView> = {}): DeclaredServerView {
	return {
		label: "Prod",
		baseUrl: "http://prod.test",
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		...overrides,
	};
}

/**
 * A SettingsReader over fixture values: `values` back get() and double as the
 * global scope, `defaults` mirror package.json, and `scopes` sets per-scope
 * values explicitly for the scoped-record tests.
 */
export function makeReader(
	values: Record<string, unknown>,
	defaults: Record<string, unknown> = {},
	scopes: Record<string, Omit<SettingsInspection, "defaultValue">> = {}
): SettingsReader {
	return {
		get: (key) => values[key],
		inspect: (key) => ({
			defaultValue: defaults[key],
			...(Object.hasOwn(values, key) ? { globalValue: values[key] } : {}),
			...scopes[key],
		}),
	};
}

/**
 * buildDashboardState in the positional shorthand these suites were written
 * against; inputs it does not cover (entryReports, catalog, usage, diagnostics)
 * go through buildDashboardState's options object directly. Declared views are
 * wrapped as the ENGINE's (locations proven); the settings-fallback source has
 * its own explicit suite in state.test.ts.
 */
export function buildState(
	snapshots: DashboardStateInputs["snapshots"],
	reader: SettingsReader,
	declared?: readonly DeclaredServerView[],
	removedGroups?: DashboardStateInputs["removedGroups"]
) {
	return buildDashboardState({
		snapshots,
		reader,
		...(declared !== undefined ? { declared: { source: "engine", views: declared } } : {}),
		...(removedGroups !== undefined ? { removedGroups } : {}),
	});
}

/** readDashboardSettings with the empty catalog status; the catalog row has its own coverage elsewhere. */
export function readSettings(reader: SettingsReader) {
	return readDashboardSettings(reader, EMPTY_CATALOG_STATUS);
}
