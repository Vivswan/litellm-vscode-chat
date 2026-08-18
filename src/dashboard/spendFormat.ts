/**
 * The spend vocabulary every surface shares: how money and budget percentages
 * print, and how a spend fraction maps onto the ok/warn/error scale. The
 * row meters, the row diagnostics, the Servers header, and the status bar all
 * read these, so one spend can never print two strings and one fraction can
 * never wear two tones.
 */

import { isUsableThreshold } from "../shared/config/settingSpec";

export type SpendTone = "ok" | "warn" | "error";

/**
 * An amount as every spend surface prints it: the configured currency symbol
 * verbatim (display only, never a conversion; the empty symbol renders the
 * bare number), two decimals below 1000, locale-grouped whole units above.
 */
export function formatMoney(amount: number, currencySymbol: string): string {
	return amount >= 1000
		? `${currencySymbol}${Math.round(amount).toLocaleString()}`
		: `${currencySymbol}${amount.toFixed(2)}`;
}

/** The literal percentage, past 100 included (over-budget shows the real number). */
export function formatPercent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/** The thresholds that participate in the scale: usable per the shared (0, 1] rule, deduplicated and ascending. */
export function usableThresholds(thresholds: readonly number[]): number[] {
	return [...new Set(thresholds.filter(isUsableThreshold))].sort((a, b) => a - b);
}

/**
 * The whole fraction-to-tone map. Past the whole budget is past any threshold:
 * error, even with an empty threshold list. Below that the user's thresholds
 * decide - reaching one counts as crossing it (>=), warn at the lowest, error
 * at the highest, so a single-threshold list goes straight to error.
 */
export function spendTone(fraction: number, thresholds: readonly number[]): SpendTone {
	if (fraction > 1) {
		return "error";
	}
	const usable = usableThresholds(thresholds);
	const lowest = usable[0];
	const highest = usable.at(-1);
	return highest !== undefined && fraction >= highest
		? "error"
		: lowest !== undefined && fraction >= lowest
			? "warn"
			: "ok";
}

/** The meter's fill and tone: the fill clamps at 100%, the tone is spendTone's. */
export function barPresentation(
	fraction: number,
	thresholds: readonly number[]
): { widthPercent: number; tone: SpendTone } {
	return { widthPercent: Math.max(0, Math.min(100, fraction * 100)), tone: spendTone(fraction, thresholds) };
}

/**
 * The worst contributing fraction and its tone - a maximum, deliberately not a
 * total: two entries sharing a key would count its spend twice. The status bar
 * and the Servers header both reduce through this, so the two cannot disagree.
 */
export function worstSpendTone(
	fractions: readonly number[],
	thresholds: readonly number[]
): { readonly worst: number; readonly tone: SpendTone } | undefined {
	if (fractions.length === 0) {
		return undefined;
	}
	const worst = Math.max(...fractions);
	return { worst, tone: spendTone(worst, thresholds) };
}
