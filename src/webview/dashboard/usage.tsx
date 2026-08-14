/**
 * The Usage tab: spend against budget per server, rendered from the pushed
 * DashboardUsage snapshot (numbers, epoch timestamps, configured identity,
 * and closed endpoint-standing enums only - the extension narrowed everything
 * response-derived away before it reached the store). Servers whose LiteLLM
 * instance serves no usage endpoints never appear; a server a refused key
 * (401/403) leaves without readable usage keeps its row and states the block
 * instead - forbidden is fixable, unsupported is not. When no server surfaces
 * at all, the section says so instead of showing empty charts (docs/usage.md).
 *
 * Every row is one scannable line - name, spend, meter, percentage, and the
 * fact that matters most - that opens onto a labelled inventory of everything
 * this extension knows about that server. Usage is per SERVER, never per
 * model, and every field can be missing: a proxy that does not serve the
 * activity endpoint reports no request statistics at all, which is a normal
 * shape rather than a failure. So absence is designed rather than hidden - a
 * dim dash plus the reason in place - and a missing number is never a zero.
 *
 * Failure rendering is two-part: a localized human sentence (what happened,
 * what to do) plus a compact English detail line built from the standing's
 * enums (endpoint path, HTTP status, fixed vocabulary). The detail stays
 * English on purpose: users paste it into GitHub issues, and every term is
 * protocol vocabulary. Nothing here may ever interpolate server-derived text.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import type {
	DashboardUsage,
	UsageEndpointStandingView,
	UsageForbiddenServerView,
	UsageServerCardView,
	UsageServerView,
} from "../../dashboard/viewModels";
import { DOCS_LINK_USAGE } from "./docsLinks";
import { helpUsageSection } from "./helpText";
import { relativeTime } from "./time";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Section } from "./ui/section";
import { sendRequest } from "./vscodeApi";

/**
 * An amount as the panel prints it: the configured currency symbol verbatim
 * (display only, never a conversion; the empty symbol renders the bare
 * number), two decimals below 1000, whole units above.
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
const TONE_TEXT: Readonly<Record<"ok" | "warn" | "error", string>> = {
	ok: "text-ok",
	warn: "text-warn",
	error: "text-err",
};

/**
 * The meter's fill takes the fill tier, not the text tier: a bar is a shape, so
 * 3:1 carries it, while the same colour as a word has to clear AA and darkens
 * further for it. Both tiers move only on light surfaces, where the raw hues
 * were tuned for a dark editor - the healthy green measured 2.0:1 on the light
 * page before that correction. The `-fill` names are the explicit ones on
 * purpose: `bg-ok` still compiles and would paint the meter in the text colour.
 */
const TONE_FILL: Readonly<Record<"ok" | "warn" | "error", string>> = {
	ok: "bg-ok-fill",
	warn: "bg-warn-fill",
	error: "bg-err-fill",
};

/**
 * Why a server has never reported spend at all, per the /key/info standing:
 * the reason the "Last updated" fact carries in place of an age.
 */
function neverUpdatedText(server: UsageServerView): string {
	if (server.keyInfo.kind === "unavailable") {
		return server.keyInfo.reason === "forbidden"
			? l10n.t("This key isn't allowed to read its spend.")
			: l10n.t("This server doesn't report spend.");
	}
	return l10n.t("Spend hasn't loaded for this server yet.");
}

/**
 * What is wrong with an age that is not fresh, in the same words the line's
 * tail uses, so a row's marker and its panel never name the state differently.
 * Undefined while the data is fresh.
 */
function stalenessText(server: UsageServerView): string | undefined {
	if (server.fresh) {
		return undefined;
	}
	if (server.keyInfo.kind === "error") {
		return l10n.t("last refresh failed");
	}
	if (server.keyInfo.kind === "unavailable" && server.keyInfo.reason === "forbidden") {
		return l10n.t("usage access denied");
	}
	// Merely old (laptop asleep, polling off): the plain history marker.
	return l10n.t("possibly stale");
}

