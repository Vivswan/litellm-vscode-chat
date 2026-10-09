import type { DashboardStateInputs, SettingsInspection, SettingsReader } from "../../../extension/dashboard/state";
import { buildDashboardState, EMPTY_CATALOG_STATUS, readDashboardSettings } from "../../../extension/dashboard/state";
import type { DeclaredServerView } from "../../../extension/servers/serverSync/engine";

export function makeDeclared(overrides: Partial<DeclaredServerView> = {}): DeclaredServerView {
	return {
		label: "Prod",
		baseUrl: "http://prod.test",
		secrets: { apiKey: "none", oauthClientSecret: "none", virtualKeyValue: "none" },
		...overrides,
	};
}

/**
 * A SettingsReader over fixture values: `values` back get() and double as the global scope, `defaults` mirror
 * package.json, and `scopes` sets per-scope values explicitly for the scoped-record tests.
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
 * Declared views are wrapped as the ENGINE's (locations proven); the settings-fallback source has its own explicit
 * suite in state.test.ts.
 */
export function buildState(
	snapshots: DashboardStateInputs["snapshots"],
	reader: SettingsReader,
	declared?: readonly DeclaredServerView[],
	removedGroups?: DashboardStateInputs["removedGroups"],
	observation?: Pick<DashboardStateInputs, "wasGroupObserved" | "wasLabeledGroupObserved">
) {
	return buildDashboardState({
		snapshots,
		reader,
		...(declared !== undefined ? { declared: { source: "engine", views: declared } } : {}),
		...(removedGroups !== undefined ? { removedGroups } : {}),
		...observation,
	});
}

export function readSettings(reader: SettingsReader) {
	return readDashboardSettings(reader, EMPTY_CATALOG_STATUS);
}
