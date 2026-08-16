/**
 * The spend vocabulary every surface shares: how money and budget percentages
 * print, and how a spend fraction maps onto the ok/warn/error scale. Pure
 * functions and class-name tables only - the rail, the server rows, and the
 * status-bar mirror tests all read these, so the same fraction can never wear
 * two different tones on one page.
 */

/**
 * An amount as the dashboard prints it: the configured currency symbol
 * verbatim (display only, never a conversion; the empty symbol renders the
 * bare number), two decimals below 1000, whole units above.
 */
export function formatMoney(amount: number, currencySymbol: string): string {
	return amount >= 1000
		? `${currencySymbol}${Math.round(amount).toLocaleString()}`
		: `${currencySymbol}${amount.toFixed(2)}`;
}

/** The literal percentage, past 100 included (Q3: over-budget shows the real number). */
export function formatPercent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/** The bar's fill and tone: fills at 100%, warning past the lowest threshold, error past the highest. */
export function barPresentation(
	fraction: number,
	thresholds: readonly number[]
): { widthPercent: number; tone: "ok" | "warn" | "error" } {
	const widthPercent = Math.max(0, Math.min(100, fraction * 100));
	if (thresholds.length === 0) {
		return { widthPercent, tone: "ok" };
	}
	const lowest = thresholds[0] ?? 1;
	const highest = thresholds[thresholds.length - 1] ?? 1;
	// Reaching a threshold counts as crossing it (Q3: >=).
	const tone = fraction >= highest ? "error" : fraction >= lowest ? "warn" : "ok";
	return { widthPercent, tone };
}

/** The severity a tone paints text with; the meter fill reads the same scale. */
export const TONE_TEXT: Readonly<Record<"ok" | "warn" | "error", string>> = {
	ok: "text-ok",
	warn: "text-warn",
	error: "text-err",
};

/**
 * The meter's fill takes the fill tier: a bar is a shape (3:1), a word must clear AA.
 * Both tiers move only on light surfaces, where the raw hues were tuned for a dark
 * editor (healthy green measured 2.0:1 on light). The `-fill` names are explicit on
 * purpose: `bg-ok` still compiles and would paint the meter in the text colour.
 */
export const TONE_FILL: Readonly<Record<"ok" | "warn" | "error", string>> = {
	ok: "bg-ok-fill",
	warn: "bg-warn-fill",
	error: "bg-err-fill",
};