/**
 * The spend fact's reason when /key/info gave no spend number: why, and what
 * unblocks it, branched on the standing (a forbidden key, a transient
 * failure, and a server that simply omits the field must not read
 * identically).
 */
function spendUnknownText(server: UsageServerView, pollingOff: boolean): string {
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
			return l10n.t("Spend hasn't loaded for this server yet.");
		case "error":
			return pollingOff
				? l10n.t("Spend hasn't loaded yet - the last check failed; use Refresh now to try again.")
				: l10n.t("Spend hasn't loaded yet - the last check failed; it retries automatically with increasing delay.");
	}
}

/**
 * The one English template for a forbidden endpoint standing; every row
 * prints this same line so pasted issue reports stay uniform.
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
			// Unsupported needs no detail: the fact's own reason covers it.
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
 * The requests fact's reason when /user/daily/activity has no retained
 * window: the permanent shapes keep their own sentences (unsupported stays
 * the documented normal-shape note, forbidden names the fix), and everything
 * else is the transient couldn't-fetch-yet line.
 */
function requestsMissingText(server: UsageServerView): string {
	if (server.dailyActivity.kind === "unavailable") {
		return server.dailyActivity.reason === "forbidden"
			? l10n.t(
					"This key isn't allowed to read request statistics on this server. After the key's permissions change, use Refresh now to re-check."
				)
			: l10n.t("This server does not serve /user/daily/activity (a normal shape on some setups).");
	}
	return l10n.t("Request statistics couldn't be fetched yet - retries on the next refresh.");
}

/**
 * The forbidden row's English detail line for one endpoint standing: the
 * shared forbidden template for the refused endpoint, the not-served note for
 * an unsupported partner (so a mixed 404-plus-403 server states both facts),
 * undefined otherwise. Same policy as keyInfoDetail: English protocol
 * vocabulary users paste into issue reports, built from closed enums and the
 * status number only.
 */
function forbiddenRowDetail(path: string, standing: UsageEndpointStandingView): string | undefined {
	if (standing.kind !== "unavailable") {
		return undefined;
	}
	return standing.reason === "forbidden"
		? forbiddenLine(path, standing.status)
		: `LiteLLM ${path}: not served on this server${standing.status !== undefined ? ` (HTTP ${standing.status})` : ""}`;
}

/**
 * The collapsed line's trailing fact, ranked: a problem the reader has to act
 * on beats budget pressure, and budget pressure beats a healthy statistic. The
 * percentage is already its own column, so the budget clauses say the thing a
 * percentage does not - how much is left, or how far past the line this is.
 * "warn" is also the verdict the header counts as needing attention, so the
 * two can never disagree.
 */
function tailFact(
	server: UsageServerView,
	thresholds: readonly number[],
	currencySymbol: string
): { text: string; tone: "warn" | "muted" } {
	if (server.keyInfo.kind === "unavailable" && server.keyInfo.reason === "forbidden") {
		return { text: l10n.t("usage access denied"), tone: "warn" };
	}
	if (server.keyInfo.kind === "error") {
		return { text: l10n.t("last refresh failed"), tone: "warn" };
	}
	if (server.dailyActivity.kind === "unavailable" && server.dailyActivity.reason === "forbidden") {
		return { text: l10n.t("request statistics denied"), tone: "warn" };
	}
	if (server.dailyActivity.kind === "error" && server.requests !== undefined) {
		return { text: l10n.t("statistics may be outdated"), tone: "warn" };
	}
	if (server.lastUpdatedAt !== undefined && !server.fresh) {
		return { text: l10n.t("possibly stale"), tone: "warn" };
	}
	const fraction = server.spentFraction;
	if (fraction !== undefined && server.spend !== undefined && server.effectiveBudget !== undefined) {
		const tone = barPresentation(fraction, thresholds).tone;
		if (fraction > 1) {
			return {
				text: l10n.t("over budget by {0}", formatMoney(server.spend - server.effectiveBudget, currencySymbol)),
				tone: "warn",
			};
		}
		if (tone !== "ok") {
			return {
				text: l10n.t("{0} left", formatMoney(server.effectiveBudget - server.spend, currencySymbol)),
				tone: "warn",
			};
		}
	}
	if (server.requests !== undefined) {
		const total =
			server.requests.total === 1
				? l10n.t("1 request")
				: l10n.t("{0} requests", server.requests.total.toLocaleString());
		return {
			text:
				server.requests.cacheHitRate !== undefined
					? `${total} - ${l10n.t("{0} cached", formatPercent(server.requests.cacheHitRate))}`
					: total,
			tone: "muted",
		};
	}
	if (server.effectiveBudget === undefined && server.spend !== undefined) {
		return { text: l10n.t("no budget set"), tone: "muted" };
	}
	return { text: l10n.t("no request statistics"), tone: "muted" };
}

