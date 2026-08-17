import * as l10n from "@vscode/l10n";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AckedMethod, NotifyingMethod, SettingWriteMethod } from "../../dashboard/endpoints";
import { failuresAfterStatePush, isAckedMethod, SETTING_WRITE_METHODS } from "../../dashboard/endpoints";
import { classifyOverall, latestCheckedMs } from "../../dashboard/presenters";
import type { DashboardSectionId, DashboardServer, DashboardState, SettingRowId } from "../../dashboard/viewModels";
import { DASHBOARD_SECTION_IDS } from "../../dashboard/viewModels";
import { AnnounceOnceScope, useAlertOnce } from "./announceOnce";
import { DiagnosticsSection, pageConfigDiagnostics } from "./diagnostics";
import { FailureText } from "./failureText";
import { asExtensionMessage } from "./hooks";
import { IconClose, IconGear, IconModels, IconPulse, IconServers } from "./icons";
import type { InspectorSection } from "./modelInspector";
import { ModelInspector } from "./modelInspector";
import { ModelsSection } from "./models";
import type { Overall, RailSection } from "./rail";
import { Rail } from "./rail";
import type { ServerEditRequest } from "./serverEditPage";
import { ServerEditPage } from "./serverEditPage";
import { ServersSection } from "./servers";
import type { EditRecordRequest, SettingWriteFailure } from "./settings";
import { SettingsSection } from "./settings";
import { relativeTime, useNow } from "./time";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { sendRequest } from "./vscodeApi";

/** The section tabs; the ID list lives in the view-model module because focusSection deep-links name them. */
const SECTION_IDS = DASHBOARD_SECTION_IDS;
type SectionId = DashboardSectionId;

/** The tab labels, resolved at render time (no module-level localized constants). */
function sectionLabel(section: SectionId): string {
	switch (section) {
		case "overview":
			return l10n.t("Servers");
		case "models":
			return l10n.t("Models");
		case "settings":
			return l10n.t("Settings");
		case "diagnostics":
			return l10n.t("Diagnostics");
	}
}

/**
 * Each destination's collapsed-rail icon: the same exhaustive switch the labels use, so a
 * new destination cannot ship with a name and no icon.
 */
function sectionIcon(section: SectionId): ReactElement {
	switch (section) {
		case "overview":
			return <IconServers />;
		case "models":
			return <IconModels />;
		case "settings":
			return <IconGear />;
		case "diagnostics":
			return <IconPulse />;
	}
}

/**
 * One reported intent failure; `seq` distinguishes repeats with the same text, and `row`
 * echoes the fail envelope's owning settings row so the settings page can place the notice.
 */
interface IntentFailure {
	readonly seq: number;
	readonly message: string;
	/** Whether the intent's durable write committed before the failure; see the fail envelope's failureKind. */
	readonly kind: "validation" | "operation";
	/** The refused scalar write's owning settings row; absent on every other method's failure. */
	readonly row?: SettingRowId | undefined;
}

/**
 * The latest fire-and-forget failures, keyed by method. Acked methods stay out by
 * construction (their outcomes belong to the posting editors' hooks), which is what lets
 * a state push retire this store wholesale - here, the push IS the success signal.
 */
export type FailuresByMethod = Readonly<Partial<Record<NotifyingMethod, IntentFailure>>>;

/**
 * The server intents whose success gets a transient toast, with static base copy (never
 * payload text). Scalar and record edits stay silent - their success is the value
 * updating in place. Resolved at call time.
 */
function toastText(method: AckedMethod): string | undefined {
	switch (method) {
		case "saveServerSetting":
			return l10n.t("Server saved");
		case "removeServerSetting":
			return l10n.t("Server removed");
		case "adoptServer":
			return l10n.t("Server adopted");
		default:
			return undefined;
	}
}

interface ToastItem {
	readonly id: number;
	readonly text: string;
}

/** How long a toast lingers; App takes it as a prop only so tests need not wait out the real value. */
const TOAST_DURATION_MS = 6000;

function Toast({
	toast,
	durationMs,
	onDismiss,
}: {
	toast: ToastItem;
	durationMs: number;
	onDismiss: (id: number) => void;
}) {
	useEffect(() => {
		const timer = setTimeout(() => onDismiss(toast.id), durationMs);
		return () => clearTimeout(timer);
	}, [toast.id, durationMs, onDismiss]);
	return (
		<div className="toast">
			<span>{toast.text}</span>
			<Button
				variant="secondary"
				size="compact"
				aria-label={l10n.t("Dismiss notification")}
				onClick={() => onDismiss(toast.id)}
			>
				<IconClose />
			</Button>
		</div>
	);
}

