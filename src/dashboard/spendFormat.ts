/**
 * The spend vocabulary every surface shares: how money and budget percentages
 * print, how a spend fraction maps onto the ok/warn/error scale, and what a
 * non-fresh figure calls its staleness. The row meters, the row diagnostics,
 * the Servers header, and the status bar all read these, so one spend can
 * never print two strings, one fraction can never wear two tones, and one
 * staleness can never wear two names.
 */

import * as l10n from "@vscode/l10n";
import { isUsableThreshold } from "../shared/config/settingSpec";
import type { UsageEndpointStandingView } from "./viewModels";

export type SpendTone = "ok" | "warn" | "error";

/**
 * What is wrong with a non-fresh spend age, in ONE vocabulary for every
 * surface: the state has one term ("stale", the row marker's word), and the
 * cause replaces it where the /key/info standing knows one. The dashboard's
 * drawer fact and budget band print this verbatim, the status bar tooltip
 * composes its timestamp around it, and the row marker shares the plain
 * "stale" key on purpose (a marker names the state, never the cause), so no
 * surface can name the state differently. Undefined while the data is fresh.
 */
export function stalenessText(fresh: boolean, keyInfo: UsageEndpointStandingView): string | undefined {
	if (fresh) {
		return undefined;
	}
	if (keyInfo.kind === "error") {
		return l10n.t("last refresh failed");
	}
	if (keyInfo.kind === "unavailable" && keyInfo.reason === "forbidden") {
		return l10n.t("usage access denied");
	}
	// Merely old (laptop asleep, polling off): the plain history marker, the row's own word.
	return l10n.t("stale");
}

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

/**
 * The greatest whole percent the fraction has actually reached under the
 * scale's >= comparison, past 100 included (over-budget shows the real
 * number). A floor, never a round: every threshold test is `fraction >=
 * threshold`, so 0.995 must print "99%" beside its ok tone, not a "100%"
 * the fraction never reached. The drawer's request rates (success, cache
 * hit) print through the same floor - a lossy rate can never round up to a
 * clean "100%". Whole percents on purpose - the thresholds are
 * whole-percent-shaped and every consumer is a compact chip, so a decimal
 * would add width without adding truth.
 */
export function formatPercent(fraction: number): string {
	const scaled = Math.floor(fraction * 100);
	if (!Number.isFinite(scaled)) {
		return `${scaled}%`;
	}
	// One bounded step aligns the raw floor with the >= comparison itself:
	// fraction * 100 lands within an ulp of the true product (0.57 * 100 floats
	// to 56.999...), so the floor misses the greatest whole percent with
	// fraction >= percent / 100 by at most one, in either direction.
	const percent = fraction >= (scaled + 1) / 100 ? scaled + 1 : fraction < scaled / 100 ? scaled - 1 : scaled;
	return `${percent}%`;
}

/**
 * A configured trigger point as configured: 0.855 is "85.5%", never a floored
 * "85%". formatPercent serves REACHED quantities compared under >=; this
 * serves the configured values themselves (threshold inputs, alert texts),
 * which have nothing to floor. Twelve significant digits, so float noise
 * trims away and a longer decimal than any threshold needs rounds.
 */
export function formatPercentExact(fraction: number): string {
	return `${Number((fraction * 100).toPrecision(12))}%`;
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
