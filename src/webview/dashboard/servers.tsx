import * as l10n from "@vscode/l10n";
import { useEffect, useId, useState } from "react";
import { latestCheckedMs } from "../../dashboard/presenters";
import { sectionFailureText } from "../../dashboard/serverForm";
import { formatPercent, worstSpendTone } from "../../dashboard/spendFormat";
import type {
	DashboardServer,
	DashboardUsage,
	ExternalDashboardServer,
	HiddenGroup,
	UsageServerCardView,
} from "../../dashboard/viewModels";
import type { ExpectedFailureCategory } from "../../shared/serverEntry";
import { DOCS_LINK_SERVERS } from "./docsLinks";
import { FailureText } from "./failureText";
import { helpServersSection } from "./helpText";
import { useIntentOutcome } from "./hooks";
import { IconAdd } from "./icons";
import type { ServerHealthVerdict, SpendContext } from "./serverDiagnostics";
import { ServerDiagnosticLine, serverDiagnostics, serverHealth } from "./serverDiagnostics";
import { ServerDrawer, SpendUnit, UrlBreaks, urlParts } from "./serverDrawer";
import { type DiagnosticSeverity, severityLabel } from "./severity";
import { relativeTime } from "./time";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { DisclosureChevron } from "./ui/disclosureChevron";
import { Section } from "./ui/section";
import { sendRequest } from "./vscodeApi";

/**
 * A row's stable identity: origin plus opaque handle or setting-unique label.
 * The list key AND every per-row armed/pending state compare by this, never by
 * the label alone - a declared entry and an external group can wear the same
 * label (labels join only together with the URL), and a label-keyed armed
 * Remove would arm both rows at once.
 */
function serverRowKey(server: DashboardServer): string {
	return `${server.origin}:${server.adoptHandle ?? server.label}`;
}

/**
 * The dot's tone, derived from the row's WORST diagnostic - one classifier, never a second
 * computed beside it. An advisory-only row stays plain "ok": an advisory means nothing is
 * wrong, and tinting the dot for one would be the false alarm the tier itself refuses.
 */
function pillTone(
	verdict: ServerHealthVerdict,
	worst: DiagnosticSeverity | undefined
): "ok" | "warn" | "error" | "muted" {
	if (verdict === "unchecked") {
		// No verdict to tone yet - and no diagnostic either, which would read as health.
		return "muted";
	}
	switch (worst) {
		case "blocking":
			return "error";
		case "degraded":
			return "warn";
		default:
			return "ok";
	}
}

/**
 * Every English word the status pill can say: serverHealth's seven verdicts
 * collapse onto these six ("Connected" covers both the clean and the
 * expected-serving states). The literals repeat in pillVerdict below because
 * l10n extraction only sees a bare string literal inside l10n.t, so this union
 * is the vocabulary's declared shape rather than its derivation: the bun
 * statusVocabulary suite compile-pins the cross-surface table's word list to it
 * and asserts the rendered pill words equal the table's, verdict by covered
 * verdict.
 */
export type ServerPillWord =
	| "Connected"
	| "Sync issue"
	| "Error"
	| "Not checked"
	| "Expected failure"
	| "Misconfigured";

/**
 * The verdict said in words. Words only, no hover tips: the pill sits inside the
 * disclosure button, and a focusable tip wrapper inside a button is a nesting fault.
 */
function pillVerdict(verdict: ServerHealthVerdict): string {
	switch (verdict) {
		case "misconfigured":
			return l10n.t("Misconfigured");
		case "unchecked":
			return l10n.t("Not checked");
		case "serving":
			return l10n.t("Connected");
		case "degraded":
			// Serving through a failed sync, whichever state carries it - the same
			// degraded rank the row's diagnostic holds, so word and dot agree.
			return l10n.t("Sync issue");
		case "blocking":
			return l10n.t("Error");
		case "expected":
			// One state, one name across tabs: still-serving reads Connected here exactly as
			// the Diagnostics grid reads it OK.
			return l10n.t("Connected");
		case "expected-blocking":
			return l10n.t("Expected failure");
	}
}

/**
 * The row's status pill: tone dot, verdict, and discovery age. Word and tone read the same
 * classifiers the row's diagnostics rank by, so the pill can never drift from the lines.
 */
