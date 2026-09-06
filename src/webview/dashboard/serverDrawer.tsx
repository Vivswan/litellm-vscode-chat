/**
 * A server row's drawer: the spend, request, and budget facts, the entry's
 * read-only records, the external-group tip, and the URL breaks.
 */
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { parseCapabilityGroups, parseGroups, toGroups } from "../../dashboard/recordDraft";
import { serverFormFieldLabel } from "../../dashboard/serverForm";
import { barPresentation, formatMoney, formatPercent, stalenessText } from "../../dashboard/spendFormat";
import type {
	DashboardServer,
	ExternalDashboardServer,
	UsageForbiddenServerView,
	UsageServerCardView,
	UsageServerView,
} from "../../dashboard/viewModels";
import { capabilityIssueViews, type GroupIssueView, paramIssueViews } from "./recordIssues";
import { RecordMatcherTable } from "./recordMatcherTable";
import type { DrawerNotice, UsageEndpoint } from "./serverDiagnostics";
import {
	activityDetail,
	DrawerNoticeLine,
	detailLines,
	keyInfoDetail,
	neverUpdatedText,
	requestsMissingReason,
	spendMissingReason,
} from "./serverDiagnostics";
import { TONE_FILL, TONE_TEXT } from "./spendTones";
import { relativeTime } from "./time";
import { AbsentDatum } from "./ui/absent";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

/**
 * The external row's provenance, the drawer's Origin fact; the copy lives here because
 * classifications cross the boundary, words do not. Deletion instructions name the models
 * file: VS Code offers extensions no group removal, so the file is where deleting lives.
 */
function externalTip(server: ExternalDashboardServer): string {
	const provenance = server.provenance;
	if (provenance?.kind === "removed-entry-leftover") {
		return l10n.t(
			'Leftover of the removed entry "{0}". Remove hides its models; deleting its object from the models file erases it.',
			provenance.removedLabel
		);
	}
	if (provenance?.kind === "rename-leftover") {
		return l10n.t(
			'Leftover of renaming "{0}" to "{1}". Its models show under both names until its object is deleted from the models file.',
			provenance.oldLabel,
			provenance.newLabel
		);
	}
	return l10n.t(
		"No entry in the servers setting: added outside this extension, or predates its tracking. Edit adopts it."
	);
}

/**
 * The row's spend-at-a-glance: the budget percentage over the meter, the plain amount when
 * no budget gives a percentage meaning, nothing for a server without usage data (an empty
 * cell, not an "unknown" marker). The glance is the fraction; the drawer is the figures.
 */