/** One fact row: every fact has the same shape, so a half-reported server reads like a full one. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-muted-foreground @max-[560px]/pane:text-[0.92em]">{label}</dt>
			<dd className="m-0 font-mono text-[0.92em] tabular-nums @max-[560px]/pane:mb-1">{children}</dd>
		</>
	);
}

/**
 * A number this server did not report: a dim dash plus the reason in place.
 * Never a zero - a zero is a measurement, and no measurement was taken. The
 * dash alone reads as nothing to a screen reader, so a fact with no reason of
 * its own carries the words instead.
 */
function Absent({ reason }: { reason?: string | undefined }) {
	return (
		<span className="text-muted-foreground">
			<span aria-hidden="true">-</span>
			{reason === undefined ? <span className="sr-only">{l10n.t("not reported")}</span> : <Why text={reason} />}
		</span>
	);
}

/** The prose annotation beside a fact: provenance for a value, the cause for an absence. */
function Why({ text }: { text: string }) {
	return <span className="ml-2.5 font-sans text-[0.92em] text-muted-foreground">{text}</span>;
}

/** The budget fact's provenance, so a number that came from the key never reads as one the user set. */
function BudgetFact({ server, currencySymbol }: { server: UsageServerView; currencySymbol: string }) {
	if (server.effectiveBudget === undefined) {
		return (
			<Fact label={l10n.t("Budget")}>
				<Absent
					reason={l10n.t(
						"neither this entry nor the key sets one, so there is no percentage to show; set one on the entry under Servers, or on the key in LiteLLM"
					)}
				/>
			</Fact>
		);
	}
	const alsoKey =
		server.budgetSource === "entry" && server.keyBudget !== undefined && server.keyBudget !== server.effectiveBudget;
	return (
		<Fact label={l10n.t("Budget")}>
			{formatMoney(server.effectiveBudget, currencySymbol)}
			{alsoKey ? (
				<Why
					text={l10n.t("set on this entry - the key reports {0}", formatMoney(server.keyBudget ?? 0, currencySymbol))}
				/>
			) : (
				<Why text={server.budgetSource === "entry" ? l10n.t("set on this entry") : l10n.t("reported by the key")} />
			)}
		</Fact>
	);
}

/**
 * The request-statistics facts: the retained window, or one stated absence per
 * number. Every dash carries its own reason - the two rates are computed from
 * denominators that can be missing on their own, and three bare dashes under
 * one explanation would leave the reader guessing which one it covered.
 */
