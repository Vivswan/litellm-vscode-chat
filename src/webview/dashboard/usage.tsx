/**
 * The Usage tab: spend against budget per server, rendered from the pushed
 * DashboardUsage snapshot (numbers, epoch timestamps, configured identity,
 * and closed endpoint-standing enums only - the extension narrowed everything
 * response-derived away before it reached the store). Servers whose LiteLLM
 * instance serves no usage endpoints never appear; a server a refused key
 * (401/403) leaves without readable usage gets a reduced card naming the
 * block instead - forbidden is fixable, unsupported is not. When no server
 * surfaces at all, the section says so instead of showing empty charts
 * (docs/usage.md).
 *
 * Failure rendering is two-part: a localized human headline (what happened,
 * what to do) plus a compact English detail line built from the standing's
 * enums (endpoint path, HTTP status, fixed vocabulary). The detail stays
 * English on purpose: users paste it into GitHub issues, and every term is
 * protocol vocabulary. Nothing here may ever interpolate server-derived text.
 */

import * as l10n from "@vscode/l10n";
import type {
	DashboardUsage,
	UsageEndpointStandingView,
	UsageForbiddenServerView,
	UsageServerView,
} from "../../dashboard/viewModels";
import { DOCS_LINK_USAGE } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpUsageSection } from "./helpText";
import { relativeTime } from "./time";
import { sendRequest } from "./vscodeApi";

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

/**
 * The card head's freshness slot. Never-loaded spend gets a reasoned headline
 * per the /key/info standing instead of the old self-contradictory "never
 * updated (stale)"; a stale age keeps the docs-quoted "last updated {age}"
 * phrase and extends the marker with the cause when the standing knows one.
 * Every branch is one whole l10n literal so extraction sees full sentences.
 */
function lastUpdatedText(server: UsageServerView, now: number): string {
	if (server.lastUpdatedAt === undefined) {
		if (server.keyInfo.kind === "unavailable") {
			return server.keyInfo.reason === "forbidden"
				? l10n.t("This key isn't allowed to read its spend.")
				: l10n.t("This server doesn't report spend.");
		}
		return l10n.t("Spend hasn't loaded for this server yet.");
	}
	const ago = relativeTime(new Date(server.lastUpdatedAt).toISOString(), now);
	if (ago === undefined) {
		return l10n.t("just updated");
	}
	if (server.fresh) {
		return l10n.t("last updated {0}", ago);
	}
	if (server.keyInfo.kind === "error") {
		return l10n.t("last updated {0} - last refresh failed", ago);
	}
	if (server.keyInfo.kind === "unavailable" && server.keyInfo.reason === "forbidden") {
		return l10n.t("last updated {0} - usage access denied", ago);
	}
	// Merely old (laptop asleep, polling off): the plain history marker.
	return l10n.t("last updated {0} (stale)", ago);
}

/**
 * The spend slot when /key/info gave no spend number: why, and what unblocks
 * it, branched on the standing (a forbidden key, a transient failure, and a
 * server that simply omits the field must not render identically). Undefined
 * when the card head already carries the same sentence - the never-fetched
 * "unknown" standing - so the card never repeats itself word for word.
 */
function spendUnknownText(server: UsageServerView, pollingOff: boolean): string | undefined {
	switch (server.keyInfo.kind) {
		case "unavailable":
			return server.keyInfo.reason === "forbidden"
				? l10n.t(
						"This key can't read its own spend. Ask whoever issued it to allow /key/info, then use Refresh now - the extension won't re-check on its own."
					)
				: l10n.t("This server doesn't report spend for this key.");
		case "ok":
			return l10n.t("This server doesn't report spend for this key.");
		case "unknown":
			return server.lastUpdatedAt === undefined ? undefined : l10n.t("Spend hasn't loaded for this server yet.");
		case "error":
			return pollingOff
				? l10n.t("Spend hasn't loaded yet - the last check failed; use Refresh now to try again.")
				: l10n.t("Spend hasn't loaded yet - the last check failed; it retries automatically with increasing delay.");
	}
}

