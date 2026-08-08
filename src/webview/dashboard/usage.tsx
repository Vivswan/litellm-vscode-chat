/**
 * The Usage tab: spend against budget per server, rendered from the pushed
 * DashboardUsage snapshot (numbers, epoch timestamps, and configured identity
 * only - the extension narrowed everything response-derived away before it
 * reached the store). Servers whose LiteLLM instance serves no usage
 * endpoints never appear; when none does, the section says so instead of
 * showing empty charts (docs/usage.md).
 */

import * as l10n from "@vscode/l10n";
import type { DashboardUsage, UsageServerView } from "../../extension/dashboard/protocol";
import { DOCS_LINK_USAGE } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpUsageSection } from "./helpText";
import { relativeTime } from "./time";
import { postMessage } from "./vscodeApi";

/** A dollar amount as the panel prints it; two decimals below $1000, whole dollars above. */
export function formatUsd(amount: number): string {
	return amount >= 1000 ? `$${Math.round(amount).toLocaleString()}` : `$${amount.toFixed(2)}`;
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

function lastUpdatedText(server: UsageServerView, now: number): string {
	if (server.lastUpdatedAt === undefined) {
		return l10n.t("never updated");
	}
	const ago = relativeTime(new Date(server.lastUpdatedAt).toISOString(), now);
	return ago === undefined ? l10n.t("just updated") : l10n.t("last updated {0}", ago);
}

function BudgetLine({ server }: { server: UsageServerView }) {
	if (server.effectiveBudget === undefined) {
		// Spend without a budget: no percentage, no bar - there is nothing to
		// compute a fraction of, and such a server never alerts.
		return (
			<p class="hint">
				{l10n.t("No budget: neither the entry nor the key sets one, so there is no percentage to show.")}
			</p>
		);
	}
	const both =
		server.budgetSource === "entry" && server.keyBudget !== undefined && server.keyBudget !== server.effectiveBudget;
	return (
		<p class="usage-budget-line">
			{l10n.t("budget {0}", formatUsd(server.effectiveBudget))}
			{both ? <span class="hint"> {l10n.t("- key reports {0}", formatUsd(server.keyBudget ?? 0))}</span> : null}
			{server.budgetResetAt !== undefined ? (
				<span class="hint">
					{" "}
					{l10n.t(
						"- resets {0}",
						new Date(server.budgetResetAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
					)}
				</span>
			) : null}
		</p>
	);
}

function UsageCard({
	server,
	thresholds,
	now,
}: {
	server: UsageServerView;
	thresholds: readonly number[];
	now: number;
}) {
	const fraction = server.spentFraction;
	const bar = fraction !== undefined ? barPresentation(fraction, thresholds) : undefined;
	return (
		<div class="usage-card">
			<div class="usage-card-head">
				<span class="usage-label">{server.label}</span>
				<span class="url">{server.baseUrl}</span>
				<span class="spacer" />
				<span class={server.fresh ? "hint" : "hint state-warn"}>
					{server.fresh ? lastUpdatedText(server, now) : `${lastUpdatedText(server, now)} (${l10n.t("stale")})`}
				</span>
			</div>
			<div class="usage-spend-row">
				<span class="usage-spend">
					{server.spend !== undefined ? l10n.t("spent {0}", formatUsd(server.spend)) : l10n.t("spend unknown")}
				</span>
				{fraction !== undefined && bar !== undefined ? (
					<span class={`usage-percent tone-${bar.tone}`}>{formatPercent(fraction)}</span>
				) : null}
			</div>
			{bar !== undefined ? (
				// A plain div rather than <meter>: the native element paints its own
				// UA chrome that ignores the theme tokens, so the bar draws itself
				// and carries the meter semantics via ARIA.
				// biome-ignore lint/a11y/useSemanticElements: <meter> cannot be themed with the VS Code tokens; the ARIA meter role carries the semantics.
				<div
					class="usage-bar"
					role="meter"
					aria-label={l10n.t("Spend against the effective budget for {0}", server.label)}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round((fraction ?? 0) * 100)}
				>
					<div class={`usage-bar-fill tone-${bar.tone}`} style={{ width: `${bar.widthPercent}%` }} />
				</div>
			) : null}
			<BudgetLine server={server} />
			{server.requests !== undefined ? (
				<p class="hint usage-activity">
					{server.requests.total === 1
						? l10n.t("1 request in the last 30 days")
						: l10n.t("{0} requests in the last 30 days", server.requests.total.toLocaleString())}
					{server.requests.successRate !== undefined
						? ` - ${l10n.t("{0} success", formatPercent(server.requests.successRate))}`
						: ""}
					{server.requests.cacheHitRate !== undefined
						? ` - ${l10n.t("{0} cache hits", formatPercent(server.requests.cacheHitRate))}`
						: ""}
				</p>
			) : (
				<p class="hint usage-activity">
					{l10n.t(
						"No request statistics: this server does not serve /user/daily/activity (a normal shape on some setups)."
					)}
				</p>
			)}
		</div>
	);
}

export function UsageSection({
	usage,
	serverCount,
	now,
}: {
	usage: DashboardUsage;
	/** How many servers the dashboard knows at all; distinguishes the two empty states. */
	serverCount: number;
	/** The shared clock tick (one useNow in App). */
	now: number;
}) {
	return (
		<section>
			<h2>
				{l10n.t("Usage")} <Help text={helpUsageSection()} below />
				<DocsLink href={DOCS_LINK_USAGE} label={l10n.t("Open the usage and budgets guide")} />
			</h2>
			<div class="toolbar">
				<button
					type="button"
					class="secondary"
					disabled={usage.refreshing || serverCount === 0}
					onClick={() => postMessage({ type: "refreshUsage" })}
				>
					{usage.refreshing ? (
						<>
							<span class="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
						</>
					) : (
						l10n.t("Refresh now")
					)}
				</button>
				{usage.pollIntervalMs === 0 ? (
					<span class="hint">
						{l10n.t("Background polling is off (usage.pollInterval 0); refresh fetches on demand.")}
					</span>
				) : null}
			</div>
			{/* The data follows the key, not the entry (docs/usage.md#budgets):
			    rotating a credential switches the numbers to the new key's spend,
			    and the panel says so instead of leaving the jump unexplained. */}
			<p class="hint">
				{l10n.t(
					"Spend is the key's server-side total, e.g. rotating an entry's key switches its numbers to the new key's spend."
				)}
			</p>
			{usage.servers.length === 0 ? (
				<div class="empty-block">
					{serverCount === 0 ? (
						<p>{l10n.t("No servers configured; add one under Servers & Models.")}</p>
					) : (
						<>
							<p>{l10n.t("None of your servers serves usage data.")}</p>
							<p class="hint">
								{l10n.t(
									"Spend tracking needs a LiteLLM server with a database (the /key/info endpoint); servers without one simply do not appear here."
								)}
							</p>
						</>
					)}
				</div>
			) : (
				<div class="usage-cards">
					{usage.servers.map((server) => (
						<UsageCard
							key={`${server.label} ${server.baseUrl}`}
							server={server}
							thresholds={usage.thresholds}
							now={now}
						/>
					))}
				</div>
			)}
		</section>
	);
}
