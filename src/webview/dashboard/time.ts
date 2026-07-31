/**
 * Relative-time rendering for the status pills and the hero's last-sync
 * stamp. Rounded to the coarsest unit that still reads as current ("just
 * now", "5 min ago", "2 h ago"): the dashboard answers "is this fresh?", not
 * "when exactly?" - Show Diagnostics carries the precise timestamps.
 */

import { useEffect, useState } from "preact/hooks";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

export function relativeTime(iso: string, nowMs: number): string | undefined {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) {
		return undefined;
	}
	const seconds = Math.round((nowMs - then) / 1000);
	// Small negative drift (host and webview clocks disagree) reads as now.
	if (seconds < 45) {
		return "just now";
	}
	if (seconds < HOUR) {
		return `${Math.round(seconds / MINUTE)} min ago`;
	}
	if (seconds < DAY) {
		return `${Math.round(seconds / HOUR)} h ago`;
	}
	return `${Math.round(seconds / DAY)} d ago`;
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