function RequestFacts({ server }: { server: UsageServerView }) {
	// Retained statistics from a failing endpoint must not read as current:
	// spend freshness says nothing about the activity window. "unknown" stays
	// unmarked - a re-probe is pending, nothing failed yet.
	const outdated = server.dailyActivity.kind === "error" || server.dailyActivity.kind === "unavailable";
	const requests = server.requests;
	if (requests === undefined) {
		const noWindow = l10n.t("no request statistics to compute it from");
		return (
			<>
				<Fact label={l10n.t("Requests, 30 days")}>
					<Absent reason={requestsMissingText(server)} />
				</Fact>
				<Fact label={l10n.t("Success rate")}>
					<Absent reason={noWindow} />
				</Fact>
				<Fact label={l10n.t("Cache hit rate")}>
					<Absent reason={noWindow} />
				</Fact>
			</>
		);
	}
	return (
		<>
			<Fact label={l10n.t("Requests, 30 days")}>
				{requests.total.toLocaleString()}
				{outdated ? <Why text={l10n.t("may be outdated: the last statistics fetch failed")} /> : null}
			</Fact>
			<Fact label={l10n.t("Success rate")}>
				{requests.successRate !== undefined ? (
					formatPercent(requests.successRate)
				) : (
					<Absent reason={l10n.t("no requests in the window to compute it from")} />
				)}
			</Fact>
			<Fact label={l10n.t("Cache hit rate")}>
				{requests.cacheHitRate !== undefined ? (
					formatPercent(requests.cacheHitRate)
				) : (
					<Absent reason={l10n.t("the window reports no prompt tokens")} />
				)}
			</Fact>
		</>
	);
}

