/**
 * The one allowed-for-language decision for inline completions, shared by the provider's invoke-time filter and the
 * language status row so the two surfaces can never disagree. Exact VS Code language IDs, no globs; the filter arrives
 * normalized (settings.ts's normalizeInlineLanguageFilter).
 */

import type { InlineLanguageFilter } from "../../../shared/config/settingSpec";

export function languageAllowed(languageId: string, filter: InlineLanguageFilter): boolean {
	return filter.mode === "block" ? !filter.languages.includes(languageId) : filter.languages.includes(languageId);
}