function StatusPill({
	server,
	worst,
	now,
}: {
	server: DashboardServer;
	/** The row's worst diagnostic severity; absent when the row has no problems. */
	worst: DiagnosticSeverity | undefined;
	now: number;
}) {
	const verdict = serverHealth(server);
	const checked = server.lastChecked === undefined ? undefined : relativeTime(server.lastChecked, now);
	// An unchecked row has no time to show, and "just now" would be a lie.
	const time = checked === undefined || verdict === "unchecked" ? null : <span className="pill-time">{checked}</span>;
	return (
		<span className={`pill tone-${pillTone(verdict, worst)}`}>
			<span className="dot" />
			{pillVerdict(verdict)}
			{time}
		</span>
	);
}

function ServerRow({
	server,
	usage,
	spend,
	now,
	armed,
	onEdit,
	onArmRemove,
	onHideExternal,
	onShowModels,
	retrying,
	syncBusy,
	onRetry,
	onDeclareExpected,
	declaring,
	refreshing,
	refreshingExplicitly,
}: {
	server: DashboardServer;
	/** The server's usage card, denied cards included; absent when the proxy serves no usage data. */
	usage: UsageServerCardView | undefined;
	/** The snapshot-wide spend inputs (thresholds, currency, polling, timeout). */
	spend: SpendContext;
	now: number;
	armed: boolean;
	onEdit: () => void;
	onArmRemove: (armed: boolean) => void;
	/** Posts the hideExternalServer intent for this row; the section owns the requestId and the follow-up notice. */
	onHideExternal: (server: ExternalDashboardServer) => void;
	onShowModels: ((label: string) => void) | undefined;
	/** A sync this row asked for is in flight; the section clears it on the next push. */
	retrying: boolean;
	/** A sync is in flight for some row; the command is fleet-wide, so none may start another. */
	syncBusy: boolean;
	onRetry: () => void;
	/** Posts the declareExpectedFailure intent for this declared row; the section owns the requestId. */
	onDeclareExpected: (category: ExpectedFailureCategory) => void;
	/** This row's declare intent is unanswered. */
	declaring: boolean;
	/** A usage refresh is in flight; every Refresh now states it and refuses a second post. */
	refreshing: boolean;
	/** That pass was explicitly requested; only then does a Refresh now wear its busy label. */
	refreshingExplicitly: boolean;
}) {
	const confirmRemove = () => {
		sendRequest("removeServerSetting", { label: server.label });
		onArmRemove(false);
	};
	// The declare control's confirm step, per row (row identity is keyed, so a push cannot
	// re-associate the armed state). The pair survives the post - that is where
	// "Declaring..." renders - and disarms when the round trip ends, either answer.
	const [armedDeclare, setArmedDeclare] = useState<ExpectedFailureCategory | undefined>(undefined);
	useEffect(() => {
		if (!declaring) {
			setArmedDeclare(undefined);
		}
	}, [declaring]);
	// Local state on purpose: a push that reorders rows keeps each drawer with its keyed
	// row, and a closed dashboard forgets, exactly like the model rows.
	const [open, setOpen] = useState(false);
	const drawerId = useId();
	const { lines: diagnostics, usageDetailsCarried } = serverDiagnostics(server, usage, spend, {
		onEdit,
		onRetry,
		retrying,
		syncBusy,
		refreshing,
		refreshingExplicitly,
		onRefreshUsage: () => sendRequest("refreshUsage", null),
		...(server.origin === "declared"
			? { onDeclareExpected, armedDeclare, onArmDeclare: setArmedDeclare, declaring }
			: {}),
	});
	// The pill and the attention count read the FULL ranked list; only the lines split by
	// placement, so a drawer-deferred warning still signals.
	const rowDiagnostics = diagnostics.filter((diagnostic) => diagnostic.placement !== "drawer");
	const drawerDiagnostics = diagnostics.filter((diagnostic) => diagnostic.placement === "drawer");
	const url = urlParts(server.baseUrl);
	const usageNumbers = usage?.kind === "usage" ? usage : undefined;
	return (
		// The actions are revealed by hover AND focus-within: hover alone would put Remove out
		// of the keyboard's reach entirely.
		<li className="server-item">
			<div className="server-row">
				{/* One disclosure button for the whole readable block, actions as its sibling
				    (a button cannot contain a button); the chevron is decoration, aria-expanded
				    announces. border-control-outline: transparent in ordinary themes (no
				    preflight, so a bare button wears the UA's box), the contrast border under
				    high contrast. The hover/open wash lives on the WRAPPER row (:has rules):
				    the button stops short of the actions column, and a wash that stopped with
				    it cut the row into two boxes. */}
				<button
					type="button"
					className="server-line rounded-sm border border-control-outline text-left focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset-inset) focus-visible:outline-ring focus-visible:outline-solid"
					aria-expanded={open}
					// Only while the drawer exists: aria-controls at an unmounted id dangles.
					aria-controls={open ? drawerId : undefined}
					onClick={() => setOpen(!open)}
				>
					<DisclosureChevron className="server-chevron" />
					<span className="server-name">
						<span className="server-label-text">{server.label}</span>
						{server.origin === "misconfigured" ? <span className="server-tag">{l10n.t("not in use")}</span> : null}
					</span>
					<span className="server-status">
						<StatusPill server={server} worst={diagnostics[0]?.severity} now={now} />
					</span>
					{/* The row's second line when narrow, nothing when wide: display: contents
					    hands these four straight to the button's grid, so one markup carries both
					    shapes; the stylesheet names the columns, not this order. */}
					<span className="server-meta">
						<span className="server-url">
							{/* The scheme is its own element so the stylesheet can hide it from the
							    paint alone. */}
							{url.scheme.length > 0 ? (
								<span className={url.quiet ? "url-scheme visually-hidden" : "url-scheme"}>{url.scheme}</span>
							) : null}
							<UrlBreaks text={url.rest} />
						</span>
						<span className="server-count">
							{/* The count carries its own noun. Plain text here (a button cannot contain
							    a button); the link into the scoped Models list lives in the drawer. */}
							<span className="count-plain">
								{server.servedModelCount === 1 ? l10n.t("1 model") : l10n.t("{0} models", server.servedModelCount)}
							</span>
						</span>
						<span className="server-usage">
							<SpendUnit usage={usageNumbers} thresholds={spend.thresholds} currencySymbol={spend.currencySymbol} />
						</span>
						<span className="server-badges">
							{/* The credential kind is the information, so it is the visible text.
							    Badges assert presence only: both "absent" and the pre-proof
							    "unknown" stay blank here, and the drawer's Authentication fact
							    tells the two apart. */}
							{server.hasOAuth || server.credentials === "present" ? (
								<Badge>{server.hasOAuth ? "OAuth" : l10n.t("API key")}</Badge>
							) : null}
							{/* Provenance is the drawer's Origin fact; a hover tip here would be a
							    focusable wrapper inside this button. */}
							{server.origin === "external" ? <Badge>{l10n.t("external")}</Badge> : null}
						</span>
					</span>
				</button>
				<span className={armed ? "server-actions armed" : "server-actions"}>
					{armed ? (
						<>
							{/* At the narrowest tier the armed pair covers ALL of the row, so the name
							    the reader is checking against goes inside the cover there, ellipsized;
							    the stylesheet hides it above, where the row's own name still stands.
							    The buttons carry the label in their accessible names at every tier,
							    LEADING with their visible words (Label in Name). */}
							<span className="armed-subject">{server.label}</span>
							<Button
								variant="danger"
								size="compact"
								aria-label={l10n.t("Confirm remove? {0}", server.label)}
								onClick={() => {
									// The same two-step confirm for every origin; only the intent differs
									// (setting removal by label vs. hiding by tombstone).
									if (server.origin === "external") {
										onHideExternal(server);
										onArmRemove(false);
									} else {
										confirmRemove();
									}
								}}
							>
								{l10n.t("Confirm remove?")}
							</Button>
							<Button
								variant="secondary"
								size="compact"
								aria-label={l10n.t("Cancel removing {0}", server.label)}
								onClick={() => onArmRemove(false)}
							>
								{l10n.t("Cancel")}
							</Button>
						</>
					) : (
						<>
							{/* A misconfigured entry has no Edit: it cannot round-trip the form without
							    rewriting what the user typed, and the blocking line beneath the row
							    already carries the fix action (reveal the setting). */}
							{server.origin === "misconfigured" ? null : (
								<Button
									variant="secondary"
									size="compact"
									aria-label={l10n.t("Edit {0}", server.label)}
									onClick={onEdit}
								>
									{l10n.t("Edit")}
								</Button>
							)}
							<Button
								variant="danger"
								size="compact"
								aria-label={l10n.t("Remove {0}", server.label)}
								onClick={() => onArmRemove(true)}
							>
								{l10n.t("Remove")}
							</Button>
						</>
					)}
				</span>
			</div>
			{open ? (
				<div id={drawerId} className="server-drawer">
					<ServerDrawer
						server={server}
						usage={usage}
						notices={drawerDiagnostics}
						carriedDetails={usageDetailsCarried}
						pollingOff={spend.pollingOff}
						discoveryTimeoutMs={spend.discoveryTimeoutMs}
						now={now}
						currencySymbol={spend.currencySymbol}
						onShowModels={onShowModels}
					/>
				</div>
			) : null}
			{/* OUTSIDE the disclosure: an action behind a fold is one most readers never
			    find. */}
			{rowDiagnostics.map((diagnostic) => (
				<ServerDiagnosticLine key={diagnostic.key} diagnostic={diagnostic} />
			))}
			{/* A closed drawer keeps its notices in the ACCESSIBLE tree: the meter's tone is
			    colour, which a screen reader never gets. The open drawer renders the visible
			    line, so the twin stands down with it. */}
			{!open
				? drawerDiagnostics.map((diagnostic) => (
						<div key={diagnostic.key} className="visually-hidden">
							{severityLabel(diagnostic.severity, "server")} {diagnostic.headline}
						</div>
					))
				: null}
		</li>
	);
}