/**
 * The toast stack, bottom-right like the host's notifications; a polite live region, so
 * outcomes announce without stealing focus.
 */
function ToastHost({
	toasts,
	durationMs,
	onDismiss,
}: {
	toasts: readonly ToastItem[];
	durationMs: number;
	onDismiss: (id: number) => void;
}) {
	return (
		<div className="toasts" role="status" aria-live="polite">
			{toasts.map((toast) => (
				<Toast key={toast.id} toast={toast} durationMs={durationMs} onDismiss={onDismiss} />
			))}
		</div>
	);
}

/**
 * The hero's overall verdict, mapped from the shared classifyOverall (with the tab's
 * legacy-registry rule mirrored), so the strip and the tab never disagree.
 */
function overallState(servers: readonly DashboardServer[], legacyServerCount: number): Overall {
	switch (classifyOverall(servers)) {
		case "not-configured":
			// The legacy registry is real configuration even though it
			// contributes no server rows (see overallStatusText).
			return {
				tone: "muted",
				word: legacyServerCount > 0 ? l10n.t("Legacy registry only") : l10n.t("Not configured"),
			};
		case "error":
			return { tone: "error", word: l10n.t("Error") };
		case "degraded":
			return { tone: "warn", word: l10n.t("Degraded") };
		case "waiting":
			return { tone: "muted", word: l10n.t("Waiting for first sync") };
		case "needs-declare":
			// Expected failures with nothing declared: neutral, with the way
			// forward in the word itself.
			return { tone: "warn", word: l10n.t("No declared models") };
		case "connected":
			return { tone: "ok", word: l10n.t("Connected") };
	}
}

function lastSync(servers: readonly DashboardServer[], now: number): string | undefined {
	const checkedMs = latestCheckedMs(servers);
	return checkedMs === undefined ? undefined : relativeTime(new Date(checkedMs).toISOString(), now);
}

/**
 * What each rail item counts - the number a reader would go there to find out. Absence is
 * deliberate everywhere: an empty fleet or catalogue counts nothing rather than zero,
 * and a count that is always present stops being information.
 */
function railSections(state: DashboardState): readonly RailSection<SectionId>[] {
	const counts: Readonly<Record<SectionId, { count?: string; countLabel?: string; countTone?: "warn" | "err" }>> = {
		// Each item counts its own noun now that they are separate destinations -
		// which is half the reason they are. No servers means the destination
		// shows a guided start rather than a table, so a "0" would count
		// something that is not there.
		overview:
			state.servers.length === 0
				? {}
				: {
						count: String(state.servers.length),
						countLabel:
							state.servers.length === 1 ? l10n.t("1 server") : l10n.t("{0} servers", String(state.servers.length)),
					},
		models:
			state.models.length === 0
				? {}
				: {
						count: String(state.models.length),
						countLabel:
							state.models.length === 1 ? l10n.t("1 model") : l10n.t("{0} models", String(state.models.length)),
					},
		// Tinted only when there is something to fix. Advisories are counted but never tinted:
		// a permanent amber badge for a typo hint is an alarm nobody can silence or act on.
		diagnostics: diagnosticsCount(pageConfigDiagnostics(state.diagnostics)),
		settings: {},
	};
	return SECTION_IDS.map((id) => ({ id, label: sectionLabel(id), icon: sectionIcon(id), ...counts[id] }));
}

/**
 * Counted whole, tinted only for problems to fix. Counts the diagnostics the destination
 * actually renders (pageConfigDiagnostics drops the server-row-owned ones), so badge and
 * list can never disagree.
 */
function diagnosticsCount(diagnostics: DashboardState["diagnostics"]): {
	count?: string;
	countLabel?: string;
	countTone?: "warn";
} {
	if (diagnostics.length === 0) {
		return {};
	}
	const actionable = diagnostics.some((diagnostic) => diagnostic.severity === "warning");
	return {
		count: String(diagnostics.length),
		countLabel: diagnostics.length === 1 ? l10n.t("1 problem") : l10n.t("{0} problems", String(diagnostics.length)),
		...(actionable ? { countTone: "warn" as const } : {}),
	};
}