/**
 * The one English template for a forbidden endpoint standing; every card
 * shape prints this same line so pasted issue reports stay uniform.
 */
function forbiddenLine(path: string, status: number | undefined): string {
	return `LiteLLM ${path}:${status !== undefined ? ` HTTP ${status} -` : ""} this key may not read usage data; Refresh now re-probes`;
}

/**
 * The compact technical detail for the /key/info standing, undefined when
 * there is nothing wrong (or the data is merely old). English by policy:
 * users paste these lines into issue reports, and every term is protocol
 * vocabulary - endpoint path, HTTP status, setting ID. Built from closed
 * enums and numbers only; response text never exists here by construction.
 */
function keyInfoDetail(server: UsageServerView, pollingOff: boolean, discoveryTimeoutMs: number): string | undefined {
	const standing = server.keyInfo;
	const retry = pollingOff ? "use Refresh now to retry" : "retries with increasing delay";
	switch (standing.kind) {
		case "ok":
			return server.spend === undefined ? "LiteLLM /key/info: OK, no spend field" : undefined;
		case "unknown":
			return server.spend === undefined ? "LiteLLM /key/info: waiting on the first fetch" : undefined;
		case "unavailable":
			return standing.reason === "forbidden"
				? forbiddenLine("/key/info", standing.status)
				: `LiteLLM /key/info: not served on this server${
						standing.status !== undefined ? ` (HTTP ${standing.status})` : ""
					}; request stats still update`;
		case "error": {
			if (standing.classification === "timeout") {
				return `LiteLLM /key/info: timed out after ${discoveryTimeoutMs}ms (whole-call bound incl. retries); ${retry}. If the server is just slow, raise the discovery.timeout setting.`;
			}
			const how =
				standing.status !== undefined
					? `HTTP ${standing.status}`
					: standing.classification === "network"
						? "network error"
						: "request failed";
			return `LiteLLM /key/info: ${how} on the last attempt; ${retry}`;
		}
	}
}

/** The /user/daily/activity detail line, same English-template rules as keyInfoDetail. */
function activityDetail(server: UsageServerView): string | undefined {
	const standing = server.dailyActivity;
	switch (standing.kind) {
		case "ok":
		case "unknown":
			return undefined;
		case "unavailable":
			// Unsupported needs no detail: the headline's parenthetical covers it.
			return standing.reason === "forbidden" ? forbiddenLine("/user/daily/activity", standing.status) : undefined;
		case "error": {
			const how =
				standing.status !== undefined
					? `HTTP ${standing.status}`
					: standing.classification === "timeout"
						? "timed out"
						: standing.classification === "network"
							? "network error"
							: "request failed";
			return `LiteLLM /user/daily/activity: ${how}`;
		}
	}
}

/**
 * The requests slot when /user/daily/activity has no retained window: the
 * permanent shapes keep their own sentences (unsupported stays the documented
 * normal-shape note; forbidden names the fix), and everything else is the
 * transient couldn't-fetch-yet line.
 */
function requestsMissingText(server: UsageServerView): string {
	if (server.dailyActivity.kind === "unavailable") {
		return server.dailyActivity.reason === "forbidden"
			? l10n.t(
					"This key isn't allowed to read request statistics on this server. After the key's permissions change, use Refresh now to re-check."
				)
			: l10n.t(
					"No request statistics: this server does not serve /user/daily/activity (a normal shape on some setups)."
				);
	}
	return l10n.t("Request statistics couldn't be fetched yet - retries on the next refresh.");
}

/**
 * The forbidden card's English detail line for one endpoint standing:
 * the shared forbidden template for the refused endpoint, the not-served
 * note for an unsupported partner (so a mixed 404-plus-403 server states
 * both facts), undefined otherwise. Same policy as keyInfoDetail: English
 * protocol vocabulary users paste into issue reports, built from closed
 * enums and the status number only.
 */
