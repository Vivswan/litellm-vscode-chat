/**
 * The usage status bar item (docs/usage.md#the-status-bar): one number - the
 * worst FRESH server's spend percentage against its effective budget - with
 * the full per-server breakdown in the tooltip and the escalation story in
 * the background color (warning at the lowest configured threshold, error at
 * the highest). Stale servers are dropped from the aggregation rather than
 * presented as current; when nothing fresh remains the item hides entirely.
 *
 * The rendering decision is the pure renderUsageStatus so the unit suite
 * drives every rule without vscode; UsageStatusBar wires it to the store, the
 * settings (read at render time), and a one-shot timer that re-renders at the
 * moment the currently freshest contributing server would go stale, so the
 * item hides on time between polls.
 */

import * as vscode from "vscode";
import type { UsageStatusBarMode } from "../../shared/config/settings";
import type { Clock, Timer } from "../../shared/util/timer";
import { PendingCall, REAL_TIMER, SYSTEM_CLOCK } from "../../shared/util/timer";
import { isUsageFresh, usageFreshnessWindowMs } from "../servers/usage/freshness";
import type { ServerUsageState, UsageStore } from "../servers/usage/store";
import type { StatusItemLike } from "./status";

/**
 * A visible rendering; "hidden" means the item shows nothing at all. The
 * severity scale tops out at the highest configured threshold - it is the
 * alarm.
 */
export interface UsageStatusView {
	readonly text: string;
	readonly severity: "plain" | "warning" | "error";
	readonly tooltipLines: readonly string[];
}

/** The thresholds that participate: finite fractions in (0, 1], deduplicated and ascending. */
function usableThresholds(thresholds: readonly number[]): number[] {
	const usable = thresholds.filter((t) => Number.isFinite(t) && t > 0 && t <= 1);
	return [...new Set(usable)].sort((a, b) => a - b);
}