export function SpendUnit({
	usage,
	thresholds,
	currencySymbol,
}: {
	usage: UsageServerView | undefined;
	thresholds: readonly number[];
	currencySymbol: string;
}) {
	if (usage?.spend === undefined) {
		return null;
	}
	// EVERY non-fresh number wears the qualifier, whatever the cause (the header's "worst
	// budget use" excludes stale rows, so an unmarked 112% would contradict it). It leads the
	// figure ON ITS LINE, never a line of its own: the mark lands asynchronously, and a third
	// line moved every row below it (the .server-usage floor absorbs the word's width).
	const note = usage.fresh ? null : (
		<span className="spend-note font-sans text-[0.92em] text-warn">{l10n.t("stale")} </span>
	);
	// The hidden noun says what the number is to a screen reader; hidden text rather than an
	// aria-label because a plain span has no role that supports one.
	if (usage.spentFraction !== undefined) {
		const bar = barPresentation(usage.spentFraction, thresholds);
		return (
			<span className="spend-unit">
				<span className={cn("font-mono text-[0.92em] tabular-nums", TONE_TEXT[bar.tone])}>
					<span className="visually-hidden">{l10n.t("Budget spent:")} </span>
					{note}
					{formatPercent(usage.spentFraction)}
				</span>
				{/* A baseline, not a track: a track colour cannot clear 3:1 against both page and
				    fill at once (measured on Light Modern), so the extent is a 1px axis and the
				    fill keeps its saturated tones. Content-box sizing (no preflight): h-[3px]
				    plus the border is a 4px meter. The fill names its forced-colors colour at
				    the call site - backgrounds flatten to Canvas while the axis border forces to
				    CanvasText, and an unhandled fill would read as a measured zero, the exact
				    reading the axis-less no-budget branch exists to avoid. */}
				<span className="spend-meter h-[3px] overflow-hidden rounded-xs border-axis border-b" aria-hidden="true">
					<span
						className={cn("block h-full forced-colors:bg-[Highlight]", TONE_FILL[bar.tone])}
						style={{ width: `${bar.widthPercent}%` }}
					/>
				</span>
			</span>
		);
	}
	return (
		<span className="spend-unit">
			<span className="font-mono text-[0.92em] tabular-nums">
				<span className="visually-hidden">{l10n.t("Spent:")} </span>
				{note}
				{formatMoney(usage.spend, currencySymbol)}
			</span>
		</span>
	);
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
 * A number this server did not report (ui/absent.tsx owns the dash-plus-words contract); a
 * fact with a reason of its own says it visibly, as a Why in place.
 */
function Absent({ reason }: { reason?: string | undefined }) {
	return (
		<AbsentDatum className="text-muted-foreground">
			{reason === undefined ? undefined : <Why text={reason} />}
		</AbsentDatum>
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
				{/* The reason states what to do, not what the reader can see: the
				    empty spend meter beside the row already says nothing is measured
				    against, so this line does not repeat it. */}
				<Absent
					reason={l10n.t("neither this entry nor the key sets one; set one with Edit, or on the key in LiteLLM")}
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
 * The request-statistics facts. A missing window has exactly ONE cause, stated once on the
 * Requests fact; the computed rates show bare dashes (visually-hidden "not reported" intact). The
 * present-window branch keeps per-dash reasons - there the denominators miss independently.
 */
function RequestFacts({ server }: { server: UsageServerView }) {
	// Retained statistics from a failing endpoint must not read as current: spend freshness
	// says nothing about the activity window. "unknown" stays unmarked - nothing failed yet.
	const outdated = server.dailyActivity.kind === "error" || server.dailyActivity.kind === "unavailable";
	const requests = server.requests;
	if (requests === undefined) {
		return (
			<>
				<Fact label={l10n.t("Requests, 30 days")}>
					<Absent reason={requestsMissingReason(server.dailyActivity)} />
				</Fact>
				<Fact label={l10n.t("Success rate")}>
					<Absent />
				</Fact>
				<Fact label={l10n.t("Cache hit rate")}>
					<Absent />
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

/** The usage half of the drawer's inventory: every spend fact, present or stated missing. */
function UsageFacts({
	server,
	pollingOff,
	now,
	currencySymbol,
}: {
	server: UsageServerView;
	pollingOff: boolean;
	now: number;
	currencySymbol: string;
}) {
	const staleness = stalenessText(server.fresh, server.keyInfo);
	const spendReason = server.spend === undefined ? spendMissingReason(server.keyInfo, pollingOff) : undefined;
	// On a never-fetched server both facts would answer with the same sentence; the second
	// drops its reason rather than repeating the first word for word.
	const neverUpdated = neverUpdatedText(server.keyInfo);
	return (
		<>
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
			<Fact label={l10n.t("Spend last updated")}>
				{server.lastUpdatedAt === undefined ? (
					<Absent reason={neverUpdated === spendReason ? undefined : neverUpdated} />
				) : (
					<span className={server.fresh ? undefined : "text-warn"}>
						{relativeTime(server.lastUpdatedAt, now)}
						{staleness !== undefined ? <Why text={staleness} /> : null}
					</span>
				)}
			</Fact>
		</>
	);
}

/**
 * The usage facts a denied key left without numbers: the SAME rows as a reporting server's,
 * dashed, so a denied drawer does not look like a shorter kind of server. Reasons come from
 * the same per-fact maps the reporting drawer reads, one per refused endpoint, on the fact
 * that owns it; the remedy lives in the row's diagnostic.
 */
function DeniedUsageFacts({ card, pollingOff }: { card: UsageForbiddenServerView; pollingOff: boolean }) {
	return (
		<>
			<Fact label={l10n.t("Spend")}>
				<Absent reason={spendMissingReason(card.keyInfo, pollingOff)} />
			</Fact>
			<Fact label={l10n.t("Budget")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Next reset")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Requests, 30 days")}>
				<Absent reason={requestsMissingReason(card.dailyActivity)} />
			</Fact>
			<Fact label={l10n.t("Success rate")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Cache hit rate")}>
				<Absent />
			</Fact>
			<Fact label={l10n.t("Spend last updated")}>
				<Absent />
			</Fact>
		</>
	);
}

/**
 * The row's detail drawer, one labelled inventory in the Fact/Absent vocabulary. Usage is
 * per SERVER, never per model, and every field can be missing (a normal shape, not a
 * failure), so absence is designed and a missing number is never a zero; only a server the
 * snapshot does not cover gets the entry facts alone (seven identical dashes would be noise).
 */
export function ServerDrawer({
	server,
	usage,
	notices,
	carriedDetails,
	pollingOff,
	discoveryTimeoutMs,
	now,
	currencySymbol,
	onShowModels,
}: {
	server: DashboardServer;
	/** The row's usage card, denied cards included; absent for servers the snapshot does not cover. */
	usage: UsageServerCardView | undefined;
	/** The row's drawer-placed diagnostics (the warn-tier budget line); rendered as the inventory's leading rows. */
	notices: readonly DrawerNotice[];
	/** The endpoint details the row's diagnostics already carry; the inventory prints only the remainder. */
	carriedDetails: ReadonlySet<UsageEndpoint>;
	pollingOff: boolean;
	discoveryTimeoutMs: number;
	now: number;
	currencySymbol: string;
	onShowModels: ((label: string) => void) | undefined;
}) {
	const numbers = usage?.kind === "usage" ? usage : undefined;
	// The endpoint standings' English lines, minus the ones a diagnostic under this row
	// already carries: the drawer is the inventory, not a second copy of the row's problems.
	const details =
		numbers === undefined
			? []
			: detailLines(
					carriedDetails.has("keyInfo") ? undefined : keyInfoDetail(numbers, discoveryTimeoutMs),
					carriedDetails.has("dailyActivity") ? undefined : activityDetail(numbers)
				);
	return (
		<>
			{/* The drawer-placed diagnostics LEAD the inventory (user-ruled): the sentence is
			    what the row's tinted meter sent the reader in here for, and the trailing seat
			    left dead padding under the facts. */}
			{notices.map((notice) => (
				<DrawerNoticeLine key={notice.key} diagnostic={notice} />
			))}
			{/* Two columns until the pane cannot hold both: the 11rem label column plus an
			    unshrinkable longest word overflows under about 560px of pane, which the floor
			    promises never scrolls sideways. Stacked, the dd's own bottom margin keeps the
			    next label from joining the value above it. */}
			<dl className="server-facts m-0 grid max-w-[46rem] grid-cols-[11rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[0.95em] @max-[560px]/pane:grid-cols-[minmax(0,1fr)] @max-[560px]/pane:gap-y-0">
				{/* The row's collapsed header may ellipsize the label, so the inventory leads with
				    it whole (wrapping, never clipped). These two facts take their names from the
				    server form's own vocabulary (serverFormFieldLabel), so the drawer and the form
				    cannot drift apart. */}
				<Fact label={serverFormFieldLabel("label")}>
					<span className="fact-name">{server.label}</span>
				</Fact>
				<Fact label={serverFormFieldLabel("baseUrl")}>
					<span className="fact-url">
						<UrlBreaks text={server.baseUrl} />
					</span>
				</Fact>
				<Fact label={l10n.t("Authentication")}>
					{/* The credential KIND, never a value; OAuth stays English by policy.
					    "unknown" is the pre-proof window: denying a key nobody read would
					    be a guess, so the fact goes absent with the reason instead. */}
					{server.hasOAuth ? (
						"OAuth"
					) : server.credentials === "present" ? (
						l10n.t("API key")
					) : server.credentials === "absent" ? (
						l10n.t("none")
					) : (
						<Absent reason={l10n.t("not read yet - secret storage is checked on the first sync")} />
					)}
				</Fact>
				<Fact label={l10n.t("Models")}>
					{/* The whole phrase is the link: a bare "models" fragment cannot be translated
					    (measure words and word order move). It lives here, not on the row - the row
					    is one disclosure button, and a button cannot contain a button. A zero stays
					    plain text, since an empty scoped list has nothing to show. */}
					{onShowModels !== undefined && server.servedModelCount > 0 ? (
						<Button
							variant="secondary"
							size="compact"
							className="count-link [--btn-mx:-0.25rem] px-1 py-0"
							aria-label={l10n.t("Show models from {0}", server.label)}
							onClick={() => onShowModels(server.label)}
						>
							{server.servedModelCount === 1 ? l10n.t("1 model") : l10n.t("{0} models", server.servedModelCount)}
						</Button>
					) : server.servedModelCount === 1 ? (
						l10n.t("1 model")
					) : (
						l10n.t("{0} models", server.servedModelCount)
					)}
				</Fact>
				<Fact label={l10n.t("Discovery last checked")}>
					{server.lastChecked !== undefined && server.state !== "unchecked" ? (
						relativeTime(server.lastChecked, now)
					) : (
						<Absent reason={l10n.t("no discovery pass has seen it yet - run Sync models to check it now")} />
					)}
				</Fact>
				{server.origin === "external" ? (
					<Fact label={l10n.t("Origin")}>
						{l10n.t("external")}
						<Why text={externalTip(server)} />
					</Fact>
				) : null}
				{numbers !== undefined ? (
					<UsageFacts server={numbers} pollingOff={pollingOff} now={now} currencySymbol={currencySymbol} />
				) : usage?.kind === "forbidden" ? (
					<DeniedUsageFacts card={usage} pollingOff={pollingOff} />
				) : null}
			</dl>
			{details.map((detail) => (
				<p key={detail} className="usage-detail mt-2 mb-0 font-mono text-[0.85em] text-muted-foreground">
					{detail}
				</p>
			))}
			{server.origin === "declared" ? (
				<>
					<DrawerRecords kind="params" value={server.config.modelParameters} server={server} />
					<DrawerRecords kind="caps" value={server.config.modelCapabilities} server={server} />
				</>
			) : null}
		</>
	);
}

/**
 * The entry's model records in the drawer, in the settings editors' vocabulary. Read-only on
 * purpose: the setting and the edit page are the two write surfaces. An entry without
 * records renders nothing - per-push static state, not a transient, so no reservation.
 */
function DrawerRecords({
	kind,
	value,
	server,
}: {
	kind: "params" | "caps";
	value: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
	server: DashboardServer;
}) {
	if (value === undefined || Object.keys(value).length === 0) {
		return null;
	}
	const groups = toGroups(value);
	// Judged with the same parses the editors use, so an invalid stored FIELD wears the same
	// chip mark as in the edit page (matcher-level problems stay the edit page's job); the
	// capability hints read this entry's own observed /model/info vocabulary, like the form.
	let issues: GroupIssueView[];
	if (kind === "params") {
		const parse = parseGroups(groups);
		issues = paramIssueViews(groups, parse.ok ? [] : parse.problems, parse.hints);
	} else {
		const observed = server.observedModelInfoKeys;
		const parse = parseCapabilityGroups(groups, observed === undefined ? undefined : new Set(observed));
		issues = capabilityIssueViews(groups, parse.issues);
	}
	return (
		<div className="drawer-records mt-3">
			<h5 className="m-0 mb-1 font-semibold text-[0.92em] text-muted-foreground">
				{serverFormFieldLabel(kind === "params" ? "modelParameters" : "modelCapabilities")}
				{/* The caveat on the table it qualifies: the row's degraded line renders AFTER
				    this drawer, so the mark is the qualifier alone; the sentence stays with the
				    fix. */}
				{server.notices?.includes(kind === "params" ? "entry-params-inactive" : "entry-capabilities-inactive") ===
				true ? (
					<Why
						text={l10n.t({
							message: "may not be applied",
							comment: [
								"Mark on the heading of a read-only table of per-server settings, when those settings may not be reaching the server.",
							],
						})}
					/>
				) : null}
			</h5>
			<RecordMatcherTable kind={kind} groups={groups} issues={issues} readOnly />
		</div>
	);
}

/**
 * The row's URL, split so the https:// scheme can go visually-hidden rather than away: the
 * text stays in the DOM, so the accessible name, a copy, and find-in-page still carry the
 * exact URL. An http:// URL keeps its scheme visible - plaintext to a proxy holding an API
 * key is worth a reader's attention.
 */
export function urlParts(baseUrl: string): { readonly scheme: string; readonly rest: string; readonly quiet: boolean } {
	const secure = "https://";
	// Case-insensitive: "HTTPS://host" is the same address.
	const marked = baseUrl.slice(0, secure.length).toLowerCase() === secure;
	const rest = marked ? baseUrl.slice(secure.length) : baseUrl;
	// A scheme with nothing after it stays visible: "https://" alone is a value someone has
	// to fix, and hiding it would render the row's URL as an empty space.
	return marked && rest.length > 0
		? { scheme: baseUrl.slice(0, secure.length), rest, quiet: true }
		: { scheme: marked ? baseUrl : "", rest: marked ? "" : baseUrl, quiet: false };
}

/**
 * A URL with a break opportunity BEFORE each dot, slash, or colon, so a wrapping host divides
 * at its labels. <wbr> adds nothing to the text (copy, find-in-page, and screen readers get
 * the exact string); overflow-wrap's anywhere stays beneath it as the backstop.
 */
export function UrlBreaks({ text }: { text: string }) {
	return (
		<>
			{text.split(/(?=[./:])/).map((part, index) =>
				index === 0 ? (
					part
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: the segments are not reorderable items - the whole run re-renders with its string
					<Fragment key={index}>
						<wbr />
						{part}
					</Fragment>
				)
			)}
		</>
	);
}
