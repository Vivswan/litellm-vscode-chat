import * as l10n from "@vscode/l10n";
import { Fragment, useEffect, useRef, useState } from "react";
import { saveFailureDisposition, sectionFailureText } from "../../dashboard/serverForm";
import type {
	DashboardServer,
	DashboardUsage,
	DeclaredDashboardServer,
	ExternalDashboardServer,
	HiddenGroup,
	InactiveEntryNotice,
	MisconfiguredDashboardServer,
	UsageServerView,
} from "../../dashboard/viewModels";
import { statusErrorDetail, statusErrorHeadline } from "../../shared/util/errorText";
import { DOCS_LINK_AUTHENTICATION, DOCS_LINK_PARAMS_INACTIVE, DOCS_LINK_SERVERS } from "./docsLinks";
import { FailureText } from "./failureText";
import { DocsLink, Help, HoverTip } from "./help";
import { helpServersSection } from "./helpText";
import { useIntentOutcome } from "./hooks";
import { IconAdd } from "./icons";
import type { FormTarget, ServerEditRequest } from "./serverEditPage";
import { AdoptForm, observedKeysForForm, ServerForm, troubleshootingLink } from "./serverEditPage";
import { SlideOver } from "./slideOver";
import { relativeTime } from "./time";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { barPresentation, formatPercent, formatUsd } from "./usage";
import { sendRequest } from "./vscodeApi";

/** The entry-only-fields-inactive notice classifications; one merged banner covers them all. */

/**
 * Every inactive notice's user-facing pieces in one table: the notice list,
 * the merged banner's surface phrases, and the row badges all derive from it,
 * so a new notice cannot ship half-wired (the satisfies clause fails to
 * compile until the table names it). Zero-arg functions, so the strings
 * resolve after the l10n bootstrap; surface phrases are plural because the
 * banner appends "are not applied".
 */
const INACTIVE_NOTICE_PRESENTATION = {
	"entry-params-inactive": {
		surface: () => l10n.t("per-server model parameters"),
		badge: () => l10n.t("params inactive"),
		tip: () =>
			l10n.t(
				"Per-server model parameters are not applied: the group serving this entry predates its label or a rename. The banner below has the fix."
			),
	},
	"entry-capabilities-inactive": {
		surface: () => l10n.t("per-server model capabilities, declared models, and expected failures"),
		badge: () => l10n.t("capabilities inactive"),
		tip: () =>
			l10n.t(
				"Per-server model capabilities, declared models, and expected failures are not applied: the group serving this entry predates its label or a rename. The banner below has the fix."
			),
	},
	"entry-headers-inactive": {
		surface: () => l10n.t("per-server custom headers"),
		badge: () => l10n.t("headers inactive"),
		tip: () =>
			l10n.t(
				"Per-server custom headers are not applied: the group serving this entry predates its label or a rename. The banner below has the fix."
			),
	},
	"entry-api-version-inactive": {
		surface: () => l10n.t("per-server API version overrides"),
		badge: () => l10n.t("API version inactive"),
		tip: () =>
			l10n.t(
				"The API version override is not applied, requests use the auto rule: the group serving this entry predates its label or a rename. The banner below has the fix."
			),
	},
} as const satisfies Record<InactiveEntryNotice, { surface: () => string; badge: () => string; tip: () => string }>;

const INACTIVE_NOTICES = Object.keys(INACTIVE_NOTICE_PRESENTATION) as readonly InactiveEntryNotice[];

/**
 * The inactive surfaces one noticed row names, as a short localized phrase
 * ("per-server model parameters, per-server custom headers"). Resolved at
 * call time (no module-level localized constants).
 */
function inactiveSurfacesText(server: DashboardServer): string {
	return INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true)
		.map((notice) => INACTIVE_NOTICE_PRESENTATION[notice].surface())
		.join(", ");
}

/**
 * The row's status pill: tone dot, plain-language verdict, and how long ago
 * discovery last looked. An "ok" row that still carries an error (a live
 * group kept serving while its sync failed) shows the warn tone, as does an
 * expected discovery failure (the entry declared it, so red would be a lie);
 * the error text itself renders in the section's banner, where it is
 * selectable.
 */