/** The expanded inventory for a server with readable usage: every field, present or stated missing. */
function UsagePanel({
	server,
	pollingOff,
	discoveryTimeoutMs,
	now,
	currencySymbol,
}: {
	server: UsageServerView;
	pollingOff: boolean;
	discoveryTimeoutMs: number;
	now: number;
	currencySymbol: string;
}) {
	const details = [keyInfoDetail(server, pollingOff, discoveryTimeoutMs), activityDetail(server)].filter(
		(detail): detail is string => detail !== undefined
	);
	const staleness = stalenessText(server);
	const spendReason = server.spend === undefined ? spendUnknownText(server, pollingOff) : undefined;
	// The two facts answer different questions, but on a server that has never
	// been fetched they answer with the same sentence; the second one drops its
	// reason rather than repeating the first word for word.
	const neverUpdated = neverUpdatedText(server);
	return (
		<>
			{/* Two columns until the pane cannot hold both. The label column is a
			    fixed 11rem and a value cannot shrink below its longest word, so
			    under about 560px of pane the pair asked for more room than the
			    pane had and the page paid for it by scrolling sideways - which
			    the floor promises does not happen. Stacked, each fact reads as
			    its label and then its value, and the dd's own bottom margin is
			    what keeps the next label from joining the value above it. */}
			<dl className="usage-facts m-0 grid max-w-[46rem] grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[0.95em] @max-[560px]/pane:grid-cols-[minmax(0,1fr)] @max-[560px]/pane:gap-y-0">
				<Fact label={l10n.t("Server")}>
					<span className="usage-url">{server.baseUrl}</span>
				</Fact>
				<Fact label={l10n.t("Spend")}>
					{server.spend !== undefined ? formatMoney(server.spend, currencySymbol) : <Absent reason={spendReason} />}
				</Fact>
				<BudgetFact server={server} currencySymbol={currencySymbol} />
				<Fact label={l10n.t("Next reset")}>
					{server.budgetResetAt !== undefined ? (
						new Date(server.budgetResetAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
					) : (
						<Absent reason={l10n.t("the key does not report a reset date")} />
					)}
				</Fact>
				<RequestFacts server={server} />
				<Fact label={l10n.t("Last updated")}>
					{server.lastUpdatedAt === undefined ? (
						<Absent reason={neverUpdated === spendReason ? undefined : neverUpdated} />
					) : (
						<span className={server.fresh ? undefined : "text-warn"}>
							{relativeTime(new Date(server.lastUpdatedAt).toISOString(), now) ?? l10n.t("just now")}
							{staleness !== undefined ? <Why text={staleness} /> : null}
						</span>
					)}
				</Fact>
			</dl>
			{details.map((detail) => (
				<p key={detail} className="usage-detail mt-2 mb-0 font-mono text-[0.85em] text-muted-foreground">
					{detail}
				</p>
			))}
		</>
	);
}

/**
 * The expanded panel for a server a refused key leaves without any readable
 * usage: what happened, what unblocks it, and the endpoint standings. No
 * facts grid - there are no numbers to label, and seven dashes explaining the
 * same denial seven times would be noise, not an inventory.
 */
function ForbiddenPanel({ server }: { server: UsageForbiddenServerView }) {
	const details = [
		forbiddenRowDetail("/key/info", server.keyInfo),
		forbiddenRowDetail("/user/daily/activity", server.dailyActivity),
	].filter((detail): detail is string => detail !== undefined);
	return (
		<div className="max-w-[46rem]">
			<p className="m-0">{l10n.t("Usage unavailable: this key isn't allowed to read its usage.")}</p>
			<p className="mt-1 mb-0 text-muted-foreground">
				{l10n.t(
					"Ask whoever issued the key to allow reading its own usage, then use Refresh now - the extension won't re-check on its own."
				)}
			</p>
			{details.map((detail) => (
				<p key={detail} className="usage-detail mt-2 mb-0 font-mono text-[0.85em] text-muted-foreground">
					{detail}
				</p>
			))}
		</div>
	);
}

/**
 * One server: a line that stands on its own - name, spend, meter, percentage,
 * and the fact that matters most - opening onto the full inventory. The line
 * is the button; the meter is decoration beside the percentage it repeats, so
 * the button's accessible name stays the facts rather than a chart.
 */
function UsageRow({
	server,
	thresholds,
	pollingOff,
	discoveryTimeoutMs,
	now,
	currencySymbol,
}: {
	server: UsageServerCardView;
	thresholds: readonly number[];
	/** Whether background polling is off (usage.pollInterval 0); retry hints name Refresh now instead of the automatic retry. */
	pollingOff: boolean;
	/** The effective discovery.timeout; the timeout detail line prints it. */
	discoveryTimeoutMs: number;
	now: number;
	currencySymbol: string;
}) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const usage = server.kind === "usage" ? server : undefined;
	const fraction = usage?.spentFraction;
	const bar = fraction !== undefined ? barPresentation(fraction, thresholds) : undefined;
	const tail =
		usage !== undefined
			? tailFact(usage, thresholds, currencySymbol)
			: { text: l10n.t("usage access denied"), tone: "warn" as const };
	return (
		<div className="usage-row border-border border-b last:border-b-0">
			<button
				type="button"
				// border-control-outline, like every other control: transparent in the
				// ordinary themes (the stylesheet ships no preflight, so a bare button
				// would otherwise wear the UA's own box) and the contrast border under
				// high contrast, where a borderless row stops reading as clickable.
				// Every column but the label and the percentage may shrink to nothing,
				// so a narrow editor group truncates the line instead of overflowing it.
				className="usage-line grid w-full grid-cols-[minmax(5rem,11rem)_minmax(0,9rem)_minmax(0,8rem)_3rem_minmax(0,1fr)_auto] items-center gap-x-4 rounded-sm border border-control-outline px-2.5 py-2 text-left hover:bg-accent focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid @max-[620px]/pane:grid-cols-[minmax(0,1fr)_auto_auto] @max-[620px]/pane:items-baseline @max-[620px]/pane:gap-x-3 @max-[620px]/pane:gap-y-0.5"
				aria-expanded={open}
				// Only while the panel exists: an aria-controls pointing at an
				// unmounted id is a dangling reference, and aria-expanded already
				// carries the state.
				aria-controls={open ? panelId : undefined}
				onClick={() => setOpen(!open)}
			>
				<span className="usage-label truncate font-semibold">{server.label}</span>
				<span className="usage-spend truncate font-mono text-[0.92em] tabular-nums">
					{usage?.spend !== undefined ? (
						formatMoney(usage.spend, currencySymbol)
					) : (
						<span className="text-muted-foreground">
							<span aria-hidden="true">-</span>
							<span className="sr-only">{l10n.t("spend not reported")}</span>
						</span>
					)}
					{usage?.effectiveBudget !== undefined ? (
						<span className="text-muted-foreground">
							{" "}
							{l10n.t("of {0}", formatMoney(usage.effectiveBudget, currencySymbol))}
						</span>
					) : null}
				</span>
				{/* A plain element rather than <meter>: the native one paints UA
				    chrome that ignores the theme tokens. It repeats the percentage
				    beside it, so it is decoration and stays out of the a11y tree
				    instead of stuffing a chart into the button's name. With no
				    budget there is nothing to measure, and a bare axis would read
				    as a measured zero - so the column stays reserved and blank,
				    and the tail says why. */}
				{/* A baseline, not a track. The unfilled remainder used to be a
				    background the fill sat ON, and that made the two contrasts
				    fight: lifting the track off the page pushes the fill toward it.
				    Measured on Light Modern at rest, a track at foreground/55
				    reaches 3.06:1 against the page and leaves the HEALTHY fill -
				    the weakest of the three there - at 1.24:1 against it. The
				    fill's curve is not monotonic across the whole range (it dips
				    near 70% and climbs again toward opaque), but nowhere on it do
				    both relationships clear 3:1 at once.

				    Decoupled, both are free. The extent is a 1px axis under the
				    bar; the fill sits on the page above it and keeps its saturated
				    tones. Canvas-composited on the Light and Dark Modern fixtures,
				    the axis never drops below 3.5:1 in any state - 3.95 at rest and
				    3.53 under the row's hover wash in light, 5.10 and 4.29 in dark -
				    and the fills measure ok/warn/err 3.8/5.6/6.0 light and
				    8.2/7.1/4.9 dark.
				    Fill carries the magnitude, axis carries the extent, and the
				    percentage beside them carries the precision.

				    Box sizing is content-box (no preflight), so h-[3px] plus the
				    border is a 4px meter with a 3px fill area, and the fill's
				    h-full is that 3px.

				    The fill carries its forced-colors colour at the CALL SITE, beside
				    the tone it overrides, rather than in the stylesheet's unlayered
				    forced-colors block - which could have won this too, being
				    unlayered, so this is a placement choice and not a necessity.
				    Some rule has to exist: backgrounds flatten to Canvas there while
				    border-color forces to CanvasText, so an unhandled fill leaves the
				    axis standing alone - and an axis with no fill above it is an empty
				    meter, which is a measured zero on a row that has spend. That is
				    the same reading the no-budget row must not produce, which is why
				    it renders no axis at all. */}
				<span
					className={cn(
						"usage-meter h-[3px] overflow-hidden rounded-xs",
						bar !== undefined ? "border-axis border-b" : null
					)}
					aria-hidden="true"
				>
					{bar !== undefined ? (
						<span
							className={cn("usage-meter-fill block h-full forced-colors:bg-[Highlight]", TONE_FILL[bar.tone])}
							style={{ width: `${bar.widthPercent}%` }}
						/>
					) : null}
				</span>
				<span
					className={cn(
						"usage-percent text-right font-mono text-[0.92em] tabular-nums",
						bar !== undefined ? TONE_TEXT[bar.tone] : "text-muted-foreground"
					)}
				>
					{fraction !== undefined ? formatPercent(fraction) : <span aria-hidden="true">-</span>}
				</span>
				<span
					className={cn(
						"usage-tail truncate text-[0.92em]",
						tail.tone === "warn" ? "text-warn" : "text-muted-foreground"
					)}
				>
					{tail.text}
				</span>
				<span className="usage-toggle text-[0.92em] text-muted-foreground">
					{open ? l10n.t("close") : l10n.t("open")}
				</span>
			</button>
			{open ? (
				<div id={panelId} className="usage-panel px-2.5 pt-1 pb-4">
					{server.kind === "usage" ? (
						<UsagePanel
							server={server}
							pollingOff={pollingOff}
							discoveryTimeoutMs={discoveryTimeoutMs}
							now={now}
							currencySymbol={currencySymbol}
						/>
					) : (
						<ForbiddenPanel server={server} />
					)}
				</div>
			) : null}
		</div>
	);
}

