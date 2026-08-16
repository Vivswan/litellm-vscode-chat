/**
 * Localization guard helpers shared by scripts/l10n/check.ts and the guard
 * suites, so `bun run test` catches drift without the script. They live here
 * rather than in scripts/l10n/lib because the extension-host tsconfig roots at
 * src/ and cannot compile imports from scripts/.
 */

/**
 * Banned typography: a fast local subset; the repo-platform check-typography
 * action in CI is authoritative. This scan is the real gate for the halfwidth
 * look-alikes of the sanctioned fullwidth marks. CJK ideographs and the
 * sanctioned CJK punctuation are not in the ranges. Built per call: a shared
 * /g regex would carry lastIndex across .test() callers.
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
