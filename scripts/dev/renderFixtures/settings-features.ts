/**
 * The Settings tab's inline-completions and commit-generation rows: both
 * feature groups with their booleans set, the inline model pick backed by a
 * served model (at rest for the dangling geometry pair), the commit model pick
 * DANGLING (its warning covers the description), a custom commit prompt, and
 * both language lists filled.
 */
import type { RenderFixture } from "../render-dashboard.ts";
import { baseState } from "./shared.ts";

const state = baseState();

const fixture: RenderFixture = {
	messages: [
		{
			kind: "push",
			state: {
				...state,
				settings: {
					...state.settings,
					booleans: {
						...state.settings.booleans,
						"inlineCompletions.enabled": true,
						"commitGeneration.enabled": true,
					},
					configuredScopes: {
						...state.settings.configuredScopes,
						booleans: {
							...state.settings.configuredScopes.booleans,
							"inlineCompletions.enabled": "global",
							"commitGeneration.enabled": "global",
						},
					},
					featureModels: {
						// Served by the base state's prod snapshot: the picker's quiet state.
						inlineCompletions: { server: "prod", model: "gpt-5-mini" },
						// No served model backs this pair: the dangling warning stands.
						commitGeneration: { server: "prod", model: "retired-model" },
					},
					featureModelScopes: { inlineCompletions: "global", commitGeneration: "global" },
					commitPrompt: "Write a Conventional Commits subject under 60 characters.",
					commitPromptScope: "global",
					languageLists: {
						allowedLanguages: { values: ["typescript", "python", "go"], lossy: false, scope: "global" },
						blockedLanguages: { values: ["markdown", "plaintext"], lossy: false, scope: "global" },
					},
				},
			},
		},
		{ kind: "focusSection", section: "settings" },
	],
	viewport: { width: 1300, height: 2400 },
};

export default fixture;
