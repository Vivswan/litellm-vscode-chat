/**
 * The one allowed-for-language decision for inline completions, shared by the
 * provider's invoke-time filter and the language status row so the two
 * surfaces can never disagree. Exact VS Code language IDs, no globs; the
 * lists arrive normalized (settings.ts's normalizeLanguageList).
 */

/**
 * Whether inline completions run for a language: block beats allow, the empty
 * allow list means every language, and the empty block list blocks none.
 */
export function languageAllowed(languageId: string, allowed: readonly string[], blocked: readonly string[]): boolean {
	if (blocked.includes(languageId)) {
		return false;
	}
	return allowed.length === 0 || allowed.includes(languageId);
}
