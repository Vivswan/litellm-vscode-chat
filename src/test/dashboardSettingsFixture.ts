/**
 * The ONE DashboardSettings builder behind every fixture surface: the bun
 * webview fixtures (src/test/bun/webview/fixtures.ts) and the render
 * fixtures' base state (scripts/dev/renderFixtures/shared.ts) both build on
 * it, so a DashboardSettings shape change lands here once instead of drifting
 * between two hand-maintained literals. Defaults mirror package.json's;
 * callers override per test or fixture. Pure data over protocol types - no
 * vscode, no DOM, no runtime imports - so every tsconfig project (root, bun,
 * scripts) can consume it.
 */
import type { DashboardSettings } from "../dashboard/viewModels";

export function makeSettings(overrides: Partial<DashboardSettings> = {}): DashboardSettings {
	return {
		numbers: {
			"chat.timeout": 300000,
			"chat.maxToolsPerRequest": 128,
			"discovery.timeout": 30000,
			"discovery.cacheTtl": 3600000,
			"discovery.staleServeWindow": 600000,
			"usage.pollInterval": 300000,
			"usage.initialRefreshDelay": 5000,
			"usage.serversChangeRefreshDelay": 2000,
			"usage.pollingOffFreshnessWindow": 600000,
		},
		booleans: {
			"chat.promptCaching": true,
			"ui.maskSecretInputs": true,
			"models.openRouterCatalog": true,
			"inlineCompletions.enabled": false,
			"commitGeneration.enabled": false,
		},
		configuredScopes: {
			numbers: {
				"chat.timeout": null,
				"chat.maxToolsPerRequest": null,
				"discovery.timeout": null,
				"discovery.cacheTtl": null,
				"discovery.staleServeWindow": null,
				"usage.pollInterval": null,
				"usage.initialRefreshDelay": null,
				"usage.serversChangeRefreshDelay": null,
				"usage.pollingOffFreshnessWindow": null,
			},
			booleans: {
				"chat.promptCaching": null,
				"ui.maskSecretInputs": null,
				"models.openRouterCatalog": null,
				"inlineCompletions.enabled": null,
				"commitGeneration.enabled": null,
			},
		},
		modelParameters: { editScope: "global", value: {}, otherScopes: [], effective: {} },
		modelCapabilities: { editScope: "global", value: {}, otherScopes: [], effective: {} },
		catalog: { modelCount: 0, lastSuccessAt: undefined, refreshing: false },
		appearance: { theme: "auto", themeScope: null, accent: "blue", accentScope: null },
		chat: {
			tokenEstimation: "auto",
			tokenEstimationScope: null,
			additionalToolSchemaKeywords: [],
			additionalToolSchemaKeywordsLossy: false,
			additionalToolSchemaKeywordsScope: null,
		},
		usage: {
			statusBarMode: "always",
			statusBarScope: null,
			alertThresholds: [0.8, 0.95],
			thresholdsScope: null,
			currencySymbol: "$",
			currencySymbolScope: null,
		},
		featureModels: { inlineCompletions: null, commitGeneration: null },
		featureModelScopes: { inlineCompletions: null, commitGeneration: null },
		commitPrompt: "",
		commitPromptScope: null,
		languageLists: {
			allowedLanguages: { values: [], lossy: false, scope: null },
			blockedLanguages: { values: [], lossy: false, scope: null },
		},
		...overrides,
	};
}
