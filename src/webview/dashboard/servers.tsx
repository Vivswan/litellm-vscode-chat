import * as l10n from "@vscode/l10n";
import { useEffect, useId, useState } from "react";
import { latestCheckedMs } from "../../dashboard/presenters";
import { saveFailureDisposition, sectionFailureText } from "../../dashboard/serverForm";
import { formatPercent, worstSpendTone } from "../../dashboard/spendFormat";
import type {
	DashboardServer,
	DashboardUsage,
	ExternalDashboardServer,
	HiddenGroup,
	UsageServerCardView,
	UsageServerView,
} from "../../dashboard/viewModels";
import type { ExpectedFailureCategory } from "../../shared/serverEntry";
import { DOCS_LINK_SERVERS } from "./docsLinks";
import { FailureText } from "./failureText";
import { helpServersSection } from "./helpText";
import { type IntentOutcome, type IntentOutcomeState, useIntentOutcome } from "./hooks";
import { IconAdd } from "./icons";
import { tupleKey } from "./keys";
import type { DrawerNotice, ServerHealthVerdict, SpendContext } from "./serverDiagnostics";
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
 * The list key AND every per-row armed/pending state compare by this, never by the label alone - a declared entry and
 * an external group can wear the same label (labels join only together with the URL), and a label-keyed armed Remove
 * would arm both rows at once.
 */
function serverRowKey(server: DashboardServer): string {
	switch (server.origin) {
		case "legacy":
			return tupleKey(server.origin, server.groupHandle);
		case "external":
			return tupleKey(server.origin, server.adoptHandle);
		default:
			// The URL is part of the key so a re-pointed entry is a new row: an armed Remove or declare never follows
			// the label onto its successor.
			return tupleKey(server.origin, server.label, server.baseUrl);
	}
}

/**
 * The dot's tone, derived from the row's WORST diagnostic - one classifier, never a second computed beside it.
 *
 *   An advisory-only row                                                        -> stays plain "ok"
 *   tinting the dot for one would be the false alarm the tier itself refuses -> stays plain "ok"
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
 * Every English word the status pill can say: serverHealth's seven verdicts collapse onto these six ("Connected" covers
 * both the clean and the expected-serving states). The literals repeat in pillVerdict below because l10n extraction
 * only sees a bare string literal inside l10n.t, so this union is the vocabulary's declared shape rather than its
 * derivation: the bun statusVocabulary suite compile-pins the cross-surface table's word list to it and asserts the
 * rendered pill words equal the table's, verdict by covered verdict.
 */
export type ServerPillWord =
	| "Connected"
	| "Sync issue"
	| "Error"
	| "Not checked"
	| "Expected failure"
	| "Misconfigured";

/**
 * Words only, no hover tips: the pill sits inside the disclosure button, and a focusable tip wrapper inside a button is
 * a nesting fault.
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
			// Serving through a failed sync, whichever state carries it - the same degraded rank the row's diagnostic
			// holds, so word and dot agree.
			return l10n.t("Sync issue");
		case "blocking":
			return l10n.t("Error");
		case "expected":
			// One state, one name across tabs: still-serving reads Connected here exactly as the Diagnostics grid reads
			// it OK.
			return l10n.t("Connected");
		case "expected-blocking":
			return l10n.t("Expected failure");
	}
}

/**
 * Word and tone read the same classifiers the row's diagnostics rank by, so the pill can never drift from the lines.
 */