function StatusPill({ server, now }: { server: DashboardServer; now: number }) {
	const checked = server.lastChecked === undefined ? undefined : relativeTime(server.lastChecked, now);
	const time = checked === undefined ? null : <span className="pill-time">{checked}</span>;
	if (server.origin === "misconfigured") {
		// Origin outranks state: the entry never reaches discovery, so whatever
		// state rides the row, the verdict is the invalid entry itself.
		return (
			<HoverTip
				focusable
				tip={l10n.t(
					"This entry in the servers setting is invalid and is not used until fixed; the banner below lists the problems."
				)}
			>
				<span className="pill tone-error">
					<span className="dot" />
					{l10n.t("Misconfigured")}
					{time}
				</span>
			</HoverTip>
		);
	}
	if (server.state === "ok") {
		if (server.error !== undefined) {
			return (
				<HoverTip
					focusable
					tip={l10n.t("The server answered, but its last settings sync reported a problem; details below.")}
				>
					<span className="pill tone-warn">
						<span className="dot" />
						{l10n.t("Sync issue")}
						{time}
					</span>
				</HoverTip>
			);
		}
		return (
			<span className="pill tone-ok">
				<span className="dot" />
				{l10n.t("Connected")}
				{time}
			</span>
		);
	}
	if (server.state === "error") {
		if (server.expected === true) {
			const declared = server.declaredModelCount ?? 0;
			// One state, one name across tabs: a row still serving declared
			// models reads Connected here exactly as the Diagnostics grid reads
			// it OK, with the warn tone and tip carrying the expected failure.
			return (
				<HoverTip
					focusable
					tip={
						declared > 0
							? l10n.t(
									"Discovery failed in a category this entry expects; its declared models keep serving. The banner below has the details."
								)
							: l10n.t(
									"Discovery failed in a category this entry expects. Nothing is declared, so no models are served; add IDs to the entry's discovery.declared."
								)
					}
				>
					<span className="pill tone-warn">
						<span className="dot" />
						{declared > 0 ? l10n.t("Connected") : l10n.t("Expected failure")}
						{time}
					</span>
				</HoverTip>
			);
		}
		return (
			<span className="pill tone-error">
				<span className="dot" />
				{l10n.t("Error")}
				{time}
			</span>
		);
	}
	return (
		<HoverTip
			focusable
			tip={l10n.t("Declared in settings; no discovery pass has seen it yet. Run Sync models to check it now.")}
		>
			<span className="pill tone-muted">
				<span className="dot" />
				{l10n.t("Not checked")}
			</span>
		</HoverTip>
	);
}

/** The DashboardServer origins as their own types; Extract keeps them in step with the protocol union. */

/**
 * The external badge's hover tip, from the row's provenance classification.
 * The copy lives here (classifications cross the boundary, words do not):
 * a removed entry's leftover names the removed label, a rename leftover names
 * both labels, and a row without provenance gets the honest default - added
 * outside this extension, or predating the tracking. Deletion instructions
 * name the models file: VS Code offers extensions no group removal, so the
 * file (or VS Code's own UI) is where deleting actually lives.
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
 * The row's spend-at-a-glance, from the same pushed usage snapshot the Usage
 * tab renders: the spend percentage with the Usage tab's severity tone when a
 * budget exists, the plain spend when none does, and nothing at all for a
 * server without usage data (an empty cell, not an "unknown" marker).
 */
function UsageCell({ usage, thresholds }: { usage: UsageServerView | undefined; thresholds: readonly number[] }) {
	if (usage?.spend === undefined) {
		return null;
	}
	if (usage.spentFraction !== undefined) {
		return (
			<span className={`usage-cell tone-${barPresentation(usage.spentFraction, thresholds).tone}`}>
				{formatPercent(usage.spentFraction)}
			</span>
		);
	}
	return <span className="usage-cell">{formatUsd(usage.spend)}</span>;
}

