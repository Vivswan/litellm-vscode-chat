/**
 * Localization guard helpers shared by scripts/l10n/check.ts (layer one of
 * the parity scheme: pre-commit and CI) and the guard suites (layer two:
 * src/test/l10n and the webview help-text guard, so `bun run test` catches
 * drift without the script). They live here rather than in scripts/l10n/lib
 * because the extension-host tsconfig roots at src/ and cannot compile
 * imports from scripts/, while the scripts tsconfig reaches into src/ freely
 * (scripts/dev/dev.ts already does).
 */

/**
 * Banned typography: a fast local subset; the repo-platform check-typography
 * action in CI is authoritative. Fullwidth and halfwidth forms (the halfwidth
 * marks are look-alikes of the sanctioned fullwidth ones, and this scan is
 * the real gate for them), no-break/typographic/ideographic spaces, invisible
 * and bidi controls, soft hyphen, curly quotes, ellipsis, dashes, and the
 * minus/multiplication/division signs. CJK ideographs and the sanctioned CJK
 * punctuation are not in the ranges. Built per call: a shared /g regex would
 * carry lastIndex across .test() callers.
 */
export function bannedTypography(): RegExp {
	return /[\u00A0\u00AD\u00D7\u00F7\u2000-\u200F\u2010-\u2015\u2018-\u201F\u2026\u2028-\u202F\u2060\u2066-\u2069\u2212\u3000\uFEFF\uFF01-\uFF9F\uFFE0-\uFFE6]/gu;
}

/** The multiset of {0}/{1}-style placeholders in one message. */
export function placeholderCounts(message: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const match of message.matchAll(/\{\d+\}/g)) {
		counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
	}
	return counts;
}