function StatusPill({
	server,
	worst,
	now,
}: {
	server: DashboardServer;
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

interface ServerLineProps {
	readonly server: DashboardServer;
	readonly open: boolean;
	readonly drawerId: string;
	readonly worst: DiagnosticSeverity | undefined;
	readonly now: number;
	readonly spend: SpendContext;
	readonly usageNumbers: UsageServerView | undefined;
	readonly onToggle: () => void;
}

interface RowActionsClusterProps {
	readonly server: DashboardServer;
	readonly armed: boolean;
	readonly onEdit: () => void;
	readonly onArmRemove: (armed: boolean) => void;
	readonly onConfirmRemove: () => void;
}

/** The credential KIND for the row's badge; the kind is the information, so it is the visible text. */
function credentialBadgeText(server: DashboardServer): string {
	if (server.hasOAuth) {
		return "OAuth";
	}
	return server.hasVirtualKey ? l10n.t("Virtual key") : l10n.t("API key");
}

/**
 * The declare control's confirm step, per row (row identity is keyed, so a push cannot re-associate the armed state).
 * The pair survives the post - that is where "Declaring..." renders - and disarms when the round trip ends, either
 * answer.
 */
function useDeclareArming(
	declaring: boolean
): [ExpectedFailureCategory | undefined, (next: ExpectedFailureCategory | undefined) => void] {
	const [armedDeclare, setArmedDeclare] = useState<ExpectedFailureCategory | undefined>(undefined);
	useEffect(() => {
		if (!declaring) {
			setArmedDeclare(undefined);
		}
	}, [declaring]);
	return [armedDeclare, setArmedDeclare];
}

/**
 * One disclosure button for the whole readable block, actions as its sibling (a button cannot contain a button); the
 * chevron is decoration, aria-expanded announces.
 *
 * The hover/open wash lives on the WRAPPER row (:has rules): the button stops short of the actions column, and a wash
 * that stopped with it cut the row into two boxes. border-control-outline is transparent in ordinary themes and the
 * contrast border under high contrast; with no preflight a bare button wears the UA's box.
 */
function ServerLine({ server, open, drawerId, worst, now, spend, usageNumbers, onToggle }: ServerLineProps) {
	const url = urlParts(server.baseUrl);
	return (
		<button
			type="button"
			className="server-line rounded-sm border border-control-outline text-left focus-visible:outline-(length:--ring-w) focus-visible:outline-offset-(--ring-offset-inset) focus-visible:outline-ring focus-visible:outline-solid"
			aria-expanded={open}
			// Only while the drawer exists: aria-controls at an unmounted id dangles.
			aria-controls={open ? drawerId : undefined}
			onClick={onToggle}
		>
			<DisclosureChevron className="server-chevron" />
			<span className="server-name">
				<span className="server-label-text">{server.label}</span>
				{server.origin === "misconfigured" ? <span className="server-tag">{l10n.t("not in use")}</span> : null}
			</span>
			<span className="server-status">
				<StatusPill server={server} worst={worst} now={now} />
			</span>
			{/* The row's second line when narrow, nothing when wide: display: contents
			    hands these four straight to the button's grid, so one markup carries both
			    shapes; the stylesheet names the columns, not this order. */}
			<span className="server-meta">
				<span className="server-url">
					{/* The scheme is its own element so the stylesheet can hide it from the paint alone. */}
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
					{/* Badges assert presence only: both "absent" and the pre-proof "unknown" stay blank here, and the
					    drawer's Authentication fact tells the two apart. */}
					{server.credentials === "present" ? <Badge>{credentialBadgeText(server)}</Badge> : null}
					{/* Provenance is the drawer's Origin fact; a hover tip here would be a focusable wrapper
					    inside this button. */}
					{server.origin === "external" ? <Badge>{l10n.t("external")}</Badge> : null}
					{server.origin === "legacy" ? <Badge>{l10n.t("legacy")}</Badge> : null}
				</span>
			</span>
		</button>
	);
}

/**
 * The row's action cluster. A legacy leftover has no action: not in the setting (no Edit, no adopt), not the user's
 * own (no hide); the drawer's Origin fact names the deletion route.
 *
 * A misconfigured entry has no Edit: it cannot round-trip the form without rewriting what the user typed, and the
 * blocking line beneath the row already carries the fix action (reveal the setting).
 *
 * At the narrowest tier the armed pair covers ALL of the row, so the name the reader is checking against goes inside
 * the cover there, ellipsized; the stylesheet hides it above, where the row's own name still stands. The buttons carry
 * the label in their accessible names at every tier, LEADING with their visible words (Label in Name).
 */
function RowActionsCluster({ server, armed, onEdit, onArmRemove, onConfirmRemove }: RowActionsClusterProps) {
	if (server.origin === "legacy") {
		return null;
	}
	if (armed) {
		return (
			<>
				<span className="armed-subject">{server.label}</span>
				<Button
					variant="danger"
					size="compact"
					aria-label={l10n.t("Confirm remove? {0}", server.label)}
					onClick={onConfirmRemove}
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
		);
	}
	return (
		<>
			{server.origin === "misconfigured" ? null : (
				<Button variant="secondary" size="compact" aria-label={l10n.t("Edit {0}", server.label)} onClick={onEdit}>
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
	);
}

/**
 * A closed drawer keeps its notices in the ACCESSIBLE tree: the meter's tone is colour, which a screen reader never
 * gets. The open drawer renders the visible line, so the twin stands down with it.
 */
function HiddenNoticeTwins({ open, notices }: { open: boolean; notices: readonly DrawerNotice[] }) {
	if (open) {
		return null;
	}
	return (
		<>
			{notices.map((diagnostic) => (
				<div key={diagnostic.key} className="visually-hidden">
					{severityLabel(diagnostic.severity, "server")} {diagnostic.headline}
				</div>
			))}
		</>
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
	/** The row's server as the host published it; its origin decides which actions the row offers at all. */
	server: DashboardServer;

	/** The server's usage card, denied cards included; absent when the proxy serves no usage data. */
	usage: UsageServerCardView | undefined;

	/** The spend scale and the English detail lines' inputs, shared by every row (serverDiagnostics). */
	spend: SpendContext;

	/** The shared clock tick (one useNow in App); the status pill's relative times read it. */
	now: number;

	/** The two-step remove is in its confirm step; the section holds it per row, so one row at most is armed. */
	armed: boolean;

	/** Open this entry's edit page; the Edit button and the diagnostics' reveal actions share it. */
	onEdit: () => void;

	/** Arm (Remove) or disarm (Cancel, or the confirm itself) the two-step remove. */
	onArmRemove: (armed: boolean) => void;

	/** Posts the hideExternalServer intent for this row; the section owns the requestId and the follow-up notice. */
	onHideExternal: (server: ExternalDashboardServer) => void;

	/** Scope the models section to this server, from the drawer; absent, its model count stays plain text. */
	onShowModels: ((label: string) => void) | undefined;

	/** A sync this row asked for is in flight. */
	retrying: boolean;

	/** A sync is in flight for some row; the command is fleet-wide, so none may start another. */
	syncBusy: boolean;

	/** Post the sync retry; the diagnostics' Retry action's click. */
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
		sendRequest("removeServerSetting", { label: server.label, baseUrl: server.baseUrl });
		onArmRemove(false);
	};
	const [armedDeclare, setArmedDeclare] = useDeclareArming(declaring);
	// Local state on purpose: a push that reorders rows keeps each drawer with its keyed row, and a closed dashboard
	// forgets, exactly like the model rows.
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
	// The pill and the attention count read the FULL ranked list; only the lines split by placement, so a
	// drawer-deferred warning still signals.
	const rowDiagnostics = diagnostics.filter((diagnostic) => diagnostic.placement !== "drawer");
	const drawerDiagnostics = diagnostics.filter((diagnostic) => diagnostic.placement === "drawer");
	const usageNumbers = usage?.kind === "usage" ? usage : undefined;
	const confirm = () => {
		if (server.origin === "external") {
			onHideExternal(server);
			onArmRemove(false);
		} else {
			confirmRemove();
		}
	};
	return (
		// The actions are revealed by hover AND focus-within: hover alone would put Remove out of the keyboard's reach
		// entirely.
		<li className="server-item">
			<div className="server-row">
				<ServerLine
					server={server}
					open={open}
					drawerId={drawerId}
					worst={diagnostics[0]?.severity}
					now={now}
					spend={spend}
					usageNumbers={usageNumbers}
					onToggle={() => setOpen(!open)}
				/>
				<span className={armed ? "server-actions armed" : "server-actions"}>
					<RowActionsCluster
						server={server}
						armed={armed}
						onEdit={onEdit}
						onArmRemove={onArmRemove}
						onConfirmRemove={confirm}
					/>
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
			{/* OUTSIDE the disclosure: an action behind a fold is one most readers never find. */}
			{rowDiagnostics.map((diagnostic) => (
				<ServerDiagnosticLine key={diagnostic.key} diagnostic={diagnostic} />
			))}
			<HiddenNoticeTwins open={open} notices={drawerDiagnostics} />
		</li>
	);
}

/**
 * An operation failure's message already names the write it followed ("saved, but ..."), so it stands without a
 * heading; a list-owned intent's failure takes the heading that names the action.
 */
function IntentFailureBanner({
	message,
	heading,
	onDismiss,
}: {
	message: string;
	heading?: string;
	onDismiss: () => void;
}) {
	return (
		<div className="banner banner-error" role="alert">
			<p>
				<FailureText
					message={message}
					{...(heading === undefined ? {} : { frame: (headline: string) => sectionFailureText(heading, headline) })}
				/>
			</p>
			<Button variant="secondary" size="compact" onClick={onDismiss}>
				{l10n.t("Dismiss")}
			</Button>
		</div>
	);
}

/** The failures that reach the list from an intent the edit page posts: the page keeps the rest (saveFailureDisposition). */
function closingFailure(outcome: IntentOutcome | undefined): (IntentOutcome & { result: "fail" }) | undefined {
	return outcome?.result === "fail" && saveFailureDisposition(outcome.failureKind) === "close" ? outcome : undefined;
}

/**
 * A removed group offers Unhide, which clears the removal tombstone extension-side (the group's models return on the
 * host's next re-resolution, which the extension triggers), and the routes to a real deletion: the models file
 * always, and Manage Language Models searched for the synced name when the sync created the group. A superseded
 * leftover offers nothing: it stays hidden while its entry points at another URL, and the declared row carries the
 * fix.
 */
function HiddenGroupsLine({ hidden }: { hidden: readonly HiddenGroup[] }) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();
	if (hidden.length === 0) {
		return null;
	}
	// Open drops the count: it is the reason to open the list and says nothing once it is open.
	let label = l10n.t("Show {0} hidden groups", hidden.length);
	if (expanded) {
		label = l10n.t("Hide");
	} else if (hidden.length === 1) {
		label = l10n.t("Show 1 hidden group");
	}
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
						// A removed group and a superseded leftover can share the pair; the reason tells them apart.
						<li key={tupleKey(group.reason, group.label, group.baseUrl)}>
							<span className="hidden-label">{group.label}</span> <span className="url">{group.baseUrl}</span>{" "}
							{group.reason === "superseded" ? (
								<span className="hidden-reason">
									{l10n.t(
										"the entry now points at {0}; delete this group in Manage Language Models",
										group.declaredBaseUrl
									)}
								</span>
							) : (
								<>
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
									</Button>{" "}
									{group.syncedName === undefined ? null : (
										<>
											<Button
												variant="secondary"
												size="compact"
												onClick={() =>
													sendRequest("manageHiddenGroup", {
														label: group.label,
														baseUrl: group.baseUrl,
													})
												}
											>
												{l10n.t("Manage Language Models")}
											</Button>{" "}
										</>
									)}
									<Button
										variant="secondary"
										size="compact"
										onClick={() => sendRequest("executeCommand", { command: "openGroupsFile" })}
									>
										{l10n.t("Open Models File")}
									</Button>{" "}
									<span className="hidden-reason">
										{group.syncedName === undefined
											? l10n.t(
													"VS Code still keeps this group; delete its object from the models file, then reload the window"
												)
											: l10n.t(
													"VS Code still keeps this group; delete it in Manage Language Models or from the models file, then reload the window"
												)}
									</span>
								</>
							)}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * The worst FRESH server's spend against its budget - deliberately not a total: two entries sharing a key would count
 * its spend twice.
 *
 *   the pushed spentFraction       -> the host's resolveBudget computed it, never re-divided here
 *   the status bar (docs/usage.md) -> reduces through the same worstSpendTone
 */
function worstFreshBudgetFraction(usage: DashboardUsage | undefined): number | undefined {
	const fractions = (usage?.servers ?? []).flatMap((server) =>
		server.kind === "usage" && server.fresh && server.spentFraction !== undefined ? [server.spentFraction] : []
	);
	return worstSpendTone(fractions, usage?.thresholds ?? [])?.worst;
}

/**
 * The header's state summary, every clause a whole sentence fragment so extraction sees literals, not concatenation.
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
		// "use", because a bare "budget 87%" reads as budget REMAINING. The freshness gloss appears only when it bites:
		// with no stale spend on the page, it would gloss an exclusion the reader cannot see.
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

/** A row's in-flight request: the row it belongs to, its label for the aria-live text, and the id the answer echoes. */
interface RowRequest {
	readonly rowKey: string;
	readonly label: string;
	readonly requestId: string;
}

/** The hide round trip's two ends: the pending request and, once acked, the guidance notice naming the hidden group. */
interface HideRoundTrip {
	readonly removedNotice: { readonly label: string; readonly baseUrl: string } | undefined;
	readonly dismiss: () => void;
	readonly hideExternal: (server: ExternalDashboardServer) => void;
}

/** The outcome hooks the list owns, one per acked method; the banners and Dismiss read each hook's latest fail. */
interface ListIntents {
	readonly save: IntentOutcomeState<"saveServerSetting">;
	readonly remove: IntentOutcomeState<"removeServerSetting">;
	readonly adopt: IntentOutcomeState<"adoptServer">;
	readonly hide: IntentOutcomeState<"hideExternalServer">;
	readonly unhide: IntentOutcomeState<"unhideServer">;
	readonly manage: IntentOutcomeState<"manageHiddenGroup">;
	readonly declare: IntentOutcomeState<"declareExpectedFailure">;
}

interface ServerListProps {
	readonly servers: readonly DashboardServer[];
	readonly usageFor: (server: DashboardServer) => UsageServerCardView | undefined;
	readonly spend: SpendContext;
	readonly now: number;
	readonly usage: DashboardUsage | undefined;
	readonly armedRemove: string | undefined;
	readonly onArmRemove: (rowKey: string | undefined) => void;
	readonly retrying: RowRequest | undefined;
	readonly onRetry: (request: RowRequest) => void;
	readonly pendingDeclare: RowRequest | undefined;
	readonly onDeclare: (request: RowRequest) => void;
	readonly syncIntent: IntentOutcomeState<"syncModels">;
	readonly declareIntent: IntentOutcomeState<"declareExpectedFailure">;
	readonly hideExternal: (server: ExternalDashboardServer) => void;
	readonly onShowModels: ((label: string) => void) | undefined;
	readonly onEditServer: (label: string) => void;
	readonly onAdoptServer: (handle: string) => void;
}

/**
 * One row's unanswered request, keyed by row identity (the label rides along only for the aria-live text), like the
 * armed Remove.
 *
 * The id is held, not just the row: useIntentOutcome reports the METHOD's latest envelope whoever posted it (the
 * rail's Sync button posts the same method as a row's Retry). Only the answer to THIS request clears it - either
 * answer, since a failed post is finished too.
 */
function useRowRequest(outcome: IntentOutcome | undefined): [RowRequest | undefined, (next: RowRequest) => void] {
	const [request, setRequest] = useState<RowRequest | undefined>(undefined);
	useEffect(() => {
		setRequest((current) => (current !== undefined && outcome?.id === current.requestId ? undefined : current));
	}, [outcome]);
	return [request, setRequest];
}

/**
 * The hide round trip: requestId plus the row's label and base URL, so the guidance notice can name the exact group
 * to delete once the ack lands. Only the ack crosses the boundary. The notice must name the URL, since an unlabeled
 * group's display label is only its URL host, not the name the host's editor or its models file carries.
 */
function useHideRoundTrip(hideIntent: IntentOutcomeState<"hideExternalServer">): HideRoundTrip {
	const [pending, setPending] = useState<{ requestId: string; label: string; baseUrl: string } | undefined>(undefined);
	const [removedNotice, setRemovedNotice] = useState<{ label: string; baseUrl: string } | undefined>(undefined);
	const pendingRequestId = pending?.requestId;
	const pendingLabel = pending?.label;
	const pendingBaseUrl = pending?.baseUrl;
	const hideOutcome = hideIntent.outcome;
	useEffect(() => {
		if (
			pendingRequestId !== undefined &&
			pendingLabel !== undefined &&
			pendingBaseUrl !== undefined &&
			hideOutcome?.result === "ok" &&
			hideOutcome.id === pendingRequestId
		) {
			setRemovedNotice({ label: pendingLabel, baseUrl: pendingBaseUrl });
			setPending(undefined);
		}
	}, [hideOutcome, pendingRequestId, pendingLabel, pendingBaseUrl]);
	return {
		removedNotice,
		dismiss: () => setRemovedNotice(undefined),
		hideExternal: (server) => {
			const requestId = hideIntent.send({ baseUrl: server.baseUrl, sourceHandle: server.adoptHandle });
			setPending({ requestId, label: server.label, baseUrl: server.baseUrl });
		},
	};
}

/**
 * The one-time post-adoption notice: the old host-owned group survives (no removal API), so the user is told plainly
 * why models now appear twice. The edit page owns the adopt round trip and leaves on its own ack; this hook sees the
 * same envelope, which is what lets the notice belong to the list, not the page that left.
 */
function useAdoptNotice(adoptOutcome: IntentOutcome | undefined): [string | undefined, () => void] {
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const adoptedId = adoptOutcome?.result === "ok" ? adoptOutcome.id : undefined;
	const adoptedCaveat = adoptOutcome?.result === "ok" ? adoptOutcome.message : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the acked id so one ack raises one notice
	useEffect(() => {
		if (adoptedId === undefined) {
			return;
		}
		const base = l10n.t(
			"Adopted into the servers setting. Models appear twice until the original group's object is deleted: open the models file, remove it, reload the window."
		);
		setNotice(adoptedCaveat === undefined ? base : `${base} ${adoptedCaveat}`);
	}, [adoptedId]);
	return [notice, () => setNotice(undefined)];
}

/** The snapshot's spend inputs once, read by rows, diagnostics, and header meta alike, so a threshold can never rank a row differently from the line under it. */
function spendContext(usage: DashboardUsage | undefined, currencySymbol: string): SpendContext {
	return {
		thresholds: usage?.thresholds ?? [],
		currencySymbol,
		pollingOff: usage?.pollIntervalMs === 0,
		discoveryTimeoutMs: usage?.discoveryTimeoutMs ?? 0,
	};
}

/**
 * Rows carrying something worth acting on, read through the same classifier the rows render - a second predicate would
 * drift. Advisories excluded on purpose; a denied usage key counts, per the tier contract's user-ruled carve-out.
 */
function countAttention(
	servers: readonly DashboardServer[],
	usageFor: (server: DashboardServer) => UsageServerCardView | undefined,
	spend: SpendContext
): number {
	return servers.filter((server) =>
		serverDiagnostics(server, usageFor(server), spend, { onEdit: () => {}, onRetry: () => {} }).lines.some(
			(diagnostic) => diagnostic.severity !== "advisory"
		)
	).length;
}

/** Whether any rendered row shows a stale spend number, through the same join the rows use. */
function anyStaleSpend(
	servers: readonly DashboardServer[],
	usageFor: (server: DashboardServer) => UsageServerCardView | undefined
): boolean {
	return servers.some((server) => {
		const card = usageFor(server);
		return card?.kind === "usage" && !card.fresh && card.spend !== undefined;
	});
}

/**
 * The list's verdict for its live region. No verdict yet: "All servers are healthy" would assert a clean bill of health
 * the page has never taken.
 */
function verdictLine(attentionCount: number, newestCheck: number): string {
	if (attentionCount === 1) {
		return l10n.t("1 server needs attention");
	}
	if (attentionCount > 1) {
		return l10n.t("{0} servers need attention", attentionCount);
	}
	return newestCheck > 0 ? l10n.t("All servers are healthy") : l10n.t("No servers have been checked yet");
}

/** The list's ONE in-flight announcement, every pass in flight joined into one sentence. */
function inFlightLine(
	retrying: RowRequest | undefined,
	pendingDeclare: RowRequest | undefined,
	usage: DashboardUsage | undefined
): string {
	return [
		retrying === undefined ? undefined : l10n.t("Checking {0}", retrying.label),
		pendingDeclare === undefined ? undefined : l10n.t("Declaring the expected failure for {0}", pendingDeclare.label),
		usage?.refreshingExplicitly === true ? l10n.t("Refreshing usage data") : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("; ");
}

/**
 * The one place the destination's purpose is decided: a declared row edits, an external row adopts; the misconfigured
 * guard (no Edit renders) keeps the narrowing honest.
 */
function openEditDestination(
	server: DashboardServer,
	onEditServer: (label: string) => void,
	onAdoptServer: (handle: string) => void
): void {
	if (server.origin === "misconfigured" || server.origin === "legacy") {
		return;
	}
	if (server.origin === "declared") {
		onEditServer(server.label);
		return;
	}
	onAdoptServer(server.adoptHandle);
}

/**
 * Refresh now: disabled during ANY pass (one serialized engine); the busy label only for an EXPLICIT one - a spinner
 * on every scheduled poll read as the app acting unasked. Both labels stay mounted in one grid cell, the hidden one
 * holding the width, so the swap cannot resize the button; check-geometry's servers-refresh-busy pair holds that.
 */
function RefreshUsageButton({ usage, disabled }: { usage: DashboardUsage | undefined; disabled: boolean }) {
	const explicit = usage?.refreshingExplicitly === true;
	return (
		<Button
			variant="secondary"
			className="refresh-usage"
			disabled={usage?.refreshing === true || disabled}
			onClick={() => sendRequest("refreshUsage", null)}
		>
			<span className="grid">
				<span
					className={cn(
						"refresh-busy-label col-start-1 row-start-1 inline-flex items-center justify-center gap-1",
						explicit ? undefined : "invisible"
					)}
					aria-hidden={explicit ? undefined : true}
				>
					<span className="spinner" aria-hidden="true" /> {l10n.t("Refreshing...")}
				</span>
				<span
					className={cn(
						"refresh-idle-label col-start-1 row-start-1 inline-flex items-center justify-center",
						explicit && "invisible"
					)}
					aria-hidden={explicit ? true : undefined}
				>
					{l10n.t("Refresh now")}
				</span>
			</span>
		</Button>
	);
}

/** The guidance notice after a hide: how to delete the host-owned group for good. */
function RemovedNotice({ notice, onDismiss }: { notice: { label: string; baseUrl: string }; onDismiss: () => void }) {
	return (
		<div className="notice" role="status">
			<p>
				{l10n.t(
					'Hid "{0}" and its models. VS Code still keeps its provider group at {1}; its name here is only a display label, so find it by that base URL. To delete it for good:',
					notice.label,
					notice.baseUrl
				)}
			</p>
			<ol className="notice-steps">
				<li>
					{l10n.t(
						"Open the models file and remove the object whose baseUrl is {0} from the JSON array.",
						notice.baseUrl
					)}
				</li>
				<li>{l10n.t('Reload the window (Ctrl+Shift+P, "Developer: Reload Window") or restart VS Code.')}</li>
				<li>{l10n.t("Run Sync models.")}</li>
			</ol>
			<div className="toolbar">
				<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openGroupsFile" })}>
					{l10n.t("Open models file")}
				</Button>
				<Button variant="secondary" size="compact" onClick={onDismiss}>
					{l10n.t("Dismiss")}
				</Button>
			</div>
		</div>
	);
}

/** The post-adoption notice with the models-file route beside it. */
function AdoptNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
	return (
		<div className="notice" role="status">
			<p>{text}</p>
			<div className="toolbar">
				<Button variant="secondary" onClick={() => sendRequest("executeCommand", { command: "openGroupsFile" })}>
					{l10n.t("Open models file")}
				</Button>
				<Button variant="secondary" size="compact" onClick={onDismiss}>
					{l10n.t("Dismiss")}
				</Button>
			</div>
		</div>
	);
}

/**
 * The list's failure banners, one per acked method. The edit page keeps a validation failure beside the draft it
 * refused; the list hears the same envelope and shows only the failures whose disposition closed the page.
 */
function FailureBanners({ intents }: { intents: ListIntents }) {
	const failed = (state: { readonly outcome: IntentOutcome | undefined }) =>
		state.outcome?.result === "fail" ? state.outcome : undefined;
	const adoptFailure = closingFailure(intents.adopt.outcome);
	const saveFailure = closingFailure(intents.save.outcome);
	const removeFailure = failed(intents.remove);
	const hideFailure = failed(intents.hide);
	const unhideFailure = failed(intents.unhide);
	const manageFailure = failed(intents.manage);
	const declareFailure = failed(intents.declare);
	return (
		<>
			{adoptFailure === undefined ? null : (
				<IntentFailureBanner message={adoptFailure.message} onDismiss={intents.adopt.reset} />
			)}
			{saveFailure === undefined ? null : (
				<IntentFailureBanner message={saveFailure.message} onDismiss={intents.save.reset} />
			)}
			{removeFailure === undefined ? null : (
				<IntentFailureBanner
					message={removeFailure.message}
					heading={l10n.t("Removing failed:")}
					onDismiss={intents.remove.reset}
				/>
			)}
			{hideFailure === undefined ? null : (
				<IntentFailureBanner
					message={hideFailure.message}
					heading={l10n.t("Hiding the group failed:")}
					onDismiss={intents.hide.reset}
				/>
			)}
			{unhideFailure === undefined ? null : (
				<IntentFailureBanner
					message={unhideFailure.message}
					heading={l10n.t("Unhiding the group failed:")}
					onDismiss={intents.unhide.reset}
				/>
			)}
			{manageFailure === undefined ? null : (
				<IntentFailureBanner
					message={manageFailure.message}
					heading={l10n.t("Opening Manage Language Models failed:")}
					onDismiss={intents.manage.reset}
				/>
			)}
			{declareFailure === undefined ? null : (
				<IntentFailureBanner
					message={declareFailure.message}
					heading={l10n.t("Declaring the expected failure failed:")}
					onDismiss={intents.declare.reset}
				/>
			)}
		</>
	);
}

/** First run: the guided card alone, not a header of dead disabled buttons. */
function EmptyStart({ onAddServer }: { onAddServer: () => void }) {
	return (
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
	);
}

/**
 * The rows. Keyed identity (origin plus opaque handle or setting-unique label) so an async push cannot re-associate
 * another server's row with the user's focus.
 */
function ServerList(props: ServerListProps) {
	const { servers, usageFor, spend, now, usage, armedRemove, retrying, pendingDeclare, syncIntent, declareIntent } =
		props;
	return (
		<ul className="server-list">
			{servers.map((server) => {
				const rowKey = serverRowKey(server);
				return (
					<ServerRow
						key={rowKey}
						server={server}
						usage={usageFor(server)}
						spend={spend}
						now={now}
						armed={armedRemove === rowKey}
						onEdit={() => openEditDestination(server, props.onEditServer, props.onAdoptServer)}
						onArmRemove={(armed) => props.onArmRemove(armed ? rowKey : undefined)}
						onHideExternal={props.hideExternal}
						onShowModels={props.onShowModels}
						retrying={retrying?.rowKey === rowKey}
						syncBusy={retrying !== undefined}
						onRetry={() => props.onRetry({ rowKey, label: server.label, requestId: syncIntent.send(null) })}
						onDeclareExpected={(category) =>
							props.onDeclare({
								rowKey,
								label: server.label,
								requestId: declareIntent.send({ label: server.label, baseUrl: server.baseUrl, category }),
							})
						}
						declaring={pendingDeclare?.rowKey === rowKey}
						refreshing={usage?.refreshing === true}
						refreshingExplicitly={usage?.refreshingExplicitly === true}
					/>
				);
			})}
		</ul>
	);
}

/**
 * The Servers page. One outcome hook per acked method: the failure banners render each hook's latest fail (a later ok
 * retires it), and Dismiss is the hook's reset. Separate hook instances from the open form's own - both see the same
 * envelopes.
 *
 * Usage is keyed by label (the usage store's documented join key), so only declared rows look it up; a URL spelling
 * difference must not break the join. Denied cards join too - they carry the row's usage-denied diagnostic.
 *
 *   servers        -> the servers as the host published them, every origin included; one row each
 *   hidden         -> host groups the dashboard hides, tombstoned or superseded, listed under it behind a "Show hidden
 *                     groups" disclosure
 *   usage          -> the usage snapshot: the per-server cards, the alert thresholds, and the refresh state the
 *                     header's button reads
 *   currencySymbol -> the configured spend prefix (usage.currencySymbol); display only, never a conversion
 *   now            -> the shared clock tick (one useNow in App), so a hidden panel does not run its own interval
 *   onShowModels   -> scope the models section to one server; absent, the drawers' model counts stay plain text
 *   onEditServer   -> a declared row's Edit, by the label the setting holds
 *   onAdoptServer  -> an external row's Edit, which adopts rather than edits; addressed by its opaque handle
 *   onAddServer    -> open the add form; the header's button and the empty state's first-server button share it
 */
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
	hidden?: readonly HiddenGroup[];
	usage?: DashboardUsage | undefined;
	currencySymbol: string;
	now: number;
	onShowModels?: ((label: string) => void) | undefined;
	onEditServer: (label: string) => void;
	onAdoptServer: (handle: string) => void;
	onAddServer: () => void;
}) {
	const intents: ListIntents = {
		save: useIntentOutcome("saveServerSetting"),
		remove: useIntentOutcome("removeServerSetting"),
		adopt: useIntentOutcome("adoptServer"),
		hide: useIntentOutcome("hideExternalServer"),
		unhide: useIntentOutcome("unhideServer"),
		manage: useIntentOutcome("manageHiddenGroup"),
		declare: useIntentOutcome("declareExpectedFailure"),
	};
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	// Whether the fleet has ever been checked at all: the live region needs it so a first-run page does not announce a
	// clean bill of health it never took.
	const newestCheck = latestCheckedMs(servers) ?? 0;
	const syncIntent = useIntentOutcome("syncModels");
	// A failed sync is not rendered here: runModelSync already reports every outcome as a VS Code toast.
	const [retrying, setRetrying] = useRowRequest(syncIntent.outcome);
	const [pendingDeclare, setPendingDeclare] = useRowRequest(intents.declare.outcome);
	const [adoptNotice, dismissAdoptNotice] = useAdoptNotice(intents.adopt.outcome);
	const hide = useHideRoundTrip(intents.hide);
	const noServers = servers.length === 0;
	const spend = spendContext(usage, currencySymbol);
	const usageByLabel = new Map((usage?.servers ?? []).map((view) => [view.label, view] as const));
	const usageFor = (server: DashboardServer) =>
		server.origin === "declared" ? usageByLabel.get(server.label) : undefined;
	const attentionCount = countAttention(servers, usageFor, spend);
	return (
		<Section
			id="servers"
			title={l10n.t("Servers")}
			help={helpServersSection()}
			// The trigger sits near the top of the document, where a tip above it clips.
			helpBelow
			docs={{ href: DOCS_LINK_SERVERS, label: l10n.t("Open the servers guide") }}
			meta={
				noServers ? undefined : serversMeta(servers.length, attentionCount, usage, anyStaleSpend(servers, usageFor))
			}
			actions={
				noServers ? undefined : (
					<>
						<Button onClick={onAddServer}>
							<IconAdd /> {l10n.t("Add server")}
						</Button>
						<RefreshUsageButton usage={usage} disabled={noServers} />
					</>
				)
			}
		>
			{hide.removedNotice === undefined ? null : <RemovedNotice notice={hide.removedNotice} onDismiss={hide.dismiss} />}
			{adoptNotice === undefined ? null : <AdoptNotice text={adoptNotice} onDismiss={dismissAdoptNotice} />}
			<FailureBanners intents={intents} />
			{noServers ? (
				<EmptyStart onAddServer={onAddServer} />
			) : (
				<>
					{/* The list's verdict region: polite, one region for the page (per-row announcements on every push
					    are noise). The sighted reader's copy of the count is the header's meta line. */}
					<p className="visually-hidden" role="status" aria-live="polite">
						{verdictLine(attentionCount, newestCheck)}
					</p>
					{/* A changed accessible name is announced only on the FOCUSED element, and a mouse user's focus never
					    sits on the button they pressed. One region, not per cluster - status regions are atomic, and a
					    fleet-wide flag flips every label at once. */}
					<p className="visually-hidden" role="status" aria-live="polite">
						{inFlightLine(retrying, pendingDeclare, usage)}
					</p>
					<ServerList
						servers={servers}
						usageFor={usageFor}
						spend={spend}
						now={now}
						usage={usage}
						armedRemove={armedRemove}
						onArmRemove={setArmedRemove}
						retrying={retrying}
						onRetry={setRetrying}
						pendingDeclare={pendingDeclare}
						onDeclare={setPendingDeclare}
						syncIntent={syncIntent}
						declareIntent={intents.declare}
						hideExternal={hide.hideExternal}
						onShowModels={onShowModels}
						onEditServer={onEditServer}
						onAdoptServer={onAdoptServer}
					/>
				</>
			)}
			<HiddenGroupsLine hidden={hidden} />
		</Section>
	);
}