/**
 * Grey stand-ins in the real shell classes, not a bare <main>: the page gutter belongs to
 * the pane, and a skeleton outside the shell jumped 24px when the first push landed.
 */
function LoadingSkeleton() {
	return (
		<main className="shell" aria-label={l10n.t("Loading")}>
			<nav className="rail" aria-hidden="true">
				<div className="rail-inner">
					<div className="skeleton" style={{ height: "18px", width: "90px", margin: "2px 4px 12px" }} />
					<div className="skeleton" style={{ height: "24px", margin: "0 0 4px" }} />
					<div className="skeleton" style={{ height: "24px", margin: "0 0 4px" }} />
					<div className="skeleton" style={{ height: "24px", margin: "0 0 4px" }} />
					<div className="skeleton" style={{ height: "24px" }} />
				</div>
			</nav>
			<div className="pane">
				<div className="skeleton" style={{ height: "20px", width: "220px", margin: "4px 0 16px" }} />
				<div className="skeleton" style={{ height: "26px", width: "260px", margin: "0 0 16px" }} />
				<div className="skeleton" style={{ height: "24px", margin: "8px 0" }} />
				<div className="skeleton" style={{ height: "24px", margin: "8px 0" }} />
				<div className="skeleton" style={{ height: "24px", margin: "8px 0" }} />
				<div className="skeleton" style={{ height: "24px", margin: "8px 0" }} />
			</div>
		</main>
	);
}

/** One pane's content, kept mounted while hidden; see Rail. */
function SectionPanel({ section, active, children }: { section: SectionId; active: SectionId; children: ReactNode }) {
	return (
		<div role="tabpanel" id={`panel-${section}`} aria-labelledby={`tab-${section}`} hidden={section !== active}>
			{children}
		</div>
	);
}

/**
 * A standing failure's pane-top line: visible while the failure stands, announced only on
 * its first render per seq (useAlertOnce). Callers key it by seq - a REPEAT carries a
 * fresh seq, and the remount plus fresh role is what announces it (adding role="alert"
 * to an element already in the tree is not reliably spoken).
 */
function PaneFailureLine({ failure }: { failure: { readonly seq: number; readonly message: string } }) {
	const role = useAlertOnce(failure.seq);
	return (
		<p className="error" role={role}>
			<FailureText
				message={failure.message}
				frame={(headline) => l10n.t("The last change did not apply: {0}", headline)}
			/>
		</p>
	);
}

/**
 * The dashboard root: the latest pushed state, the standing-failure store, and the
 * toasts, nothing else; the extension re-pushes full state on every store change. A push
 * retires the standing failures (all fire-and-forget; the push is their success signal),
 * and never the acked methods' - the editors' hooks own those, so a partially applied
 * save's warning survives the sync push that follows it.
 */
