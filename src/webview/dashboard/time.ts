/**
 * Relative-time rendering, rounded to the coarsest unit that still reads as current:
 * the dashboard answers "is this fresh?", not "when exactly?" - Diagnostics carries
 * the precise timestamp. Takes epoch milliseconds, the push's one timestamp
 * vocabulary; absence is the caller's branch, so the render is total.
 */

import * as l10n from "@vscode/l10n";
import { useEffect, useState } from "react";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

export function relativeTime(thenMs: number, nowMs: number): string {
	const seconds = Math.round((nowMs - thenMs) / 1000);
	// Small negative drift (host and webview clocks disagree) reads as now.
	if (seconds < 45) {
		return l10n.t("just now");
	}
	if (seconds < HOUR) {
		return l10n.t("{0} min ago", Math.round(seconds / MINUTE));
	}
	if (seconds < DAY) {
		return l10n.t("{0} h ago", Math.round(seconds / HOUR));
	}
	const days = Math.round(seconds / DAY);
	return days === 1 ? l10n.t("1 day ago") : l10n.t("{0} days ago", days);
}

/**
 * The current time, refreshed on an interval so "2 min ago" does not freeze
 * at whatever the last state push saw. 30 s matches the coarsest step the
 * relative format can actually show moving.
 */
export function useNow(intervalMs = 30000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}
