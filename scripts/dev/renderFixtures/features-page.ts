/**
 * The Settings tab's inline-completions and commit-generation rows: both
 * feature groups with their booleans set, the inline model pick backed by a
 * served model (at rest for the dangling geometry pair), the commit model pick
 * DANGLING (its warning covers the description), a custom MULTILINE commit
 * prompt (the auto-growing textarea's at-rest state), and the language filter
 * configured (block mode with a filled list, both rows marked).
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
						...state.settings.featureModels,
						// Served by the base state's prod snapshot: the picker's quiet state.
						inlineCompletions: { server: "prod", model: "gpt-5-mini" },
						// No DECLARED SERVER carries this label: the dangling warning
						// stands (a missing model alone stays quiet - FIM models never
						// list in the chat catalog).
						commitGeneration: { server: "removed-server", model: "claude-4" },
					},
					featureModelScopes: {
						...state.settings.featureModelScopes,
						inlineCompletions: "global",
						commitGeneration: "global",
					},
					// Three lines: the prompt box is a bounded auto-growing textarea, so
					// the fixture prices a MULTILINE value at rest (between the two-row
					// floor and the eight-row scroll ceiling) at every sweep width.
					commitPrompt:
						"Write a Conventional Commits subject under 60 characters.\n" +
						"Then one blank line.\n" +
						"Then a short body explaining why, wrapped at 72 columns.",
					commitPromptScope: "global",
					languageFilter: {
						mode: "block",
						languages: { values: ["markdown", "plaintext"], lossy: false, scope: "global" },
					},
				},
			},
		},
		{ kind: "focusSection", section: "features" },
	],
	viewport: { width: 1300, height: 2400 },
};

export default fixture;
