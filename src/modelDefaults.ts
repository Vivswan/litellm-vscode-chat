import { findLongestPrefixMatch } from "./utils";

/**
 * A model-specific default parameter entry for codebase-owned defaults.
 */
export interface CodebaseModelDefaultsEntry {
	/**
	 * Model prefix used for longest-prefix matching against runtime model IDs.
	 * Examples: "gpt-5.5", "claude-3", "gemini-2.5"
	 */
	modelPrefix: string;

	/** Request parameters to apply when this model prefix matches. */
	parameters: Record<string, unknown>;
}

/**
 * Top-level shape for codebase-owned model defaults.
 */
export interface CodebaseModelDefaultsConfig {
	/** Fallback parameters when no model-specific entry matches. */
	fallbackParameters: Record<string, unknown>;

	/** Model-specific defaults resolved by longest-prefix matching. */
	entries: CodebaseModelDefaultsEntry[];
}

/**
 * Centralized defaults owned by this codebase.
 *
 * - fallbackParameters applies when no model prefix matches.
 * - entries allow model-specific overrides (including empty objects) when
 *   a model should not receive fallback parameters.
 */
export const CODEBASE_MODEL_DEFAULTS: CodebaseModelDefaultsConfig = {
	fallbackParameters: {
		temperature: 0.7,
	},
	entries: [
		// gpt-5.5 rejects temperature in some provider routes, so do not send it by default.
		{ modelPrefix: "gpt-5.5", parameters: {} },
	],
};

/**
 * Resolve codebase defaults for a model using longest-prefix matching.
 *
 * Matching behavior:
 * 1. Exact match or prefix match against each configured entry
 * 2. Longest matching prefix wins
 * 3. If no entry matches, fallbackParameters are returned
 *
 * A shallow copy is always returned so callers can safely mutate the
 * resolved object for request construction without mutating global defaults.
 *
 * @param modelId Model identifier from the active chat model (for example, "gpt-4:openai").
 * @returns Resolved default parameters for the given model.
 */
export function resolveCodebaseModelDefaults(modelId: string): Record<string, unknown> {
	const longestMatch = findLongestPrefixMatch(CODEBASE_MODEL_DEFAULTS.entries, modelId, (entry) => entry.modelPrefix);

	if (longestMatch) {
		return { ...longestMatch.parameters };
	}

	return { ...CODEBASE_MODEL_DEFAULTS.fallbackParameters };
}
