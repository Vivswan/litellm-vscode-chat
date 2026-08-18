/**
 * The usage status bar item: one number - the worst FRESH server's spend
 * percentage against its effective budget - with the per-server breakdown in
 * the tooltip and the escalation in the background color (warning at the lowest
 * configured threshold, error at the highest). Stale servers drop out of the
 * aggregation rather than being presented as current; when nothing fresh
 * remains the item hides.
 *
 * The rendering decision is the pure renderUsageStatus so the unit suite drives
 * every rule without vscode; UsageStatusBar wires it to the store, the settings
 * (read at render time), and a one-shot timer that re-renders when the freshest
 * contributing server would go stale.
 */

import * as l10n from "@vscode/l10n";
import type * as vscode from "vscode";
import type { SpendTone } from "../../dashboard/spendFormat";
import {
	formatMoney,
	formatPercent,
	stalenessText,
	usableThresholds,
	worstSpendTone,
} from "../../dashboard/spendFormat";
import type { UsageStatusBarMode } from "../../shared/config/settings";
import type { Clock, Timer } from "../../shared/util/timer";
import { PendingCall, REAL_TIMER, SYSTEM_CLOCK } from "../../shared/util/timer";
import { isUsageFresh, usageFreshnessWindowMs } from "../servers/usage/freshness";
import type { ServerUsageState, UsageStore } from "../servers/usage/store";
import type { StatusItemLike } from "./status";

/** A visible rendering; "hidden" means the item shows nothing. Severity follows the shared spend tone map. */
export interface UsageStatusView {
	readonly text: string;
	readonly severity: "plain" | "warning" | "error";
	readonly tooltipLines: readonly string[];
}

/** The status bar's embodiment of the shared spend tones: ok is the plain background. */
const SEVERITY_BY_TONE: Readonly<Record<SpendTone, UsageStatusView["severity"]>> = {
	ok: "plain",
	warn: "warning",
	error: "error",
};