function forbiddenCardDetail(path: string, standing: UsageEndpointStandingView): string | undefined {
	if (standing.kind !== "unavailable") {
		return undefined;
	}
	return standing.reason === "forbidden"
		? forbiddenLine(path, standing.status)
		: `LiteLLM ${path}: not served on this server${standing.status !== undefined ? ` (HTTP ${standing.status})` : ""}`;
}

/**
 * The reduced card for a server a refused key (401/403) leaves without any
 * readable usage: the localized headline says what happened and what
 * unblocks it, the dimmed English lines carry the endpoint standings. No
 * spend bar, no budget line - there are no numbers to show, and faking a
 * zero would misread as data.
 */
function ForbiddenUsageCard({ server }: { server: UsageForbiddenServerView }) {
	const details = [
		forbiddenCardDetail("/key/info", server.keyInfo),
		forbiddenCardDetail("/user/daily/activity", server.dailyActivity),
	].filter((detail): detail is string => detail !== undefined);
	return (
		<div className="usage-card">
			<div className="usage-card-head">
				<span className="usage-label">{server.label}</span>
				<span className="url">{server.baseUrl}</span>
				<span className="spacer" />
				<span className="hint state-warn">{l10n.t("usage unavailable")}</span>
			</div>
			<p>{l10n.t("Usage unavailable: this key isn't allowed to read its usage.")}</p>
			<p className="hint">
				{l10n.t(
					"Ask whoever issued the key to allow reading its own usage, then use Refresh now - the extension won't re-check on its own."
				)}
			</p>
			{details.map((detail) => (
				<p key={detail} className="hint usage-detail">
					{detail}
				</p>
			))}
		</div>
	);
}