/**
 * Whether a row carries something the reader should act on: a refused key, a
 * failing endpoint, or numbers that stopped updating. The same verdict the
 * line's tail paints warn, counted for the header's summary.
 */
function needsAttention(server: UsageServerCardView, thresholds: readonly number[], currencySymbol: string): boolean {
	if (server.kind === "forbidden") {
		return true;
	}
	return tailFact(server, thresholds, currencySymbol).tone === "warn";
}

/**
 * The header's state summary: how many servers report, how many of them need
 * attention, and whether the numbers refresh on their own. Every clause is a
 * whole sentence fragment so extraction sees literals, not concatenation.
 */
function usageMeta(usage: DashboardUsage, currencySymbol: string): string {
	const count = usage.servers.length;
	const attention = usage.servers.filter((server) => needsAttention(server, usage.thresholds, currencySymbol)).length;
	// "with usage data" on purpose: the page header counts every configured
	// server, and only the ones whose proxy serves the usage endpoints reach
	// this list, so two different counts sit a hundred pixels apart.
	const clauses = [count === 1 ? l10n.t("1 server with usage data") : l10n.t("{0} servers with usage data", count)];
	if (attention > 0) {
		clauses.push(attention === 1 ? l10n.t("1 needs attention") : l10n.t("{0} need attention", attention));
	}
	if (usage.pollIntervalMs === 0) {
		clauses.push(l10n.t("background polling off (usage.pollInterval 0)"));
	}
	return clauses.join(" - ");
}