function ServerRow({
	server,
	usage,
	usageThresholds,
	now,
	armed,
	onEdit,
	onArmRemove,
	onHideExternal,
	onShowModels,
}: {
	server: DashboardServer;
	/** The server's usage snapshot entry, when its proxy serves usage data. */
	usage: UsageServerView | undefined;
	/** The usage snapshot's alert thresholds; the cell's severity tone reads them. */
	usageThresholds: readonly number[];
	now: number;
	armed: boolean;
	onEdit: () => void;
	onArmRemove: (armed: boolean) => void;
	/** Posts the hideExternalServer intent for this row; the section owns the requestId and the follow-up notice. */
	onHideExternal: (server: ExternalDashboardServer) => void;
	onShowModels: ((label: string) => void) | undefined;
}) {
	const confirmRemove = () => {
		sendRequest("removeServerSetting", { label: server.label });
		onArmRemove(false);
	};
	return (
		<tr>
			<td>{server.label}</td>
			<td className="url">{server.baseUrl}</td>
			<td data-label={l10n.t("Status")}>
				<StatusPill server={server} now={now} />
			</td>
			<td className="num" data-label={l10n.t("Models")}>
				{/* The count doubles as the bridge to the models section below:
				    clicking it scopes the list to this server. A zero stays plain
				    text, since an empty scoped list has nothing to show. */}
				{onShowModels !== undefined && server.modelCount > 0 ? (
					<Button
						variant="secondary"
						size="compact"
						className="count-link px-1 py-0"
						aria-label={l10n.t("Show models from {0}", server.label)}
						onClick={() => onShowModels(server.label)}
					>
						{server.modelCount}
					</Button>
				) : (
					server.modelCount
				)}
			</td>
			<td className="num" data-label={l10n.t("Usage")}>
				<UsageCell usage={usage} thresholds={usageThresholds} />
			</td>
			<td>
				{/* The credential kind is the information, so it is the visible
				    text; a generic "auth" badge would hide it in a hover tip. */}
				{server.hasApiKey || server.hasOAuth ? <Badge>{server.hasOAuth ? "OAuth" : l10n.t("API key")}</Badge> : null}
				{server.origin === "external" ? (
					<HoverTip focusable tip={externalTip(server)}>
						<Badge>{l10n.t("external")}</Badge>
					</HoverTip>
				) : null}
				{/* Gated on expected: only expected failures fold the declared count
				    into the row's served models; an unexpected failure's declarations
				    are extension bookkeeping, and a badge beside a zero count would
				    contradict the row. */}
				{server.state === "error" && server.expected === true && (server.declaredModelCount ?? 0) > 0 ? (
					<HoverTip
						focusable
						tip={l10n.t(
							"Models declared in the entry's discovery.declared list; they keep serving while discovery fails."
						)}
					>
						<Badge>
							{(server.declaredModelCount ?? 0) === 1
								? l10n.t("1 declared model")
								: l10n.t("{0} declared models", server.declaredModelCount ?? 0)}
						</Badge>
					</HoverTip>
				) : null}
				{INACTIVE_NOTICES.filter((notice) => server.notices?.includes(notice) === true).map((notice) => (
					<HoverTip key={notice} tip={INACTIVE_NOTICE_PRESENTATION[notice].tip()}>
						<Badge variant="warn">{INACTIVE_NOTICE_PRESENTATION[notice].badge()}</Badge>
					</HoverTip>
				))}
			</td>
			<td className={armed ? "actions armed" : "actions"}>
				{armed ? (
					<>
						<Button
							variant="danger"
							onClick={() => {
								// The same two-step confirm for every origin; only the intent
								// differs (a declared or misconfigured entry is removed from
								// the setting by label, an external group is hidden by
								// tombstone).
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
						<Button variant="secondary" size="compact" onClick={() => onArmRemove(false)}>
							{l10n.t("Cancel")}
						</Button>
					</>
				) : (
					<>
						{/* A misconfigured entry cannot round-trip through the edit form
						    without rewriting what the user typed, so its fix action
						    reveals the setting instead of opening the form. */}
						{server.origin === "misconfigured" ? (
							<Button
								variant="secondary"
								size="compact"
								onClick={() => sendRequest("revealSetting", { setting: "servers" })}
							>
								{l10n.t("Fix in settings.json")}
							</Button>
						) : (
							<Button variant="secondary" size="compact" onClick={onEdit}>
								{l10n.t("Edit")}
							</Button>
						)}
						{/* A legacy-registry external row is not hideable (the registry
						    path would keep serving its models), so it keeps Edit only. */}
						{server.origin === "declared" || server.origin === "misconfigured" || server.hideable ? (
							<Button variant="danger" onClick={() => onArmRemove(true)}>
								{l10n.t("Remove")}
							</Button>
						) : null}
					</>
				)}
			</td>
		</tr>
	);
}

/**
 * The collapsed hidden-groups line: one muted sentence stating the count,
 * expandable to a row per hidden group with its Unhide. Unhide clears the
 * removal tombstone extension-side; the group's models return on the host's
 * next re-resolution, which the extension triggers itself.
 */
function HiddenGroupsLine({ hidden }: { hidden: readonly HiddenGroup[] }) {
	const [expanded, setExpanded] = useState(false);
	if (hidden.length === 0) {
		return null;
	}
	return (
		<div className="hidden-groups">
			<p className="hint">
				{hidden.length === 1 ? l10n.t("1 hidden group") : l10n.t("{0} hidden groups", hidden.length)} -{" "}
				<Button
					variant="secondary"
					size="compact"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? l10n.t("hide") : l10n.t("show")}
				</Button>
			</p>
			{expanded ? (
				<ul>
					{hidden.map((group) => (
						// Keyed by the identity pair the unhideServer intent posts.
						<li key={`${group.label}:${group.baseUrl}`}>
							<span className="hidden-label">{group.label}</span> <span className="url">{group.baseUrl}</span>{" "}
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
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function ServersSection({
	servers,
	hidden = [],
	usage,
	now,
	onShowModels,
	editRequest,
}: {
	servers: readonly DashboardServer[];
	/** Groups hidden by an explicit removal; rendered as the collapsed hidden-groups line. */
	hidden?: readonly HiddenGroup[];
	/** The pushed usage snapshot (the Usage tab's source); the rows' Usage cells read it. */
	usage?: DashboardUsage | undefined;
	/** The shared clock tick (one useNow in App), so a hidden panel does not run its own interval. */
	now: number;
	/** Scope the models section below to one server; absent, the count cells stay plain text. */
	onShowModels?: ((label: string) => void) | undefined;
	/** The inspectors' jump into a declared entry's edit form; see ServerEditRequest. */
	editRequest?: ServerEditRequest | undefined;
}) {
	// The section's own outcome hooks, one per acked method it surfaces: the
	// failure banners render each hook's latest fail outcome (a later ok
	// replaces it, so success retires the banner exactly like the old
	// store-clearing did), and Dismiss is the hook's reset. These are separate
	// hook instances from the open form's own - both see the same envelopes.
	const saveIntent = useIntentOutcome("saveServerSetting");
	const removeIntent = useIntentOutcome("removeServerSetting");
	const adoptIntent = useIntentOutcome("adoptServer");
	const hideIntent = useIntentOutcome("hideExternalServer");
	const unhideIntent = useIntentOutcome("unhideServer");
	// The form target survives state pushes (editing continues across a
	// background refresh). Keys come from a never-reused counter: a fresh key
	// per open forces a clean draft, and pendingAdopt's formKey scoping relies
	// on a closed form's key never coming back.
	const [form, setForm] = useState<{ target: FormTarget; key: number } | undefined>(undefined);
	const nextFormKey = useRef(1);
	// The slide-over's close policy: a dirty form asks before discarding.
	const [formDirty, setFormDirty] = useState(false);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	// The one-time post-adoption notice: the old host-owned group survives (no
	// removal API), so the user is told plainly why models now appear twice.
	const [adoptNotice, setAdoptNotice] = useState<string | undefined>(undefined);
	// The adopt round trips: each posted intent's requestId plus the posting
	// form instance's key. A list, not a slot: the form is freely closable
	// mid-adopt, so a second adopt can be in flight before the first ack lands,
	// and every ack must still deliver its post-adoption notice. The form key
	// scopes the follow-up close (and the form's saving state) to the instance
	// that posted, never a later form.
	const [pendingAdopts, setPendingAdopts] = useState<readonly { requestId: string; formKey: number }[]>([]);
	// The hide round trip: the posted intent's requestId plus the row's label,
	// so the guidance notice below can name the exact group to delete once the
	// ack lands. Copy is composed here; only the ack crosses the boundary.
	const [pendingHide, setPendingHide] = useState<{ requestId: string; label: string } | undefined>(undefined);
	const [removedNotice, setRemovedNotice] = useState<string | undefined>(undefined);
	const pendingHideRequestId = pendingHide?.requestId;
	const pendingHideLabel = pendingHide?.label;
	const hideOutcome = hideIntent.outcome;
	useEffect(() => {
		if (pendingHideRequestId !== undefined && hideOutcome?.result === "ok" && hideOutcome.id === pendingHideRequestId) {
			setRemovedNotice(pendingHideLabel);
			setPendingHide(undefined);
		}
	}, [hideOutcome, pendingHideRequestId, pendingHideLabel]);
	const hideExternal = (server: ExternalDashboardServer) => {
		const requestId = hideIntent.send({ baseUrl: server.baseUrl, sourceHandle: server.adoptHandle });
		setPendingHide({ requestId, label: server.label });
	};
	const saveFailure = saveIntent.outcome?.result === "fail" ? saveIntent.outcome : undefined;
	const removeFailure = removeIntent.outcome?.result === "fail" ? removeIntent.outcome : undefined;
	const adoptFailure = adoptIntent.outcome?.result === "fail" ? adoptIntent.outcome : undefined;
	const hideFailure = hideIntent.outcome?.result === "fail" ? hideIntent.outcome : undefined;
	const unhideFailure = unhideIntent.outcome?.result === "fail" ? unhideIntent.outcome : undefined;
	const noServers = servers.length === 0;
	// The two aggregate failure banners' entry lists, filtered once so the
	// separator logic can look at each entry's predecessor.
	const failingServers = servers.filter(
		(server) => server.origin !== "misconfigured" && server.error !== undefined && server.expected !== true
	);
	const expectedFailureServers = servers.filter((server) => server.error !== undefined && server.expected === true);

	const openForm = (target: FormTarget) => {
		setFormDirty(false);
		setConfirmingDiscard(false);
		const key = nextFormKey.current;
		nextFormKey.current += 1;
		setForm({ target, key });
	};

	// The inspectors' entry-jump: open the addressed declared entry's edit form
	// (its per-entry records live there). A label that no longer resolves to a
	// declared row is a no-op; keyed on the seq so repeating the jump re-opens.
	const editRequestSeq = editRequest?.seq;
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on the seq alone so repeating the jump re-opens; the request and servers are read at fire time
	useEffect(() => {
		if (editRequest === undefined) {
			return;
		}
		const target = servers.find(
			(server): server is DeclaredDashboardServer => server.origin === "declared" && server.label === editRequest.label
		);
		if (target !== undefined) {
			openForm({ kind: "edit", original: target });
		}
	}, [editRequestSeq]);

	const closeForm = () => {
		setForm(undefined);
		setFormDirty(false);
		setConfirmingDiscard(false);
	};

	// Every way out of an open form funnels through here: the form's Cancel,
	// the slide-over's X, the scrim, and Esc. One policy: on a dirty form,
	// toggle the discard confirm (so Esc while it shows means "keep editing" -
	// only the explicit Discard button destroys edits); otherwise close,
	// dismissing the form's stale failure notice with it.
	const discardForm = () => {
		if (form?.target.kind === "adopt") {
			adoptIntent.reset();
		} else {
			saveIntent.reset();
		}
		closeForm();
	};
	const requestCloseForm = () => {
		if (formDirty) {
			setConfirmingDiscard((current) => !current);
			return;
		}
		discardForm();
	};

	// A pending adopt's own ack: compose the post-adoption notice (plus the
	// extension's optional caveat) and close the posting form when it is still
	// the one open. A later or already-closed form is left alone.
	const adoptOutcome = adoptIntent.outcome;
	const ackedAdopt =
		adoptOutcome?.result === "ok" ? pendingAdopts.find((pending) => pending.requestId === adoptOutcome.id) : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: closeForm is a stable setter bundle; the deps that decide whether the ack applies are listed
	useEffect(() => {
		if (ackedAdopt === undefined || adoptOutcome?.result !== "ok") {
			return;
		}
		const base = l10n.t(
			"Adopted into the servers setting. Models appear twice until the original group's object is deleted: open the models file, remove it, reload the window."
		);
		setAdoptNotice(adoptOutcome.message !== undefined ? `${base} ${adoptOutcome.message}` : base);
		setPendingAdopts((current) => current.filter((pending) => pending.requestId !== ackedAdopt.requestId));
		if (form?.key === ackedAdopt.formKey) {
			closeForm();
		}
	}, [adoptOutcome, ackedAdopt, form]);

	// A pending adopt's own failure: a validation-kind one returns the still
	// open form to editing (removing the pending entry re-enables it); an
	// operation-kind one committed its write, so the stale form closes and the
	// section banner carries the recovery path.
	const failedAdopt =
		adoptFailure !== undefined ? pendingAdopts.find((pending) => pending.requestId === adoptFailure.id) : undefined;
	const adoptFailureKind = adoptFailure?.failureKind;
	// biome-ignore lint/correctness/useExhaustiveDependencies: closeForm is a stable setter bundle; the deps that decide whether the failure applies are listed
	useEffect(() => {
		if (failedAdopt === undefined) {
			return;
		}
		setPendingAdopts((current) => current.filter((pending) => pending.requestId !== failedAdopt.requestId));
		if (saveFailureDisposition(adoptFailureKind ?? "validation") === "close" && form?.key === failedAdopt.formKey) {
			closeForm();
		}
	}, [failedAdopt, adoptFailureKind, form]);

	// Misconfigured entries count: they occupy their label in the setting, so
	// a rename onto one or an adopt under one must be refused like any sibling.
	const declaredLabels = servers
		.filter((server) => server.origin === "declared" || server.origin === "misconfigured")
		.map((server) => server.label);

	// Usage is tracked per declared entry and keyed by its label (the usage
	// store's documented join key back to the server rows), so only declared
	// rows look it up; a URL spelling difference must not break the join.
	// Forbidden-usage cards carry no numbers, so they stay out of the join
	// and their rows show an empty cell; the Usage tab renders their story.
	const usageByLabel = new Map(
		(usage?.servers ?? []).flatMap((view) => (view.kind === "usage" ? [[view.label, view] as const] : []))
	);

	return (
		<section>
			<h2>
				{l10n.t("Servers")} <Help text={helpServersSection()} below />
				<DocsLink href={DOCS_LINK_SERVERS} label={l10n.t("Open the servers guide")} />
			</h2>
			{/* First run shows the guided card alone; a strip of mostly disabled
			    controls above it would put dead buttons before the guidance. */}
			{!noServers ? (
				<div className="toolbar">
					<Button onClick={() => openForm({ kind: "add" })}>
						<IconAdd /> {l10n.t("Add server")}
					</Button>
				</div>
			) : null}
			{form !== undefined ? (
				<SlideOver
					labelledBy="server-form-title"
					fallbackFocusId="tab-overview"
					confirming={confirmingDiscard}
					onRequestClose={requestCloseForm}
					onKeepEditing={() => setConfirmingDiscard(false)}
					onDiscard={discardForm}
				>
					{form.target.kind === "adopt" ? (
						<AdoptForm
							key={form.key}
							server={form.target.server}
							declaredLabels={declaredLabels}
							saving={pendingAdopts.some((pending) => pending.formKey === form.key)}
							onUserEdit={() => setFormDirty(true)}
							onAdoptPosted={(requestId) =>
								setPendingAdopts((current) => [...current, { requestId, formKey: form.key }])
							}
							onCancel={requestCloseForm}
						/>
					) : (
						<ServerForm
							key={form.key}
							target={form.target}
							declaredLabels={declaredLabels}
							observedModelInfoKeys={observedKeysForForm(servers, form.target)}
							onUserEdit={() => setFormDirty(true)}
							onClose={closeForm}
							onCancel={requestCloseForm}
						/>
					)}
				</SlideOver>
			) : null}
			{removedNotice !== undefined ? (
				<div className="notice" role="status">
					<p>
						{l10n.t(
							'Hid "{0}" and its models. VS Code still keeps a provider group named "{0}". To delete it for good:',
							removedNotice
						)}
					</p>
					<ol className="notice-steps">
						<li>{l10n.t('Open the models file and remove the "{0}" object from the JSON array.', removedNotice)}</li>
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
					<Button onClick={() => openForm({ kind: "add" })}>{l10n.t("Add your first server")}</Button>
				</div>
			) : (
				<div className="table-scroll">
					{/* className="servers": the narrow-viewport stylesheet stacks these rows
					    into cards so the row actions stay reachable. */}
					<table className="servers">
						<thead>
							<tr>
								<th>{l10n.t("Server")}</th>
								<th>{l10n.t("Base URL")}</th>
								<th>{l10n.t("Status")}</th>
								<th className="num">{l10n.t("Models")}</th>
								<th className="num">{l10n.t("Usage")}</th>
								<th>{/* badges */}</th>
								<th>{/* actions */}</th>
							</tr>
						</thead>
						<tbody>
							{servers.map((server) => (
								// Keyed identity (the error banner's idiom: origin plus the
								// external row's opaque handle or the row's unique label -
								// declared labels are setting-unique, misconfigured rows are
								// deduplicated by label extension-side) so an async push that
								// inserts, removes, or reorders entries does not re-associate
								// another server's row with the user's focus.
								<ServerRow
									key={`${server.origin}:${server.adoptHandle ?? server.label}`}
									server={server}
									usage={server.origin === "declared" ? usageByLabel.get(server.label) : undefined}
									usageThresholds={usage?.thresholds ?? []}
									now={now}
									armed={armedRemove === server.label}
									onEdit={() => {
										// The one place the form's purpose is decided: a declared
										// row edits, an external row adopts. A misconfigured row
										// renders no Edit at all (its shape cannot round-trip the
										// form); the guard keeps the narrowing honest.
										if (server.origin === "misconfigured") {
											return;
										}
										openForm(
											server.origin === "declared" ? { kind: "edit", original: server } : { kind: "adopt", server }
										);
									}}
									onArmRemove={(armed) => setArmedRemove(armed ? server.label : undefined)}
									onHideExternal={hideExternal}
									onShowModels={onShowModels}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
			<HiddenGroupsLine hidden={hidden} />
			{failingServers.length > 0 ? (
				<div className="banner banner-error">
					<p className="error">
						{failingServers.map((server, index) => {
							// Keyed identity (origin plus the external row's opaque handle
							// or the declared row's setting-unique label) so reconciliation
							// keeps focus on a Troubleshoot link when an earlier entry
							// recovers. A classified failure carries the same short
							// Troubleshoot link as the draft-test footer, inline after its
							// own entry's HEADLINE (the link must not drift below a detail
							// line); a two-part error's technical detail renders as its own
							// dimmed line after the link. The "; " separator joins inline
							// entries only: after a block detail line the next entry starts
							// on its own line, and a leading "; " there would dangle.
							const detail = statusErrorDetail(server.error ?? "");
							const afterDetail = index > 0 && statusErrorDetail(failingServers[index - 1]?.error ?? "") !== undefined;
							return (
								<Fragment key={`${server.origin}:${server.adoptHandle ?? server.label}`}>
									{index > 0 && !afterDetail ? "; " : ""}
									{`${server.label}: ${statusErrorHeadline(server.error ?? "")}`}
									{server.classification?.setupHint !== undefined ? (
										// The leading space keeps copied text (the banner is the
										// selectable error surface) from gluing the link label
										// onto the error message.
										<>
											{" "}
											<span className="banner-hint">
												<DocsLink {...troubleshootingLink(server.classification.setupHint)}>
													{l10n.t("Troubleshoot")}
												</DocsLink>
											</span>
										</>
									) : null}
									{detail !== undefined ? <span className="failure-detail">{detail}</span> : null}
								</Fragment>
							);
						})}
					</p>
				</div>
			) : null}
			{servers.some((server) => server.origin === "misconfigured") ? (
				<div className="banner banner-error">
					<p className="error">
						{servers
							.filter((server): server is MisconfiguredDashboardServer => server.origin === "misconfigured")
							.map((server, index) => (
								<Fragment key={server.label}>
									{index > 0 ? "; " : ""}
									{/* The parser's structural reports stay English by policy
									    (they land in issue reports); only the framing localizes. */}
									{l10n.t(
										"{0}: this entry is invalid and not used until fixed - {1}",
										server.label,
										server.problems.join("; ")
									)}
								</Fragment>
							))}
					</p>
					<p className="hint">
						{l10n.t("Keep exactly one auth form per entry; companions of lower rank only.")}{" "}
						<DocsLink href={DOCS_LINK_AUTHENTICATION} label={l10n.t("Open the authentication guide")}>
							{l10n.t("Learn more")}
						</DocsLink>
					</p>
				</div>
			) : null}
			{expectedFailureServers.length > 0 ? (
				<div className="banner banner-warn">
					<p className="state-warn">
						{expectedFailureServers.map((server, index) => {
							// Warn tone, never the red banner: the entry declared this
							// category, so the failure is stated with its localized
							// annotation instead of raised as a problem. Separators join
							// inline entries only (see the error banner above).
							const afterDetail =
								index > 0 && statusErrorDetail(expectedFailureServers[index - 1]?.error ?? "") !== undefined;
							return (
								<Fragment key={`${server.origin}:${server.adoptHandle ?? server.label}`}>
									{index > 0 && !afterDetail ? "; " : ""}
									<FailureText
										message={server.error ?? ""}
										frame={(headline) => l10n.t("{0}: {1} (expected)", server.label, headline)}
									/>
								</Fragment>
							);
						})}
					</p>
				</div>
			) : null}
			{servers.some((server) => INACTIVE_NOTICES.some((notice) => server.notices?.includes(notice) === true)) ? (
				<div className="banner banner-warn">
					<p className="state-warn">
						{/* One banner for every inactive entry-only surface: the cause and
						    the two-step fix are identical, so per-surface twin banners
						    would only repeat them. */}
						{servers
							.filter((server) => INACTIVE_NOTICES.some((notice) => server.notices?.includes(notice) === true))
							.map((server) => `${server.label}: ${inactiveSurfacesText(server)}`)
							.join("; ")}{" "}
						{l10n.t("are not applied: the group serving the entry predates its label or a rename. To activate them:")}{" "}
						<DocsLink href={DOCS_LINK_PARAMS_INACTIVE} label={l10n.t("Learn more in the troubleshooting guide")}>
							{l10n.t("Learn more")}
						</DocsLink>
					</p>
					<ol className="notice-steps">
						<li>{l10n.t("Delete the group's object from the models file (chatLanguageModels.json).")}</li>
						<li>
							{l10n.t("Reload the window, then run Sync Models Now - or save the entry under a new label instead.")}
						</li>
					</ol>
				</div>
			) : null}
			{servers.some((server) => server.notices?.includes("expected-failures-nothing-declared") === true) ? (
				<div className="banner banner-warn">
					<p className="state-warn">
						{l10n.t(
							"{0}: discovery fails in an expected category and nothing is declared, so no models are served. Add IDs to the entry's discovery.declared list to serve models without discovery.",
							servers
								.filter((server) => server.notices?.includes("expected-failures-nothing-declared") === true)
								.map((server) => server.label)
								.join(", ")
						)}
					</p>
				</div>
			) : null}
		</section>
	);
}