export function App({ toastDurationMs = TOAST_DURATION_MS }: { toastDurationMs?: number } = {}) {
	const [state, setState] = useState<DashboardState | undefined>(undefined);
	const [section, setSection] = useState<SectionId>("overview");
	const [failures, setFailures] = useState<FailuresByMethod>({});
	const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
	// Bumped on every state push: the open inspectors and the resolved-models
	// view re-request on it so they follow configuration edits live.
	const [stateSeq, setStateSeq] = useState(0);
	// The open inspector overlay, held here so it opens IN PLACE over the active tab. The
	// identity is (scopeKey, rawId, serverLabel), never the model object: pushes rebuild the
	// models array, and one snapshot can render under several labels with identical
	// (scopeKey, rawId). `anchor` names the section the merged panel scrolls to.
	const [inspecting, setInspecting] = useState<
		{ scopeKey: string; rawId: string; serverLabel: string; anchor?: InspectorSection | undefined } | undefined
	>(undefined);
	// The inspectors' configure-jump into the settings record editors.
	const [editRecordRequest, setEditRecordRequest] = useState<EditRecordRequest | undefined>(undefined);
	// The edit destination fills the pane beside the rail - a destination, not an overlay,
	// because opening a door on top of a door is what this shell exists to stop. The key
	// remounts a clean draft per open; a never-reused counter, so a closed page's key
	// cannot revive its state.
	const [editing, setEditing] = useState<{ request: ServerEditRequest; key: number } | undefined>(undefined);
	const nextEditKey = useRef(1);
	// The page's draft has edits worth asking about. A ref, not state: nothing renders from
	// it, and the page reports on effects that run BEFORE this component's in the same
	// commit - state read from a closure would still say "dirty" for a draft that is gone.
	const editDirty = useRef(false);
	// The guard's open question, rendered as the ConfirmDialog at the end of
	// the shell; true only while the edit destination is on screen.
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	// Where the reader was when they opened the page, and where they asked to
	// go if a rail click is what raised the question. Refs, not state: nothing
	// renders from them, and a re-render between the click and the answer must
	// not lose either.
	const editOpener = useRef<HTMLElement | undefined>(undefined);
	const leaveIntent = useRef<SectionId | undefined>(undefined);
	// The child lists this in an effect's deps, so a fresh arrow per parent
	// render would re-run that effect on every render of the shell.
	const noteEditDirty = useCallback((dirty: boolean) => {
		editDirty.current = dirty;
	}, []);
	// The page's explicit "the draft ceased to exist" channel, separate from the dirty
	// report on purpose: only a target that is GONE may dismiss a standing discard
	// question - a draft merely reading clean again must leave the question to the reader.
	const onTargetGone = useCallback(() => {
		editDirty.current = false;
		leaveIntent.current = undefined;
		setConfirmingDiscard(false);
	}, []);
	// Where focus goes once the destination has actually left the screen.
	const pendingLeaveFocus = useRef<{ kind: "opener" } | { kind: "section"; section: SectionId } | undefined>(undefined);
	// The navigation guard as the one-time message listener can reach it. It is
	// only ever read from the effect below, which runs after a committed state
	// render - by which point the assignment past the loading return has run.
	const selectSectionRef = useRef<(id: SectionId) => void>(() => undefined);
	// A deep link's target, held until there is a page to apply it to: the guard it routes
	// through is assigned during a render that has not happened yet, and whether a commit
	// lands between the push and the focus request is the browser's business (panel.ts
	// open()). Recording and applying on the next commit takes the timing out entirely.
	const [pendingFocusSection, setPendingFocusSection] = useState<SectionId | undefined>(undefined);
	// The models list's server scope (a server row's model-count link sets it,
	// the chip in the models filter bar clears it). Held here rather than in
	// ModelsSection because the servers table is the other end of the wire.
	const [serverScope, setServerScope] = useState<string | undefined>(undefined);
	// Set when a server's count link sends the reader to Models, cleared when
	// the focus it asked for has been delivered.
	const pendingModelsFocus = useRef(false);
	// One clock for every relative time on the page; hidden panels share the
	// same tick instead of running intervals of their own.
	const now = useNow();
	const dismissToast = useCallback((id: number) => {
		setToasts((current) => current.filter((toast) => toast.id !== id));
	}, []);

	useEffect(() => {
		let seq = 0;
		const onMessage = (event: MessageEvent) => {
			const message = asExtensionMessage(event.data);
			if (message === undefined) {
				return;
			}
			if (message.kind === "push") {
				setState(message.state);
				setFailures(failuresAfterStatePush);
				setStateSeq((current) => current + 1);
				return;
			}
			if (message.kind === "focusSection") {
				// The extension's deep link; the includes check drops an unknown section instead of
				// blanking every panel. Recorded, then applied through the same guard a rail click
				// takes, so an open draft is asked about.
				if (SECTION_IDS.includes(message.section)) {
					setPendingFocusSection(message.section);
				}
				return;
			}
			if (message.kind === "response") {
				// Read responses belong to the useRpc hook instances that posted them.
				return;
			}
			seq += 1;
			if (message.kind === "ack") {
				const base = toastText(message.method);
				if (base !== undefined) {
					const caveat = message.method !== "adoptServer" ? message.message : undefined;
					const text = caveat !== undefined ? `${base}. ${caveat}` : base;
					// The stack stays readable: at most three, oldest dropped first.
					setToasts((current) => [...current, { id: seq, text }].slice(-3));
				}
				return;
			}
			if (isAckedMethod(message.method)) {
				// An acked intent's failure belongs to the editor hook that posted
				// it; the standing store holds only push-retired notices.
				return;
			}
			const failure: IntentFailure = {
				seq,
				message: message.message,
				kind: message.failureKind,
				row: message.row,
			};
			setFailures((current) => ({ ...current, [message.method]: failure }));
		};
		window.addEventListener("message", onMessage);
		sendRequest("ready", null);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	// A scope whose server left the list would filter the table down to
	// nothing with no row left to explain why, so it clears itself.
	useEffect(() => {
		if (serverScope !== undefined && state !== undefined && !state.servers.some((s) => s.label === serverScope)) {
			setServerScope(undefined);
		}
	}, [serverScope, state]);

	// Deep links arrive before the first state push as often as after it, so
	// this records the request and applies it once state exists, through the
	// ref rather than the render closure: the guard has to see the current
	// editing state, not the one this render was built from.
	useEffect(() => {
		if (pendingFocusSection === undefined || state === undefined) {
			return;
		}
		setPendingFocusSection(undefined);
		selectSectionRef.current(pendingFocusSection);
	}, [pendingFocusSection, state]);

	useEffect(() => {
		if (pendingModelsFocus.current && section === "models") {
			pendingModelsFocus.current = false;
			document.getElementById("models-section")?.focus({ preventScroll: true });
		}
	}, [section]);

	// Appearance follows the setting live: the HTML shell stamps once at creation (enough
	// for a reopen only); the configuration push restamps here, so the picker and a hand
	// edit of settings.json travel the identical path.
	const appearance = state?.settings.appearance;
	useEffect(() => {
		if (appearance !== undefined) {
			document.documentElement.dataset.theme = appearance.theme;
			document.documentElement.dataset.accent = appearance.accent;
		}
	}, [appearance]);

	// The inspected model on the latest push; an inspector whose model left
	// the list closes instead of rendering stale values.
	const inspectedModel =
		inspecting === undefined
			? undefined
			: state?.models.find(
					(model) =>
						model.scopeKey === inspecting.scopeKey &&
						model.rawId === inspecting.rawId &&
						model.serverLabel === inspecting.serverLabel
				);
	useEffect(() => {
		if (inspecting !== undefined && state !== undefined && inspectedModel === undefined) {
			setInspecting(undefined);
		}
	}, [inspecting, state, inspectedModel]);

	// The other half of leaveEdit: run once the pane has re-rendered with the
	// sections back on screen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the destination closing; the target was decided when the reader left
	useEffect(() => {
		const pending = pendingLeaveFocus.current;
		if (editing !== undefined || pending === undefined) {
			return;
		}
		pendingLeaveFocus.current = undefined;
		if (pending.kind === "section") {
			document.getElementById(`tab-${pending.section}`)?.focus();
			return;
		}
		const opener = editOpener.current;
		editOpener.current = undefined;
		if (opener?.isConnected === true) {
			opener.focus();
			return;
		}
		document.getElementById(`tab-${section}`)?.focus();
	}, [editing]);

	if (state === undefined) {
		return <LoadingSkeleton />;
	}

	const showServerModels = (label: string) => {
		// A server's count link navigates and filters. Focus follows the navigation: without it,
		// Tab would continue from the count link on a panel no longer visible.
		setServerScope(label);
		if (section === "models") {
			// Already on Models: setSection would be a no-op, so the effect that
			// delivers a pending focus would never run and the flag would latch,
			// stealing focus the next time the reader arrived here by any route.
			// The panel is visible, so focus now and leave no flag behind.
			document.getElementById("models-section")?.focus({ preventScroll: true });
			return;
		}
		setSection("models");
		// Focus lands in the effect below, not here: the models panel is hidden
		// until this render commits, and focusing a hidden element does nothing.
		pendingModelsFocus.current = true;
	};

	// A model's inspector overlay: opened from the models table (no anchor) or
	// the Resolved-models table (anchored on its Parameters/Capabilities
	// section), rendered over the ACTIVE tab (no tab switch - the Diagnostics
	// reader keeps their place; closing just removes the overlay).
	const inspectModel = (
		target: { scopeKey: string; rawId: string; serverLabel: string },
		anchor?: InspectorSection
	) => {
		setInspecting({ ...target, anchor });
	};

	// The inspectors' configure-jump: land on the settings tab with the right
	// record editor focused (or a fresh exact-ID draft created).
	const editRecord = (kind: "parameters" | "capabilities", key: string, create: boolean) => {
		setSection("settings");
		setEditRecordRequest((current) => ({ seq: (current?.seq ?? 0) + 1, kind, key, create }));
	};

	// Opening the edit destination, from a server row, the Add button, or an
	// inspector's jump into the entry that owns a value. Focus is captured
	// here rather than inside the page: what the reader left is the shell's
	// business, and the page has no idea it was opened from a row.
	const openEdit = (request: ServerEditRequest) => {
		const active = document.activeElement;
		// The body is not an opener: focusing it later is a no-op that would
		// skip the rail fallback and leave focus nowhere.
		editOpener.current = active instanceof HTMLElement && active !== document.body ? active : undefined;
		leaveIntent.current = undefined;
		editDirty.current = false;
		setConfirmingDiscard(false);
		setEditing({ request, key: nextEditKey.current });
		nextEditKey.current += 1;
	};

	// Leaving for real: focus returns to the opener - or, on a rail click, to the picked
	// destination. A row that left with a save (a rename mints a new one) falls back to the
	// section's own rail item rather than nowhere.
	const leaveEdit = () => {
		const intent = leaveIntent.current;
		leaveIntent.current = undefined;
		setEditing(undefined);
		editDirty.current = false;
		setConfirmingDiscard(false);
		if (intent !== undefined) {
			setSection(intent);
		}
		// Focus lands in the effect below, not here: the sections are still hidden in this
		// render, and a hidden subtree cannot take focus. Both paths go through one place so
		// there is one answer to "where does focus go when the page closes".
		pendingLeaveFocus.current = intent === undefined ? { kind: "opener" } : { kind: "section", section: intent };
	};

	// Every way out funnels through here. A dirty draft gets the question as a modal, which
	// owns its own answering (holds focus, consumes Esc, scrim blocks the page) - so asking
	// is idempotent, never a toggle; only the dialog's explicit Discard destroys a draft.
	const requestLeaveEdit = () => {
		if (editDirty.current) {
			setConfirmingDiscard(true);
			return;
		}
		leaveEdit();
	};

	const keepEditing = () => {
		leaveIntent.current = undefined;
		setConfirmingDiscard(false);
	};

	// A rail click while the page is open is a navigation the guard has to see
	// first; it becomes the destination once the reader has answered.
	const selectSection = (id: SectionId) => {
		if (editing === undefined) {
			setSection(id);
			return;
		}
		leaveIntent.current = id;
		if (editDirty.current) {
			// Asking again, never toggling: a reader who clicks one rail item,
			// sees the question, and then clicks another has changed their
			// destination - not answered. Toggling here would dismiss the
			// question and go nowhere, which reads as the click being ignored.
			setConfirmingDiscard(true);
			return;
		}
		leaveEdit();
	};

	selectSectionRef.current = selectSection;

	// An entry-owned value's jump: its record lives in the server entry, so
	// the destination is that entry's page.
	const editEntry = (label: string) => {
		setSection("overview");
		openEdit({ kind: "edit", label });
	};

	// The section actually on screen: a recorded deep link shows immediately (no
	// Servers-page frame first), but defers while the edit destination is open, because
	// leaving that page is a question rather than a move.
	const activeSection = pendingFocusSection !== undefined && editing === undefined ? pendingFocusSection : section;

	// The scalar setting writes report on the settings page itself, placed by owning row.
	// Only executeCommand keeps a pane-top line: it is posted from every tab and owns no
	// row anywhere.
	const commandFailure = failures.executeCommand;
	const settingWriteFailures: Partial<Record<SettingWriteMethod, SettingWriteFailure>> = {};
	for (const method of SETTING_WRITE_METHODS) {
		const failure = failures[method];
		if (failure !== undefined) {
			settingWriteFailures[method] = failure;
		}
	}
	// A refused write must stay visible from ANY tab: a rail click can be the very blur
	// that commits the failing write, so the fail lands after the settings panel is hidden
	// - and a hidden subtree neither paints nor announces.
	const awaySettingFailure =
		activeSection === "settings"
			? undefined
			: Object.values(settingWriteFailures).reduce(
					(latest: SettingWriteFailure | undefined, failure) =>
						latest === undefined || failure.seq > latest.seq ? failure : latest,
					undefined
				);
	return (
		<AnnounceOnceScope>
			<main
				className="shell"
				onKeyDown={(event) => {
					// Esc while the destination is open is the shell's, and only what reaches it (the
					// listbox and matcher overlay stop their own). On the shell rather than the pane
					// because the rail is a sibling - a reader who just clicked a rail item has focus there.
					if (editing === undefined || event.key !== "Escape") {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					requestLeaveEdit();
				}}
			>
				<Rail
					sections={railSections(state)}
					active={activeSection}
					onSelect={selectSection}
					serverCount={state.servers.length}
					overall={overallState(state.servers, state.legacyServerCount)}
					synced={lastSync(state.servers, now)}
				/>
				<div className="pane">
					{/* Both pane-top lines announce once per failure seq and then stand silently
					    (PaneFailureLine): one owns no row, the other re-mounts on every navigation away
					    from Settings while its failure stands unchanged. */}
					{commandFailure !== undefined ? <PaneFailureLine key={commandFailure.seq} failure={commandFailure} /> : null}
					{awaySettingFailure !== undefined ? (
						<PaneFailureLine key={awaySettingFailure.seq} failure={awaySettingFailure} />
					) : null}
					{/* The destination lives INSIDE the Servers panel: the rail still says Servers. The list
					    stays mounted behind it - hidden, not unmounted - so the row that opened the page
					    survives to take focus back, with its scroll position. */}
					<SectionPanel section="overview" active={activeSection}>
						{editing !== undefined ? (
							<ServerEditPage
								key={editing.key}
								request={editing.request}
								servers={state.servers}
								onDirtyChange={noteEditDirty}
								onTargetGone={onTargetGone}
								onRequestClose={requestLeaveEdit}
								onSaved={leaveEdit}
							/>
						) : null}
						<div hidden={editing !== undefined}>
							<ServersSection
								servers={state.servers}
								hidden={state.hiddenGroups}
								usage={state.usage}
								currencySymbol={state.settings.usage.currencySymbol}
								now={now}
								onShowModels={showServerModels}
								onEditServer={(label) => openEdit({ kind: "edit", label })}
								onAdoptServer={(handle) => openEdit({ kind: "adopt", handle })}
								onAddServer={() => openEdit({ kind: "add" })}
							/>
						</div>
					</SectionPanel>
					<SectionPanel section="models" active={activeSection}>
						<ModelsSection
							models={state.models}
							serverCount={state.servers.length}
							currencySymbol={state.settings.usage.currencySymbol}
							scope={
								serverScope !== undefined ? { label: serverScope, onClear: () => setServerScope(undefined) } : undefined
							}
							onInspect={inspectModel}
						/>
					</SectionPanel>
					<SectionPanel section="settings" active={activeSection}>
						<SettingsSection
							settings={state.settings}
							models={state.models}
							observedModelInfoKeys={state.observedModelInfoKeys}
							now={now}
							editRecordRequest={editRecordRequest}
							writeFailures={settingWriteFailures}
						/>
					</SectionPanel>
					<SectionPanel section="diagnostics" active={activeSection}>
						<DiagnosticsSection
							servers={state.servers}
							modelCount={state.models.length}
							legacyServerCount={state.legacyServerCount}
							diagnostics={state.diagnostics}
							active={section === "diagnostics"}
							stateSeq={stateSeq}
							currencySymbol={state.settings.usage.currencySymbol}
							onInspect={inspectModel}
						/>
					</SectionPanel>
				</div>
				<ToastHost toasts={toasts} durationMs={toastDurationMs} onDismiss={dismissToast} />
				{/* The inspector overlay, above the tab panels so it opens in place
			    on any tab; the configure-jumps close the overlay first - the
			    editor they land on is the next surface. */}
				{inspectedModel !== undefined ? (
					<ModelInspector
						model={inspectedModel}
						stateSeq={stateSeq}
						currencySymbol={state.settings.usage.currencySymbol}
						anchor={inspecting?.anchor}
						fallbackFocusId={`tab-${section}`}
						onClose={() => setInspecting(undefined)}
						onEditRecord={(kind, key, create) => {
							setInspecting(undefined);
							editRecord(kind, key, create);
						}}
						onEditEntry={(label) => {
							setInspecting(undefined);
							editEntry(label);
						}}
					/>
				) : null}
				{/* The navigation guard's question, a modal: leaving a dirty page is a decision about
				    the whole page. Keep editing is the safe default; on Discard the recorded intent
				    decides where the reader (and focus) land. */}
				{editing !== undefined && confirmingDiscard ? (
					<ConfirmDialog
						question={l10n.t("Discard unsaved changes?")}
						confirmLabel={l10n.t("Discard")}
						cancelLabel={l10n.t("Keep editing")}
						surfaceId="server-edit-page"
						onConfirm={leaveEdit}
						onCancel={keepEditing}
					/>
				) : null}
			</main>
		</AnnounceOnceScope>
	);
}