/**
 * The collapsed hidden-groups line. A removed group offers Unhide, which clears the removal
 * tombstone extension-side (the group's models return on the host's next re-resolution, which
 * the extension triggers). A superseded leftover offers nothing: it stays hidden while its
 * entry points at another URL, and the declared row carries the fix.
 */
function HiddenGroupsLine({ hidden }: { hidden: readonly HiddenGroup[] }) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();
	if (hidden.length === 0) {
		return null;
	}
	// One control that states the whole thing. Open drops the count: it is the reason to
	// open the list and says nothing once it is open.
	const label = expanded
		? l10n.t("Hide")
		: hidden.length === 1
			? l10n.t("Show 1 hidden group")
			: l10n.t("Show {0} hidden groups", hidden.length);
	return (
		<div className="hidden-groups">
			<Button
				variant="secondary"
				size="compact"
				aria-expanded={expanded}
				// Only while open: aria-controls at an unmounted id dangles.
				aria-controls={expanded ? listId : undefined}
				onClick={() => setExpanded((value) => !value)}
			>
				{/* The page's disclosure vocabulary; decoration only, aria-expanded announces. */}
				<DisclosureChevron />
				{label}
			</Button>
			{expanded ? (
				<ul id={listId}>
					{hidden.map((group) => (
						// Keyed by the identity pair the unhideServer intent posts.
						<li key={`${group.label}:${group.baseUrl}`}>
							<span className="hidden-label">{group.label}</span> <span className="url">{group.baseUrl}</span>{" "}
							{group.reason === "superseded" ? (
								<span className="hidden-reason">
									{l10n.t(
										"the entry now points at {0}; delete this group in Manage Language Models",
										group.declaredBaseUrl
									)}
								</span>
							) : (
								<Button
									variant="secondary"
									size="compact"
									onClick={() =>
										sendRequest("unhideServer", {
											label: group.label,
											baseUrl: group.baseUrl,
										})
									}
								>
									{l10n.t("Unhide")}
								</Button>
							)}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * The worst FRESH server's spend against its budget - deliberately not a total: two entries
 * sharing a key would count its spend twice. It reads the pushed spentFraction (the host's
 * resolveBudget computed it, never re-divided here) and reduces through the same
 * worstSpendTone as the status bar (docs/usage.md), so the two cannot disagree. A
 * budget-less server contributes nothing.
 */
function worstFreshBudgetFraction(usage: DashboardUsage | undefined): number | undefined {
	const fractions = (usage?.servers ?? []).flatMap((server) =>
		server.kind === "usage" && server.fresh && server.spentFraction !== undefined ? [server.spentFraction] : []
	);
	return worstSpendTone(fractions, usage?.thresholds ?? [])?.worst;
}

/**
 * The header's state summary, every clause a whole sentence fragment so extraction sees
 * literals, not concatenation.
 */
function serversMeta(
	serverCount: number,
	attentionCount: number,
	usage: DashboardUsage | undefined,
	/** A rendered row is showing a stale spend number, so the exclusion is visible and needs its gloss. */
	staleSpendVisible: boolean
): string {
	const clauses = [serverCount === 1 ? l10n.t("1 server") : l10n.t("{0} servers", serverCount)];
	if (attentionCount > 0) {
		clauses.push(attentionCount === 1 ? l10n.t("1 needs attention") : l10n.t("{0} need attention", attentionCount));
	}
	const worst = worstFreshBudgetFraction(usage);
	if (worst !== undefined) {
		// "use", because a bare "budget 87%" reads as budget REMAINING. The freshness gloss
		// appears only when it bites: with no stale spend on the page, it would gloss an
		// exclusion the reader cannot see.
		clauses.push(
			staleSpendVisible
				? l10n.t("worst budget use {0} (stale rows excluded)", formatPercent(worst))
				: l10n.t("worst budget use {0}", formatPercent(worst))
		);
	}
	if (usage?.pollIntervalMs === 0) {
		clauses.push(l10n.t("background polling off (usage.pollInterval 0)"));
	}
	return clauses.join(" - ");
}

export function ServersSection({
	servers,
	hidden = [],
	usage,
	currencySymbol,
	now,
	onShowModels,
	onEditServer,
	onAdoptServer,
	onAddServer,
}: {
	servers: readonly DashboardServer[];
	/** Groups the user's configuration hides (removed, or superseded); rendered as the collapsed hidden-groups line. */
	hidden?: readonly HiddenGroup[];
	/** The pushed usage snapshot; the rows' spend units, drawers, and diagnostics all read it. */
	usage?: DashboardUsage | undefined;
	/** The configured spend prefix (usage.currencySymbol); display only, never a conversion. */
	currencySymbol: string;
	/** The shared clock tick (one useNow in App), so a hidden panel does not run its own interval. */
	now: number;
	/** Scope the models section to one server; absent, the drawers' model counts stay plain text. */
	onShowModels?: ((label: string) => void) | undefined;
	/** A declared row's Edit; the shell opens the edit destination on it. */
	onEditServer: (label: string) => void;
	/** An external row's Edit, which adopts rather than edits; addressed by its opaque handle. */
	onAdoptServer: (handle: string) => void;
	onAddServer: () => void;
}) {
	// One outcome hook per acked method: the failure banners render each hook's latest fail
	// (a later ok retires it), and Dismiss is the hook's reset. Separate hook instances from
	// the open form's own - both see the same envelopes.
	const saveIntent = useIntentOutcome("saveServerSetting");
	const removeIntent = useIntentOutcome("removeServerSetting");
	const adoptIntent = useIntentOutcome("adoptServer");
	const hideIntent = useIntentOutcome("hideExternalServer");
	const unhideIntent = useIntentOutcome("unhideServer");
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	// The row whose Retry is in flight, and the request that will answer it. The id is held,
	// not just the row: useIntentOutcome reports the METHOD's latest envelope whoever
	// posted it, and the rail's Sync button posts the same method. Keyed by row identity
	// (label rides along only for the aria-live text), like the armed Remove.
	const [retrying, setRetrying] = useState<
		{ readonly rowKey: string; readonly label: string; readonly requestId: string } | undefined
	>(undefined);
	// Whether the fleet has ever been checked at all: the live region below needs it so a
	// first-run page does not announce a clean bill of health it never took.
	const newestCheck = latestCheckedMs(servers) ?? 0;
	const syncIntent = useIntentOutcome("syncModels");
	const syncOutcome = syncIntent.outcome;
	// Clear on either answer to THIS row's request; the failure is deliberately not rendered
	// here, because runModelSync already reports every outcome as a VS Code toast.
	useEffect(() => {
		setRetrying((current) => (current !== undefined && syncOutcome?.id === current.requestId ? undefined : current));
	}, [syncOutcome]);
	// The row whose declare-expected intent is unanswered, keyed like the retry state: only
	// the answer to THIS request may clear it - either answer, a failed declare is finished.
	const declareIntent = useIntentOutcome("declareExpectedFailure");
	const [pendingDeclare, setPendingDeclare] = useState<
		{ readonly rowKey: string; readonly label: string; readonly requestId: string } | undefined
	>(undefined);
	const declareOutcome = declareIntent.outcome;
	useEffect(() => {
		setPendingDeclare((current) =>
			current !== undefined && declareOutcome?.id === current.requestId ? undefined : current
		);
	}, [declareOutcome]);
	// The one-time post-adoption notice: the old host-owned group survives (no removal API),
	// so the user is told plainly why models now appear twice.
	const [adoptNotice, setAdoptNotice] = useState<string | undefined>(undefined);
	// The hide round trip: requestId plus the row's label, so the guidance notice can name
	// the exact group to delete once the ack lands. Only the ack crosses the boundary.
	const [pendingHide, setPendingHide] = useState<{ requestId: string; label: string; baseUrl: string } | undefined>(
		undefined
	);
	// The hidden row's label AND base URL: the notice must name the URL, since
	// an unlabeled group's display label is only its URL host, not the name the
	// host's editor or its models file carries.
	const [removedNotice, setRemovedNotice] = useState<{ label: string; baseUrl: string } | undefined>(undefined);
	const pendingHideRequestId = pendingHide?.requestId;
	const pendingHideLabel = pendingHide?.label;
	const pendingHideBaseUrl = pendingHide?.baseUrl;
	const hideOutcome = hideIntent.outcome;
	useEffect(() => {
		if (
			pendingHideRequestId !== undefined &&
			pendingHideLabel !== undefined &&
			pendingHideBaseUrl !== undefined &&
			hideOutcome?.result === "ok" &&
			hideOutcome.id === pendingHideRequestId
		) {
			setRemovedNotice({ label: pendingHideLabel, baseUrl: pendingHideBaseUrl });
			setPendingHide(undefined);
		}
	}, [hideOutcome, pendingHideRequestId, pendingHideLabel, pendingHideBaseUrl]);
	const hideExternal = (server: ExternalDashboardServer) => {
		const requestId = hideIntent.send({ baseUrl: server.baseUrl, sourceHandle: server.adoptHandle });
		setPendingHide({ requestId, label: server.label, baseUrl: server.baseUrl });
	};
	const saveFailure = saveIntent.outcome?.result === "fail" ? saveIntent.outcome : undefined;
	const removeFailure = removeIntent.outcome?.result === "fail" ? removeIntent.outcome : undefined;
	const adoptFailure = adoptIntent.outcome?.result === "fail" ? adoptIntent.outcome : undefined;
	const hideFailure = hideIntent.outcome?.result === "fail" ? hideIntent.outcome : undefined;
	const unhideFailure = unhideIntent.outcome?.result === "fail" ? unhideIntent.outcome : undefined;
	const declareFailure = declareIntent.outcome?.result === "fail" ? declareIntent.outcome : undefined;
	const noServers = servers.length === 0;
	// The snapshot's spend inputs once, read by rows, diagnostics, and header meta alike, so
	// a threshold can never rank a row differently from the line under it.
	const spend: SpendContext = {
		thresholds: usage?.thresholds ?? [],
		currencySymbol,
		pollingOff: usage?.pollIntervalMs === 0,
		discoveryTimeoutMs: usage?.discoveryTimeoutMs ?? 0,
	};
	// Usage is keyed by label (the usage store's documented join key), so only declared rows
	// look it up; a URL spelling difference must not break the join. Denied cards join too -
	// they carry the row's usage-denied diagnostic.
	const usageByLabel = new Map((usage?.servers ?? []).map((view) => [view.label, view] as const));
	const usageFor = (server: DashboardServer) =>
		server.origin === "declared" ? usageByLabel.get(server.label) : undefined;
	// Rows carrying something worth acting on, read through the same classifier the rows
	// render - a second predicate would drift. Advisories excluded on purpose; a denied
	// usage key counts, per the tier contract's user-ruled carve-out.
	const attentionCount = servers.filter((server) =>
		serverDiagnostics(server, usageFor(server), spend, { onEdit: () => {}, onRetry: () => {} }).lines.some(
			(diagnostic) => diagnostic.severity !== "advisory"
		)
	).length;
	// Whether any rendered row shows a stale spend number - the same join the rows use, so
	// the header's staleness gloss appears exactly when a "stale"-marked figure is on page.
	const staleSpendVisible = servers.some((server) => {
		const card = usageFor(server);
		return card?.kind === "usage" && !card.fresh && card.spend !== undefined;
	});

	// The edit page owns the adopt round trip and leaves on its own ack; this hook sees the
	// same envelope, which is what lets the notice belong to the list, not the page that left.
	const adoptOutcome = adoptIntent.outcome;
	const adoptedId = adoptOutcome?.result === "ok" ? adoptOutcome.id : undefined;
	const adoptedCaveat = adoptOutcome?.result === "ok" ? adoptOutcome.message : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the acked id so one ack raises one notice; the caveat is read at fire time
	useEffect(() => {
		if (adoptedId === undefined) {
			return;
		}
		const base = l10n.t(
			"Adopted into the servers setting. Models appear twice until the original group's object is deleted: open the models file, remove it, reload the window."
		);
		setAdoptNotice(adoptedCaveat !== undefined ? `${base} ${adoptedCaveat}` : base);
	}, [adoptedId]);

	return (
		<Section
			id="servers"
			title={l10n.t("Servers")}
			help={helpServersSection()}
			// The trigger sits near the top of the document, where a tip above it clips.
			helpBelow
			docs={{ href: DOCS_LINK_SERVERS, label: l10n.t("Open the servers guide") }}
			meta={noServers ? undefined : serversMeta(servers.length, attentionCount, usage, staleSpendVisible)}
			// First run shows the guided card alone, not a header of dead disabled buttons.
			actions={
				noServers ? undefined : (
					<>
						<Button onClick={onAddServer}>
							<IconAdd /> {l10n.t("Add server")}
						</Button>
						{/* Fleet-wide usage re-fetch. Disabled during ANY pass (one serialized
						    engine); the busy label only for an EXPLICIT one - a spinner on every
						    scheduled poll read as the app acting unasked. Both labels stay mounted
						    in one grid cell, the hidden one holding the width, so the swap cannot
						    resize the button; check-geometry's servers-refresh-busy pair holds that. */}
						<Button
							variant="secondary"
							className="refresh-usage"
							disabled={usage?.refreshing === true || noServers}
							onClick={() => sendRequest("refreshUsage", null)}
						>
							<span className="grid">
								<span
									className={cn(
										"refresh-busy-label col-start-1 row-start-1 inline-flex items-center justify-center gap-1",
										usage?.refreshingExplicitly === true ? undefined : "invisible"
									)}
									aria-hidden={usage?.refreshingExplicitly === true ? undefined : true}
								>
									<span className="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
								</span>
								<span
									className={cn(
										"refresh-idle-label col-start-1 row-start-1 inline-flex items-center justify-center",
										usage?.refreshingExplicitly === true && "invisible"
									)}
									aria-hidden={usage?.refreshingExplicitly === true ? true : undefined}
								>
									{l10n.t("Refresh now")}
								</span>
							</span>
						</Button>
					</>
				)
			}
		>
			{removedNotice !== undefined ? (
				<div className="notice" role="status">
					<p>
						{l10n.t(
							'Hid "{0}" and its models. VS Code still keeps its provider group at {1}; its name here is only a display label, so find it by that base URL. To delete it for good:',
							removedNotice.label,
							removedNotice.baseUrl
						)}
					</p>
					<ol className="notice-steps">
						<li>
							{l10n.t(
								"Open the models file and remove the object whose baseUrl is {0} from the JSON array.",
								removedNotice.baseUrl
							)}
						</li>
						<li>{l10n.t('Reload the window (Ctrl+Shift+P, "Developer: Reload Window") or restart VS Code.')}</li>
						<li>{l10n.t("Run Sync models.")}</li>
					</ol>
					<div className="toolbar">
						<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openGroupsFile" })}>
							{l10n.t("Open models file")}
						</Button>
						<Button variant="secondary" size="compact" onClick={() => setRemovedNotice(undefined)}>
							{l10n.t("Dismiss")}
						</Button>
					</div>
				</div>
			) : null}
			{adoptNotice !== undefined ? (
				<div className="notice" role="status">
					<p>{adoptNotice}</p>
					<div className="toolbar">
						<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openGroupsFile" })}>
							{l10n.t("Open models file")}
						</Button>
						<Button variant="secondary" size="compact" onClick={() => setAdoptNotice(undefined)}>
							{l10n.t("Dismiss")}
						</Button>
					</div>
				</div>
			) : null}
			{adoptFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={adoptFailure.message}
							{...(adoptFailure.failureKind === "operation"
								? {}
								: { frame: (headline: string) => sectionFailureText(l10n.t("Adopting the server failed:"), headline) })}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={adoptIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{saveFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={saveFailure.message}
							{...(saveFailure.failureKind === "operation"
								? {}
								: { frame: (headline: string) => sectionFailureText(l10n.t("Saving the server failed:"), headline) })}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={saveIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{removeFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={removeFailure.message}
							frame={(headline) => sectionFailureText(l10n.t("Removing failed:"), headline)}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={removeIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{hideFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={hideFailure.message}
							frame={(headline) => sectionFailureText(l10n.t("Hiding the group failed:"), headline)}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={hideIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{unhideFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={unhideFailure.message}
							frame={(headline) => sectionFailureText(l10n.t("Unhiding the group failed:"), headline)}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={unhideIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{declareFailure !== undefined ? (
				<div className="banner banner-error" role="alert">
					<p>
						<FailureText
							message={declareFailure.message}
							frame={(headline) => sectionFailureText(l10n.t("Declaring the expected failure failed:"), headline)}
						/>
					</p>
					<Button variant="secondary" size="compact" onClick={declareIntent.reset}>
						{l10n.t("Dismiss")}
					</Button>
				</div>
			) : null}
			{noServers ? (
				<div className="empty-start">
					<h3>{l10n.t("Connect LiteLLM to Copilot Chat")}</h3>
					<p className="hint">
						{l10n.t("Point the extension at your LiteLLM server and its models appear in Copilot Chat's model picker.")}
					</p>
					<ol>
						<li>{l10n.t("Enter the server's URL - for a local proxy that is usually http://localhost:4000.")}</li>
						<li>{l10n.t("Paste its API key if it needs one; it can stay in VS Code's encrypted secret storage.")}</li>
						<li>{l10n.t("Save. Models sync automatically and show up on this page.")}</li>
					</ol>
					<Button onClick={onAddServer}>{l10n.t("Add your first server")}</Button>
				</div>
			) : (
				<>
					{/* The list's verdict region: polite, one region for the page (per-row
					    announcements on every push are noise). The sighted reader's copy of the
					    count is the header's meta line. */}
					<p className="visually-hidden" role="status" aria-live="polite">
						{attentionCount > 0
							? attentionCount === 1
								? l10n.t("1 server needs attention")
								: l10n.t("{0} servers need attention", attentionCount)
							: newestCheck > 0
								? l10n.t("All servers are healthy")
								: // No verdict yet: "All servers are healthy" would assert a clean bill of
									// health the page has never taken.
									l10n.t("No servers have been checked yet")}
					</p>
					{/* The list's ONE in-flight announcement: a changed accessible name is
					    announced only on the FOCUSED element, and a mouse user's focus never sits
					    on the button they pressed. One region, not per cluster - status regions
					    are atomic, and a fleet-wide flag flips every label at once. */}
					<p className="visually-hidden" role="status" aria-live="polite">
						{[
							retrying !== undefined ? l10n.t("Checking {0}", retrying.label) : undefined,
							pendingDeclare !== undefined
								? l10n.t("Declaring the expected failure for {0}", pendingDeclare.label)
								: undefined,
							usage?.refreshingExplicitly === true ? l10n.t("Refreshing usage data") : undefined,
						]
							.filter((line): line is string => line !== undefined)
							.join("; ")}
					</p>
					<ul className="server-list">
						{servers.map((server) => {
							// Keyed identity (origin plus opaque handle or setting-unique label) so an
							// async push cannot re-associate another server's row with the user's focus.
							const rowKey = serverRowKey(server);
							return (
								<ServerRow
									key={rowKey}
									server={server}
									usage={usageFor(server)}
									spend={spend}
									now={now}
									armed={armedRemove === rowKey}
									onEdit={() => {
										// The one place the destination's purpose is decided: a declared row
										// edits, an external row adopts; the misconfigured guard (no Edit
										// renders) keeps the narrowing honest.
										if (server.origin === "misconfigured") {
											return;
										}
										if (server.origin === "declared") {
											onEditServer(server.label);
											return;
										}
										onAdoptServer(server.adoptHandle);
									}}
									onArmRemove={(armed) => setArmedRemove(armed ? rowKey : undefined)}
									onHideExternal={hideExternal}
									onShowModels={onShowModels}
									retrying={retrying?.rowKey === rowKey}
									syncBusy={retrying !== undefined}
									onRetry={() => {
										setRetrying({ rowKey, label: server.label, requestId: syncIntent.send(null) });
									}}
									onDeclareExpected={(category) => {
										setPendingDeclare({
											rowKey,
											label: server.label,
											requestId: declareIntent.send({ label: server.label, category }),
										});
									}}
									declaring={pendingDeclare?.rowKey === rowKey}
									refreshing={usage?.refreshing === true}
									refreshingExplicitly={usage?.refreshingExplicitly === true}
								/>
							);
						})}
					</ul>
				</>
			)}
			<HiddenGroupsLine hidden={hidden} />
		</Section>
	);
}