function BudgetLine({ server }: { server: UsageServerView }) {
	if (server.effectiveBudget === undefined) {
		// Spend without a budget: no percentage, no bar - there is nothing to
		// compute a fraction of, and such a server never alerts.
		return (
			<p className="hint">
				{l10n.t("No budget: neither the entry nor the key sets one, so there is no percentage to show.")}
			</p>
		);
	}
	const both =
		server.budgetSource === "entry" && server.keyBudget !== undefined && server.keyBudget !== server.effectiveBudget;
	return (
		<p className="usage-budget-line">
			{l10n.t("budget {0}", formatUsd(server.effectiveBudget))}
			{both ? <span className="hint"> {l10n.t("- key reports {0}", formatUsd(server.keyBudget ?? 0))}</span> : null}
			{server.budgetResetAt !== undefined ? (
				<span className="hint">
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
	pollingOff,
	discoveryTimeoutMs,
	now,
}: {
	server: UsageServerView;
	thresholds: readonly number[];
	/** Whether background polling is off (usage.pollInterval 0); retry hints name Refresh now instead of the automatic retry. */
	pollingOff: boolean;
	/** The effective discovery.timeout; the timeout detail line prints it. */
	discoveryTimeoutMs: number;
	now: number;
}) {
	const fraction = server.spentFraction;
	const bar = fraction !== undefined ? barPresentation(fraction, thresholds) : undefined;
	const spendDetail = keyInfoDetail(server, pollingOff, discoveryTimeoutMs);
	// Retained statistics from a failing endpoint must not read as current:
	// spend freshness (the head marker) says nothing about the activity window.
	// "unknown" stays unmarked - a re-probe is pending, nothing failed yet.
	const statsOutdated =
		server.requests !== undefined &&
		(server.dailyActivity.kind === "error" || server.dailyActivity.kind === "unavailable");
	const requestsDetail = server.requests === undefined || statsOutdated ? activityDetail(server) : undefined;
	return (
		<div className="usage-card">
			<div className="usage-card-head">
				<span className="usage-label">{server.label}</span>
				<span className="url">{server.baseUrl}</span>
				<span className="spacer" />
				<span className={server.fresh ? "hint" : "hint state-warn"}>{lastUpdatedText(server, now)}</span>
			</div>
			<div className="usage-spend-row">
				<span className="usage-spend">
					{server.spend !== undefined
						? l10n.t("spent {0}", formatUsd(server.spend))
						: spendUnknownText(server, pollingOff)}
				</span>
				{fraction !== undefined && bar !== undefined ? (
					<span className={`usage-percent tone-${bar.tone}`}>{formatPercent(fraction)}</span>
				) : null}
			</div>
			{spendDetail !== undefined ? <p className="hint usage-detail">{spendDetail}</p> : null}
			{bar !== undefined ? (
				// A plain div rather than <meter>: the native element paints its own
				// UA chrome that ignores the theme tokens, so the bar draws itself
				// and carries the meter semantics via ARIA.
				// biome-ignore lint/a11y/useSemanticElements: <meter> cannot be themed with the VS Code tokens; the ARIA meter role carries the semantics.
				<div
					className="usage-bar"
					role="meter"
					aria-label={l10n.t("Spend against the effective budget for {0}", server.label)}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round((fraction ?? 0) * 100)}
				>
					<div className={`usage-bar-fill tone-${bar.tone}`} style={{ width: `${bar.widthPercent}%` }} />
				</div>
			) : null}
			<BudgetLine server={server} />
			{server.requests !== undefined ? (
				<>
					<p className={statsOutdated ? "hint state-warn usage-activity" : "hint usage-activity"}>
						{server.requests.total === 1
							? l10n.t("1 request in the last 30 days")
							: l10n.t("{0} requests in the last 30 days", server.requests.total.toLocaleString())}
						{server.requests.successRate !== undefined
							? ` - ${l10n.t("{0} success", formatPercent(server.requests.successRate))}`
							: ""}
						{server.requests.cacheHitRate !== undefined
							? ` - ${l10n.t("{0} cache hits", formatPercent(server.requests.cacheHitRate))}`
							: ""}
						{statsOutdated ? ` - ${l10n.t("may be outdated: the last statistics fetch failed")}` : ""}
					</p>
					{requestsDetail !== undefined ? <p className="hint usage-detail">{requestsDetail}</p> : null}
				</>
			) : (
				<>
					<p className="hint usage-activity">{requestsMissingText(server)}</p>
					{requestsDetail !== undefined ? <p className="hint usage-detail">{requestsDetail}</p> : null}
				</>
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
			<div className="toolbar">
				<button
					type="button"
					className="secondary"
					disabled={usage.refreshing || serverCount === 0}
					onClick={() => sendRequest("refreshUsage", null)}
				>
					{usage.refreshing ? (
						<>
							<span className="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
						</>
					) : (
						l10n.t("Refresh now")
					)}
				</button>
				{usage.pollIntervalMs === 0 ? (
					<span className="hint">
						{l10n.t("Background polling is off (usage.pollInterval 0); refresh fetches on demand.")}
					</span>
				) : null}
			</div>
			{/* The data follows the key, not the entry (docs/usage.md#budgets):
			    rotating a credential switches the numbers to the new key's spend,
			    and the panel says so instead of leaving the jump unexplained. */}
			<p className="hint">
				{l10n.t(
					"Spend is the key's server-side total, e.g. rotating an entry's key switches its numbers to the new key's spend."
				)}
			</p>
			{usage.servers.length === 0 ? (
				<div className="empty-block">
					{serverCount === 0 ? (
						<p>{l10n.t("No servers configured; add one under Servers & Models.")}</p>
					) : (
						<>
							<p>{l10n.t("None of your servers serves usage data.")}</p>
							<p className="hint">
								{l10n.t(
									"Spend tracking needs a LiteLLM server with a database (the /key/info endpoint); servers without one simply do not appear here."
								)}
							</p>
						</>
					)}
				</div>
			) : (
				<div className="usage-cards">
					{usage.servers.map((server) =>
						server.kind === "forbidden" ? (
							<ForbiddenUsageCard key={`${server.label} ${server.baseUrl}`} server={server} />
						) : (
							<UsageCard
								key={`${server.label} ${server.baseUrl}`}
								server={server}
								thresholds={usage.thresholds}
								pollingOff={usage.pollIntervalMs === 0}
								discoveryTimeoutMs={usage.discoveryTimeoutMs}
								now={now}
							/>
						)
					)}
				</div>
			)}
		</section>
	);
}