export function UsageSection({
	usage,
	serverCount,
	now,
	currencySymbol,
}: {
	usage: DashboardUsage;
	/** How many servers the dashboard knows at all; distinguishes the two empty states. */
	serverCount: number;
	/** The shared clock tick (one useNow in App). */
	now: number;
	/** The configured spend prefix (usage.currencySymbol); display only, never a conversion. */
	currencySymbol: string;
}) {
	return (
		<Section
			id="usage"
			title={l10n.t("Usage")}
			help={helpUsageSection()}
			// The trigger sits near the top of the document, where a tip placed
			// above it clips.
			helpBelow
			docs={{ href: DOCS_LINK_USAGE, label: l10n.t("Open the usage and budgets guide") }}
			meta={usage.servers.length > 0 ? usageMeta(usage, currencySymbol) : undefined}
			// The header line caps at the list's own measure: a rule running
			// 200px past the last row reads as page furniture rather than as
			// this section's header.
			headerClassName="max-w-[64rem]"
			actions={
				<Button
					variant="secondary"
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
				</Button>
			}
		>
			{/* The data follows the key, not the entry (docs/usage.md#budgets):
			    rotating a credential switches the numbers to the new key's spend,
			    and the panel says so instead of leaving the jump unexplained. */}
			<p className="hint mt-0 mb-3 max-w-[70ch]">
				{l10n.t(
					"Spend is the key's server-side total, e.g. rotating an entry's key switches its numbers to the new key's spend."
				)}
			</p>
			{usage.servers.length === 0 ? (
				<div className="empty-block">
					{serverCount === 0 ? (
						<p>{l10n.t("No servers configured; add one under Servers.")}</p>
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
				<div className="usage-list max-w-[64rem] border-border border-t">
					{usage.servers.map((server) => (
						<UsageRow
							key={`${server.label} ${server.baseUrl}`}
							server={server}
							thresholds={usage.thresholds}
							pollingOff={usage.pollIntervalMs === 0}
							discoveryTimeoutMs={usage.discoveryTimeoutMs}
							now={now}
							currencySymbol={currencySymbol}
						/>
					))}
				</div>
			)}
		</Section>
	);
}