/** "Last updated" as a short relative phrase, falling back to the locale string past a day. */
function relativeTime(thenMs: number, nowMs: number): string {
	const elapsed = Math.max(0, nowMs - thenMs);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) {
		return l10n.t("just now");
	}
	if (minutes < 60) {
		return minutes === 1 ? l10n.t("1 minute ago") : l10n.t("{0} minutes ago", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return hours === 1 ? l10n.t("1 hour ago") : l10n.t("{0} hours ago", hours);
	}
	return new Date(thenMs).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * The two tooltip lines for one server with spend data; a non-fresh detail
 * line names its staleness through the shared vocabulary (stalenessText), so
 * the tooltip and the dashboard cannot call the same cause different things.
 */
function serverTooltipLines(state: ServerUsageState, nowMs: number, fresh: boolean, currencySymbol: string): string[] {
	const { budget } = state;
	const spend = budget.spend;
	if (spend === undefined) {
		return [];
	}
	let headline: string;
	if (budget.effectiveBudget !== undefined && budget.spentFraction !== undefined) {
		const percent = formatPercent(budget.spentFraction);
		headline =
			budget.keyBudget !== undefined && budget.keyBudget !== budget.effectiveBudget
				? l10n.t(
						"{0}: {1} of {2} ({3}) - key reports {4}",
						state.label,
						formatMoney(spend, currencySymbol),
						formatMoney(budget.effectiveBudget, currencySymbol),
						percent,
						formatMoney(budget.keyBudget, currencySymbol)
					)
				: l10n.t(
						"{0}: {1} of {2} ({3})",
						state.label,
						formatMoney(spend, currencySymbol),
						formatMoney(budget.effectiveBudget, currencySymbol),
						percent
					);
	} else {
		headline = l10n.t("{0}: {1} spent, no budget", state.label, formatMoney(spend, currencySymbol));
	}
	const details: string[] = [];
	if (budget.budgetResetAt !== undefined) {
		details.push(
			l10n.t(
				"resets {0}",
				new Date(budget.budgetResetAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
			)
		);
	}
	if (state.spendUpdatedAt !== undefined) {
		const staleness = stalenessText(fresh, state.endpoints.keyInfo);
		details.push(
			staleness === undefined
				? l10n.t("updated {0}", relativeTime(state.spendUpdatedAt, nowMs))
				: l10n.t("{0} - last updated {1}", staleness, relativeTime(state.spendUpdatedAt, nowMs))
		);
	}
	return details.length > 0 ? [headline, `  ${details.join(", ")}`] : [headline];
}

/**
 * The whole rendering decision, pure. Hidden when the mode says so, when no
 * server has fresh data, when no fresh server has a budget to compute a
 * fraction against, and in alerts-only mode while the shared spend tone reads
 * ok. The severity is the shared fraction-to-tone map (src/dashboard's
 * spendTone via worstSpendTone): warning at the lowest usable threshold, error
 * at the highest - so a single-threshold list goes straight to the error
 * background - and past the whole budget error even with an empty threshold
 * list; an empty list otherwise renders plain.
 */
export function renderUsageStatus(
	states: readonly ServerUsageState[],
	nowMs: number,
	pollIntervalMs: number,
	pollingOffWindowMs: number,
	thresholds: readonly number[],
	mode: UsageStatusBarMode,
	currencySymbol: string
): UsageStatusView | "hidden" {
	if (mode === "off") {
		return "hidden";
	}
	const freshByLabel = new Map(
		states.map((state) => [state.label, isUsageFresh(state, nowMs, pollIntervalMs, pollingOffWindowMs)])
	);
	const contributing = states.filter(
		(state) => freshByLabel.get(state.label) === true && state.budget.spentFraction !== undefined
	);
	const fractions = contributing.map((state) => state.budget.spentFraction ?? 0);
	const position = worstSpendTone(fractions, thresholds);
	if (position === undefined) {
		return "hidden";
	}
	const severity = SEVERITY_BY_TONE[position.tone];
	if (mode === "alerts-only" && severity === "plain") {
		return "hidden";
	}

	const tooltipLines = states.flatMap((state) =>
		serverTooltipLines(state, nowMs, freshByLabel.get(state.label) === true, currencySymbol)
	);
	const lowest = usableThresholds(thresholds)[0];
	// The item's number is one server's ratio; the count keeps the other
	// tripped servers from hiding behind the maximum. Over-budget is its own
	// state, not a threshold crossing: it counts even with no thresholds,
	// matching the shared tone map's past-100%-is-error rule.
	const tripped = (fraction: number) => fraction > 1 || (lowest !== undefined && fraction >= lowest);
	const others = fractions.filter(tripped).length - (tripped(position.worst) ? 1 : 0);
	if (others > 0) {
		tooltipLines.push(
			others === 1
				? l10n.t("1 other server is over an alert threshold")
				: l10n.t("{0} other servers are over an alert threshold", others)
		);
	}
	return { text: formatPercent(position.worst), severity, tooltipLines };
}

export interface UsageStatusBarOptions {
	readonly store: UsageStore;
	/** The status-bar surface (StatusItem in production); this class owns its disposal. */
	readonly item: StatusItemLike;
	/** Read at render time so a settings edit needs no rebuild. */
	readonly getMode: () => UsageStatusBarMode;
	readonly getThresholds: () => readonly number[];
	readonly getPollIntervalMs: () => number;
	/** The usage.pollingOffFreshnessWindow setting: the freshness window while polling is off. */
	readonly getPollingOffWindowMs: () => number;
	readonly getCurrencySymbol: () => string;
	readonly clock?: Clock;
	readonly timer?: Timer;
}

export class UsageStatusBar implements vscode.Disposable {
	private readonly subscription: { dispose(): void };
	private readonly clock: Clock;
	private readonly staleEdge: PendingCall;
	private disposed = false;

	constructor(private readonly options: UsageStatusBarOptions) {
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.staleEdge = new PendingCall(options.timer ?? REAL_TIMER);
		this.subscription = options.store.onDidChange(() => this.render());
		// If the slot registry's self-heal disposes the item out from under us,
		// tear the owner down too: otherwise the store subscription and the
		// stale-edge timer keep firing renders at a dead surface forever.
		options.item.onDidDispose?.(() => this.dispose());
		this.render();
	}

	/** Re-render after a usage.statusBar / usage.alertThresholds / usage.pollInterval change. */
	applyConfiguration(): void {
		this.render();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.staleEdge.cancel();
		this.subscription.dispose();
		this.options.item.dispose();
	}

	private render(): void {
		if (this.disposed) {
			return;
		}
		this.staleEdge.cancel();
		const nowMs = this.clock.now();
		const pollIntervalMs = this.options.getPollIntervalMs();
		const pollingOffWindowMs = this.options.getPollingOffWindowMs();
		const states = this.options.store.getStates();
		const view = renderUsageStatus(
			states,
			nowMs,
			pollIntervalMs,
			pollingOffWindowMs,
			this.options.getThresholds(),
			this.options.getMode(),
			this.options.getCurrencySymbol()
		);
		if (view === "hidden") {
			this.options.item.hide();
		} else {
			this.options.item.render({ text: view.text, tooltip: view.tooltipLines.join("\n"), severity: view.severity });
			this.options.item.show();
		}
		this.scheduleStaleEdge(states, nowMs, pollIntervalMs, pollingOffWindowMs);
	}

	/**
	 * One cheap timer at the moment the earliest contributing server's data goes
	 * stale: without it the item would keep showing a number the freshness rule
	 * already disowned until the next store event.
	 */
	private scheduleStaleEdge(
		states: readonly ServerUsageState[],
		nowMs: number,
		pollIntervalMs: number,
		pollingOffWindowMs: number
	): void {
		const windowMs = usageFreshnessWindowMs(pollIntervalMs, pollingOffWindowMs);
		const expiries = states
			.filter(
				(state) =>
					isUsageFresh(state, nowMs, pollIntervalMs, pollingOffWindowMs) && state.budget.spentFraction !== undefined
			)
			.map((state) => (state.spendUpdatedAt ?? nowMs) + windowMs - nowMs);
		if (expiries.length === 0) {
			return;
		}
		this.staleEdge.arm(() => this.render(), Math.max(0, Math.min(...expiries)));
	}
}