/** A dollar amount as every usage surface prints it; budgets are USD by contract. */
function money(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/** A spend fraction as the integer percent the item and tooltip show; past 100% the literal number (112%). */
function percentOf(fraction: number): number {
	return Math.round(fraction * 100);
}

/** "Last updated" as a short relative phrase, falling back to the locale string past a day. */
function relativeTime(thenMs: number, nowMs: number): string {
	const elapsed = Math.max(0, nowMs - thenMs);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) {
		return vscode.l10n.t("just now");
	}
	if (minutes < 60) {
		return minutes === 1 ? vscode.l10n.t("1 minute ago") : vscode.l10n.t("{0} minutes ago", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return hours === 1 ? vscode.l10n.t("1 hour ago") : vscode.l10n.t("{0} hours ago", hours);
	}
	return new Date(thenMs).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** The two tooltip lines for one server with spend data; the detail line notes staleness explicitly. */
function serverTooltipLines(state: ServerUsageState, nowMs: number, fresh: boolean): string[] {
	const { budget } = state;
	const spend = budget.spend;
	if (spend === undefined) {
		return [];
	}
	let headline: string;
	if (budget.effectiveBudget !== undefined && budget.spentFraction !== undefined) {
		const percent = percentOf(budget.spentFraction);
		headline =
			budget.keyBudget !== undefined && budget.keyBudget !== budget.effectiveBudget
				? vscode.l10n.t(
						"{0}: {1} of {2} ({3}%) - key reports {4}",
						state.label,
						money(spend),
						money(budget.effectiveBudget),
						percent,
						money(budget.keyBudget)
					)
				: vscode.l10n.t("{0}: {1} of {2} ({3}%)", state.label, money(spend), money(budget.effectiveBudget), percent);
	} else {
		headline = vscode.l10n.t("{0}: {1} spent, no budget", state.label, money(spend));
	}
	const details: string[] = [];
	if (budget.budgetResetAt !== undefined) {
		details.push(
			vscode.l10n.t(
				"resets {0}",
				new Date(budget.budgetResetAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
			)
		);
	}
	if (state.spendUpdatedAt !== undefined) {
		details.push(
			fresh
				? vscode.l10n.t("updated {0}", relativeTime(state.spendUpdatedAt, nowMs))
				: vscode.l10n.t("stale - last updated {0}", relativeTime(state.spendUpdatedAt, nowMs))
		);
	}
	return details.length > 0 ? [headline, `  ${details.join(", ")}`] : [headline];
}

/**
 * The whole rendering decision, pure. Hidden when the mode says so, when no
 * server has fresh data, when no fresh server has a budget to compute a
 * fraction against, and in alerts-only mode while nothing fresh sits at or
 * above the lowest configured threshold (reaching a threshold counts as
 * crossing it). Severity tops out at the highest configured threshold, so a
 * single-threshold list goes straight to the error background; an empty list
 * renders plain forever.
 */
export function renderUsageStatus(
	states: readonly ServerUsageState[],
	nowMs: number,
	pollIntervalMs: number,
	thresholds: readonly number[],
	mode: UsageStatusBarMode
): UsageStatusView | "hidden" {
	if (mode === "off") {
		return "hidden";
	}
	const freshByLabel = new Map(states.map((state) => [state.label, isUsageFresh(state, nowMs, pollIntervalMs)]));
	const contributing = states.filter(
		(state) => freshByLabel.get(state.label) === true && state.budget.spentFraction !== undefined
	);
	const fractions = contributing.map((state) => state.budget.spentFraction ?? 0);
	if (fractions.length === 0) {
		return "hidden";
	}
	const worst = Math.max(...fractions);
	const usable = usableThresholds(thresholds);
	const lowest = usable[0];
	const highest = usable.at(-1);
	const severity: UsageStatusView["severity"] =
		highest !== undefined && worst >= highest ? "error" : lowest !== undefined && worst >= lowest ? "warning" : "plain";
	if (mode === "alerts-only" && severity === "plain") {
		return "hidden";
	}

	const tooltipLines = states.flatMap((state) =>
		serverTooltipLines(state, nowMs, freshByLabel.get(state.label) === true)
	);
	if (lowest !== undefined) {
		// The item's number is one server's ratio; the count keeps the other
		// tripped servers from hiding behind the maximum.
		const overCount = fractions.filter((fraction) => fraction >= lowest).length;
		const others = overCount - (worst >= lowest ? 1 : 0);
		if (others > 0) {
			tooltipLines.push(
				others === 1
					? vscode.l10n.t("1 other server is over an alert threshold")
					: vscode.l10n.t("{0} other servers are over an alert threshold", others)
			);
		}
	}
	return { text: `${percentOf(worst)}%`, severity, tooltipLines };
}

export interface UsageStatusBarOptions {
	readonly store: UsageStore;
	/** The status-bar surface (StatusItem in production); this class owns its disposal. */
	readonly item: StatusItemLike;
	/** Read at render time so a settings edit needs no rebuild. */
	readonly getMode: () => UsageStatusBarMode;
	readonly getThresholds: () => readonly number[];
	readonly getPollIntervalMs: () => number;
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
		const states = this.options.store.getStates();
		const view = renderUsageStatus(states, nowMs, pollIntervalMs, this.options.getThresholds(), this.options.getMode());
		if (view === "hidden") {
			this.options.item.hide();
		} else {
			this.options.item.render({ text: view.text, tooltip: view.tooltipLines.join("\n"), severity: view.severity });
			this.options.item.show();
		}
		this.scheduleStaleEdge(states, nowMs, pollIntervalMs);
	}

	/**
	 * One cheap timer at the moment the earliest contributing server's data
	 * goes stale: without it the item would keep showing (or keep coloring) a
	 * number the freshness rule already disowned until the next store event.
	 */
	private scheduleStaleEdge(states: readonly ServerUsageState[], nowMs: number, pollIntervalMs: number): void {
		const windowMs = usageFreshnessWindowMs(pollIntervalMs);
		const expiries = states
			.filter((state) => isUsageFresh(state, nowMs, pollIntervalMs) && state.budget.spentFraction !== undefined)
			.map((state) => (state.spendUpdatedAt ?? nowMs) + windowMs - nowMs);
		if (expiries.length === 0) {
			return;
		}
		this.staleEdge.arm(() => this.render(), Math.max(0, Math.min(...expiries)));
	}
}
