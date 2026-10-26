import * as l10n from "@vscode/l10n";
import type { Dispatch, ReactElement, ReactNode, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AckedMethod,
	ExtensionToWebviewMessage,
	NotifyingMethod,
	SettingWriteMethod,
} from "../../dashboard/endpoints";
import {
	failuresAfterStatePush,
	isAckedMethod,
	PANE_TOP_FAIL_METHODS,
	SETTING_WRITE_METHODS,
} from "../../dashboard/endpoints";
import { classifyOverall, latestCheckedMs } from "../../dashboard/presenters";
import type {
	DashboardModel,
	DashboardSectionId,
	DashboardServer,
	DashboardState,
	SettingRowId,
	VerdictRow,
} from "../../dashboard/viewModels";
import { DASHBOARD_SECTION_IDS } from "../../dashboard/viewModels";
import { AnnounceOnceScope, useAlertOnce } from "./announceOnce";
import { DiagnosticsSection, pageConfigDiagnostics } from "./diagnostics";
import { FailureText } from "./failureText";
import { FeaturesSection } from "./featuresPage";
import { asExtensionMessage } from "./hooks";
import { IconClose, IconGear, IconModels, IconPulse, IconServers, IconSparkle } from "./icons";
import { tupleKey } from "./keys";
import type { InspectorSection } from "./modelInspector";
import { ModelInspector } from "./modelInspector";
import { ModelsSection } from "./models";
import type { Overall, RailSection } from "./rail";
import { Rail } from "./rail";
import type { ServerEditRequest } from "./serverEditPage";
import { ServerEditPage } from "./serverEditPage";
import { ServersSection } from "./servers";
import type { SettingWriteFailure } from "./settingRows";
import { failurePage } from "./settingRows";
import type { EditRecordRequest } from "./settingsPage";
import { SettingsSection } from "./settingsPage";
import { relativeTime, useNow } from "./time";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { sectionId } from "./ui/section";
import { sendRequest } from "./vscodeApi";

const SECTION_IDS = DASHBOARD_SECTION_IDS;
type SectionId = DashboardSectionId;

/** The tab labels, resolved at render time (no module-level localized constants). */
function sectionLabel(section: SectionId): string {
	switch (section) {
		case "overview":
			return l10n.t("Servers");
		case "models":
			return l10n.t("Models");
		case "features":
			return l10n.t("Features");
		case "settings":
			return l10n.t("Settings");
		case "diagnostics":
			return l10n.t("Diagnostics");
	}
}

function sectionIcon(section: SectionId): ReactElement {
	switch (section) {
		case "overview":
			return <IconServers />;
		case "models":
			return <IconModels />;
		case "features":
			return <IconSparkle />;
		case "settings":
			return <IconGear />;
		case "diagnostics":
			return <IconPulse />;
	}
}

/**
 * One reported intent failure, as the fail envelope carried it.
 *
 *   seq  -> distinguishes repeats with the same text
 *   kind -> whether the intent's durable write committed before the failure (the envelope's failureKind)
 *   row  -> the refused scalar write's owning settings row, so the settings page can place the notice; absent on every
 *           other method's failure
 */
interface IntentFailure {
	readonly seq: number;
	readonly message: string;
	readonly kind: "validation" | "operation";
	readonly row?: SettingRowId | undefined;
}

/**
 * The latest fire-and-forget failures, keyed by method. Acked methods stay out by construction (their outcomes belong
 * to the posting editors' hooks), which is what lets a state push retire this store wholesale - here, the push IS the
 * success signal.
 */
type FailuresByMethod = Readonly<Partial<Record<NotifyingMethod, IntentFailure>>>;

/**
 * The server intents whose success gets a transient toast, with static base copy (never payload text). Scalar and
 * record edits stay silent - their success is the value updating in place.
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

type AckMessage = Extract<ExtensionToWebviewMessage, { kind: "ack" }>;
type FailMessage = Extract<ExtensionToWebviewMessage, { kind: "fail" }>;

/** The standing scalar-write failures by method, as the Features and Settings pages and the away line read them. */
type SettingWriteFailures = Partial<Record<SettingWriteMethod, SettingWriteFailure>>;

/**
 * What the one-time message listener feeds the shell. A push retires the standing failures (all fire-and-forget; the
 * push is their success signal), and never the acked methods' - the editors' hooks own those, so a partially applied
 * save's warning survives the sync push that follows it.
 *
 *   stateSeq            -> bumped on every state push: the open inspectors and the resolved-models view re-request on
 *                          it so they follow configuration edits live
 *   pendingFocusSection -> a deep link's target, held until there is a page to apply it to: the guard it routes
 *                          through is assigned during a render that has not happened yet, and whether a commit lands
 *                          between the push and the focus request is the browser's business (panel.ts open()).
 *                          Recording and applying on the next commit takes the timing out entirely
 */
interface HostLink {
	readonly state: DashboardState | undefined;
	readonly stateSeq: number;
	readonly failures: FailuresByMethod;
	readonly toasts: readonly ToastItem[];
	readonly dismissToast: (id: number) => void;
	readonly pendingFocusSection: SectionId | undefined;
	readonly clearPendingFocus: () => void;
}

/**
 * The state writers one host message reaches. nextSeq counts acks and fails alike: the toasts' ids and the failures'
 * seqs come from one counter, so a repeat with the same text is still a distinct event.
 */
interface HostSinks {
	readonly nextSeq: () => number;
	readonly setState: Dispatch<SetStateAction<DashboardState | undefined>>;
	readonly setStateSeq: Dispatch<SetStateAction<number>>;
	readonly setFailures: Dispatch<SetStateAction<FailuresByMethod>>;
	readonly setToasts: Dispatch<SetStateAction<readonly ToastItem[]>>;
	readonly setPendingFocusSection: Dispatch<SetStateAction<SectionId | undefined>>;
}

/** The open edit page: its request, and the key that remounts a clean draft per open. */
interface EditingPage {
	readonly request: ServerEditRequest;
	readonly key: number;
}

/** Where focus goes once the edit page has closed: back to its opener, or to the rail item a click picked. */
type LeaveFocus = { readonly kind: "opener" } | { readonly kind: "section"; readonly section: SectionId };

/**
 * What the navigation guard remembers between renders. Refs, not state: nothing renders from these, the page reports
 * dirty on effects that run BEFORE the shell's in the same commit (state read from a closure would still say "dirty"
 * for a draft that is gone), and a re-render between a rail click and its answer must not lose the destination.
 *
 *   dirty       -> the page's draft has edits worth asking about
 *   opener      -> where the reader was when they opened the page
 *   leaveIntent -> where they asked to go, when a rail click is what raised the question
 *   leaveFocus  -> the other half of leaving, applied once the sections are back on screen
 */
interface GuardMemory {
	dirty: boolean;
	opener: HTMLElement | undefined;
	leaveIntent: SectionId | undefined;
	leaveFocus: LeaveFocus | undefined;
}

/**
 * The edit destination fills the pane beside the rail - a destination, not an overlay, because opening a door on top
 * of a door is what this shell exists to stop. The key is a never-reused counter, so a closed page's key cannot revive
 * its state.
 *
 *   noteEditDirty    -> the page's dirty report; stable, since the page lists it in an effect's deps
 *   onTargetGone     -> the page's explicit "the draft ceased to exist" channel, separate from the dirty report on
 *                       purpose: only a target that is GONE may dismiss a standing discard question - a draft merely
 *                       reading clean again must leave the question to the reader
 *   requestLeaveEdit -> a dirty draft gets the question as a modal, which owns its own answering: asking is
 *                       idempotent, never a toggle
 *   selectSection    -> a rail click, routed through the guard while the page is open
 */
interface EditDestination {
	readonly editing: EditingPage | undefined;
	readonly confirmingDiscard: boolean;
	readonly noteEditDirty: (dirty: boolean) => void;
	readonly onTargetGone: () => void;
	readonly openEdit: (request: ServerEditRequest) => void;
	readonly leaveEdit: () => void;
	readonly requestLeaveEdit: () => void;
	readonly keepEditing: () => void;
	readonly selectSection: (id: SectionId) => void;
}

/**
 * The models list's server scope (a server row's model-count link sets it, the chip in the models filter bar clears
 * it). Held in the shell rather than in ModelsSection because the servers table is the other end of the wire.
 */
interface ServerScope {
	readonly label: string | undefined;
	readonly clear: () => void;
	readonly showServerModels: (label: string) => void;
}

/**
 * The inspected model's identity: (scopeKey, rawId, serverLabel), never the model object, since pushes rebuild the
 * models array and one snapshot can render under several labels with identical (scopeKey, rawId).
 */
interface InspectIdentity {
	readonly scopeKey: string;
	readonly rawId: string;
	readonly serverLabel: string;
}

/**
 * The open inspector overlay, held in the shell so it opens IN PLACE over the active tab.
 *
 *   model   -> the inspected model on the latest push
 *   inspect -> opened from the models table (no anchor) or the Resolved-models table (anchored on its
 *              Parameters/Capabilities section)
 */
interface Inspector {
	readonly anchor: InspectorSection | undefined;
	readonly model: DashboardModel | undefined;
	readonly inspect: (target: InspectIdentity, anchor?: InspectorSection) => void;
	readonly close: () => void;
}

/**
 * What the shell renders from once the first push landed.
 *
 *   now           -> one clock for every relative time on the page; hidden panels share the same tick instead of
 *                    running intervals of their own
 *   activeSection -> the section actually on screen: a recorded deep link shows immediately (no Servers-page frame
 *                    first), but defers while the edit destination is open, because leaving that page is a question
 *                    rather than a move
 */
interface ShellModel {
	readonly state: DashboardState;
	readonly stateSeq: number;
	readonly now: number;
	readonly section: SectionId;
	readonly activeSection: SectionId;
	readonly failures: FailuresByMethod;
	readonly writeFailures: SettingWriteFailures;
	readonly toasts: readonly ToastItem[];
	readonly dismissToast: (id: number) => void;
	readonly destination: EditDestination;
	readonly scope: ServerScope;
	readonly inspector: Inspector;
	readonly editRecordRequest: EditRecordRequest | undefined;
	readonly editRecord: (kind: "parameters" | "capabilities", key: string, create: boolean) => void;
	readonly editEntry: (label: string) => void;
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
 * Exported for the cross-surface vocabulary suite. Connected-with-zero-models is the shared warning state (see
 * zeroModelJudgment host-side): the word names it and the tone matches the status bar's warning, never a green beside
 * a warning bar.
 *
 *   The hero's overall verdict, mapped from the shared classifyOverall over the host's published verdict rows -> the
 *       strip, the tab, the status bar, and the notifier never disagree
 */
export function overallState(rows: readonly VerdictRow[], modelCount: number): Overall {
	switch (classifyOverall(rows)) {
		case "not-configured":
			return { tone: "muted", word: l10n.t("Not configured") };
		case "error":
			return { tone: "error", word: l10n.t("Error") };
		case "degraded":
			return { tone: "warn", word: l10n.t("Degraded") };
		case "waiting":
			return { tone: "muted", word: l10n.t("Waiting for first sync") };
		case "needs-declare":
			return { tone: "warn", word: l10n.t("No declared models") };
		case "connected":
			return modelCount === 0
				? { tone: "warn", word: l10n.t("Connected, no models") }
				: { tone: "ok", word: l10n.t("Connected") };
	}
}

function lastSync(servers: readonly DashboardServer[], now: number): string | undefined {
	const checkedMs = latestCheckedMs(servers);
	return checkedMs === undefined ? undefined : relativeTime(checkedMs, now);
}

/**
 * What each rail item counts - the number a reader would go there to find out. Absence is deliberate everywhere: an
 * empty fleet or catalogue counts nothing rather than zero, and a count that is always present stops being
 * information.
 */
function railSections(state: DashboardState): readonly RailSection<SectionId>[] {
	const counts: Readonly<Record<SectionId, { count?: string; countLabel?: string; countTone?: "warn" }>> = {
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
		// Tinted only when there is something to fix. Advisories are counted but never tinted: a permanent amber badge
		// for a typo hint is an alarm nobody can silence or act on.
		diagnostics: diagnosticsCount(pageConfigDiagnostics(state.diagnostics)),
		features: {},
		settings: {},
	};
	return SECTION_IDS.map((id) => ({ id, label: sectionLabel(id), icon: sectionIcon(id), ...counts[id] }));
}

/**
 * Counted whole, tinted only for problems to fix. Counts the diagnostics the destination actually renders
 * (pageConfigDiagnostics drops the server-row-owned ones), so badge and list can never disagree.
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
 * Grey stand-ins in the real shell classes, not a bare <main>: the page gutter belongs to the pane, and a skeleton
 * outside the shell jumped 24px when the first push landed.
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

function SectionPanel({ section, active, children }: { section: SectionId; active: SectionId; children: ReactNode }) {
	return (
		<div role="tabpanel" id={`panel-${section}`} aria-labelledby={`tab-${section}`} hidden={section !== active}>
			{children}
		</div>
	);
}

/**
 * A standing failure's pane-top line: visible while the failure stands, announced only on its first render per seq
 * (useAlertOnce). Callers key it by seq - a REPEAT carries a fresh seq, and the remount plus fresh role is what
 * announces it (adding role="alert" to an element already in the tree is not reliably spoken).
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
 * The toast an ack earns, or none. Adoption's caveat is the page's own notice, so its toast carries the base copy
 * alone.
 */
function ackToast(message: AckMessage, id: number): ToastItem | undefined {
	const base = toastText(message.method);
	if (base === undefined) {
		return undefined;
	}
	const caveat = message.method === "adoptServer" ? undefined : message.message;
	return { id, text: caveat === undefined ? base : `${base}. ${caveat}` };
}

function intentFailure(message: FailMessage, seq: number): IntentFailure {
	return { seq, message: message.message, kind: message.failureKind, row: message.row };
}

/**
 * One host message's effect on the shell. Read responses belong to the useRpc hook instances that posted them. The
 * deep link's includes check drops an unknown section instead of blanking every panel; recorded, then applied through
 * the same guard a rail click takes, so an open draft is asked about.
 */
function receiveHostMessage(message: ExtensionToWebviewMessage, sinks: HostSinks): void {
	if (message.kind === "push") {
		sinks.setState(message.state);
		sinks.setFailures(failuresAfterStatePush);
		sinks.setStateSeq((current) => current + 1);
		return;
	}
	if (message.kind === "focusSection") {
		if (SECTION_IDS.includes(message.section)) {
			sinks.setPendingFocusSection(message.section);
		}
		return;
	}
	if (message.kind === "response") {
		return;
	}
	const seq = sinks.nextSeq();
	if (message.kind === "ack") {
		const toast = ackToast(message, seq);
		if (toast !== undefined) {
			sinks.setToasts((current) => [...current, toast].slice(-3));
		}
		return;
	}
	if (isAckedMethod(message.method)) {
		return;
	}
	sinks.setFailures((current) => ({ ...current, [message.method]: intentFailure(message, seq) }));
}

/**
 * What the reader left when opening a page, captured by the shell since the page has no idea it was opened from a row.
 * The body is not an opener: focusing it later is a no-op that would skip the rail fallback and leave focus nowhere.
 */
function openerOf(): HTMLElement | undefined {
	const active = document.activeElement;
	return active instanceof HTMLElement && active !== document.body ? active : undefined;
}

function settingWriteFailuresOf(failures: FailuresByMethod): SettingWriteFailures {
	const writes: SettingWriteFailures = {};
	for (const method of SETTING_WRITE_METHODS) {
		const failure = failures[method];
		if (failure !== undefined) {
			writes[method] = failure;
		}
	}
	return writes;
}

/**
 * The latest scalar-write failure whose owning page is not on screen. Ownership routes through the SETTING_ROW_PAGES
 * map (Features rows announce there, everything else on Settings).
 */
function awaySettingFailure(
	writeFailures: SettingWriteFailures,
	activeSection: SectionId
): SettingWriteFailure | undefined {
	return Object.values(writeFailures).reduce(
		(latest: SettingWriteFailure | undefined, failure) =>
			failurePage(failure) !== activeSection && (latest === undefined || failure.seq > latest.seq) ? failure : latest,
		undefined
	);
}

/** The one-time message listener, and the state it writes. */
function useHostLink(): HostLink {
	const [state, setState] = useState<DashboardState | undefined>(undefined);
	const [stateSeq, setStateSeq] = useState(0);
	const [failures, setFailures] = useState<FailuresByMethod>({});
	const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
	const [pendingFocusSection, setPendingFocusSection] = useState<SectionId | undefined>(undefined);
	const dismissToast = useCallback((id: number) => {
		setToasts((current) => current.filter((toast) => toast.id !== id));
	}, []);
	const clearPendingFocus = useCallback(() => setPendingFocusSection(undefined), []);
	useEffect(() => {
		let seq = 0;
		const sinks: HostSinks = {
			nextSeq: () => {
				seq += 1;
				return seq;
			},
			setState,
			setStateSeq,
			setFailures,
			setToasts,
			setPendingFocusSection,
		};
		const onMessage = (event: MessageEvent) => {
			const message = asExtensionMessage(event.data);
			if (message !== undefined) {
				receiveHostMessage(message, sinks);
			}
		};
		window.addEventListener("message", onMessage);
		sendRequest("ready", null);
		return () => window.removeEventListener("message", onMessage);
	}, []);
	return { state, stateSeq, failures, toasts, dismissToast, pendingFocusSection, clearPendingFocus };
}

/**
 * A recorded deep link, applied through the navigation guard once there is a page to apply it to. The guard is read
 * through a ref, as the effect must see the current editing state rather than the render closure's.
 */
function useDeepLink(link: HostLink, selectSection: (id: SectionId) => void): void {
	const selectSectionRef = useRef<(id: SectionId) => void>(() => undefined);
	selectSectionRef.current = selectSection;
	const { pendingFocusSection, clearPendingFocus, state } = link;
	useEffect(() => {
		if (pendingFocusSection === undefined || state === undefined) {
			return;
		}
		clearPendingFocus();
		selectSectionRef.current(pendingFocusSection);
	}, [pendingFocusSection, state, clearPendingFocus]);
}

/**
 * The other half of leaveEdit: run once the pane has re-rendered with the sections back on screen, since a hidden
 * subtree cannot take focus. Focus returns to the opener - or, on a rail click, to the picked destination. A row that
 * left with a save (a rename mints a new one) falls back to the section's own rail item rather than nowhere.
 */
function useLeaveFocus(editing: EditingPage | undefined, section: SectionId, memory: RefObject<GuardMemory>): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the destination closing
	useEffect(() => {
		const pending = memory.current.leaveFocus;
		if (editing !== undefined || pending === undefined) {
			return;
		}
		memory.current.leaveFocus = undefined;
		if (pending.kind === "section") {
			document.getElementById(`tab-${pending.section}`)?.focus();
			return;
		}
		const opener = memory.current.opener;
		memory.current.opener = undefined;
		if (opener?.isConnected === true) {
			opener.focus();
			return;
		}
		document.getElementById(`tab-${section}`)?.focus();
	}, [editing]);
}

/**
 * Both ways out of the page go through leaveEdit, so there is one answer to "where does focus go when the page
 * closes". A rail click while the question stands asks again, never toggles: a reader who clicks one rail item, sees
 * the question, and then clicks another has changed their destination - not answered. Toggling would dismiss the
 * question and go nowhere, which reads as the click being ignored.
 */
function useEditDestination(section: SectionId, setSection: (id: SectionId) => void): EditDestination {
	const [editing, setEditing] = useState<EditingPage | undefined>(undefined);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	const nextEditKey = useRef(1);
	const memory = useRef<GuardMemory>({
		dirty: false,
		opener: undefined,
		leaveIntent: undefined,
		leaveFocus: undefined,
	});
	const noteEditDirty = useCallback((dirty: boolean) => {
		memory.current.dirty = dirty;
	}, []);
	const onTargetGone = useCallback(() => {
		memory.current.dirty = false;
		memory.current.leaveIntent = undefined;
		setConfirmingDiscard(false);
	}, []);
	useLeaveFocus(editing, section, memory);
	const openEdit = (request: ServerEditRequest) => {
		memory.current.opener = openerOf();
		memory.current.leaveIntent = undefined;
		memory.current.dirty = false;
		setConfirmingDiscard(false);
		setEditing({ request, key: nextEditKey.current });
		nextEditKey.current += 1;
	};
	const leaveEdit = () => {
		const intent = memory.current.leaveIntent;
		memory.current.leaveIntent = undefined;
		setEditing(undefined);
		memory.current.dirty = false;
		setConfirmingDiscard(false);
		if (intent !== undefined) {
			setSection(intent);
		}
		memory.current.leaveFocus = intent === undefined ? { kind: "opener" } : { kind: "section", section: intent };
	};
	const requestLeaveEdit = () => {
		if (memory.current.dirty) {
			setConfirmingDiscard(true);
			return;
		}
		leaveEdit();
	};
	const keepEditing = () => {
		memory.current.leaveIntent = undefined;
		setConfirmingDiscard(false);
	};
	const selectSection = (id: SectionId) => {
		if (editing === undefined) {
			setSection(id);
			return;
		}
		memory.current.leaveIntent = id;
		if (memory.current.dirty) {
			setConfirmingDiscard(true);
			return;
		}
		leaveEdit();
	};
	return {
		editing,
		confirmingDiscard,
		noteEditDirty,
		onTargetGone,
		openEdit,
		leaveEdit,
		requestLeaveEdit,
		keepEditing,
		selectSection,
	};
}

/**
 * A scope whose server left the list would filter the table down to nothing with no row left to explain why, so it
 * clears itself.
 *
 * A server's count link navigates and filters, and focus follows the navigation: without it, Tab would continue from
 * the count link on a panel no longer visible. The models panel is hidden until the render commits and a hidden
 * element cannot take focus, so a flag asks the section effect to focus it once it shows.
 *
 * Already on Models, setSection would be a no-op, so that effect would never run and the flag would latch, stealing
 * focus the next time the reader arrived by any route; the panel is visible, so focus moves now and leaves no flag
 * behind.
 */
function useServerScope(
	state: DashboardState | undefined,
	section: SectionId,
	setSection: (id: SectionId) => void
): ServerScope {
	const [label, setLabel] = useState<string | undefined>(undefined);
	const pendingFocus = useRef(false);
	useEffect(() => {
		if (label !== undefined && state !== undefined && !state.servers.some((s) => s.label === label)) {
			setLabel(undefined);
		}
	}, [label, state]);
	useEffect(() => {
		if (pendingFocus.current && section === "models") {
			pendingFocus.current = false;
			document.getElementById(sectionId("models"))?.focus({ preventScroll: true });
		}
	}, [section]);
	const showServerModels = (next: string) => {
		setLabel(next);
		if (section === "models") {
			document.getElementById(sectionId("models"))?.focus({ preventScroll: true });
			return;
		}
		setSection("models");
		pendingFocus.current = true;
	};
	return { label, clear: () => setLabel(undefined), showServerModels };
}

/** An inspector whose model left the list closes instead of rendering stale values. */
function useInspector(state: DashboardState | undefined): Inspector {
	const [inspecting, setInspecting] = useState<
		(InspectIdentity & { anchor?: InspectorSection | undefined }) | undefined
	>(undefined);
	const model =
		inspecting === undefined
			? undefined
			: state?.models.find(
					(candidate) =>
						candidate.scopeKey === inspecting.scopeKey &&
						candidate.rawId === inspecting.rawId &&
						candidate.serverLabel === inspecting.serverLabel
				);
	useEffect(() => {
		if (inspecting !== undefined && state !== undefined && model === undefined) {
			setInspecting(undefined);
		}
	}, [inspecting, state, model]);
	return {
		anchor: inspecting?.anchor,
		model,
		inspect: (target, anchor) => setInspecting({ ...target, anchor }),
		close: () => setInspecting(undefined),
	};
}

/** The configuration push restamps the root, so the picker and a hand edit of settings.json travel the identical path. */
function useAppearance(appearance: DashboardState["settings"]["appearance"] | undefined): void {
	useEffect(() => {
		if (appearance !== undefined) {
			document.documentElement.dataset.theme = appearance.theme;
			document.documentElement.dataset.accent = appearance.accent;
		}
	}, [appearance]);
}

/** The shell's whole state, or nothing before the first push. */
function useShell(): ShellModel | undefined {
	const link = useHostLink();
	const [section, setSection] = useState<SectionId>("overview");
	const [editRecordRequest, setEditRecordRequest] = useState<EditRecordRequest | undefined>(undefined);
	const destination = useEditDestination(section, setSection);
	const scope = useServerScope(link.state, section, setSection);
	const inspector = useInspector(link.state);
	const now = useNow();
	useAppearance(link.state?.settings.appearance);
	useDeepLink(link, destination.selectSection);
	if (link.state === undefined) {
		return undefined;
	}
	const deepLinked = link.pendingFocusSection !== undefined && destination.editing === undefined;
	return {
		state: link.state,
		stateSeq: link.stateSeq,
		now,
		section,
		activeSection: deepLinked ? link.pendingFocusSection : section,
		failures: link.failures,
		writeFailures: settingWriteFailuresOf(link.failures),
		toasts: link.toasts,
		dismissToast: link.dismissToast,
		destination,
		scope,
		inspector,
		editRecordRequest,
		editRecord: (kind, key, create) => {
			setSection("settings");
			setEditRecordRequest((current) => ({ seq: (current?.seq ?? 0) + 1, kind, key, create }));
		},
		editEntry: (label) => {
			setSection("overview");
			destination.openEdit({ kind: "edit", label });
		},
	};
}

/**
 * The pane-top methods (today executeCommand alone) keep a pane-top line each: they are posted from every tab and own
 * no row anywhere. Derived from the endpoint table's fail marks, so a new method of either class renders without
 * touching this shell.
 *
 * The away-settings line renders only while the reader is NOT on the failure's own page: a rail click can be the very
 * blur that commits the failing write, the fail lands after the owning panel is hidden, and a hidden subtree neither
 * paints nor announces.
 *
 * All lines announce once per failure seq and then stand silently (PaneFailureLine): the away line re-mounts on every
 * navigation away from Settings while its failure stands unchanged.
 */
function PaneTopLines({ shell }: { shell: ShellModel }) {
	const { failures, writeFailures, activeSection } = shell;
	const paneTop = PANE_TOP_FAIL_METHODS.flatMap((method) => {
		const failure = failures[method];
		return failure === undefined ? [] : [{ method, failure }];
	});
	const away = awaySettingFailure(writeFailures, activeSection);
	return (
		<>
			{paneTop.map(({ method, failure }) => (
				<PaneFailureLine key={tupleKey(method, failure.seq)} failure={failure} />
			))}
			{away === undefined ? null : <PaneFailureLine key={away.seq} failure={away} />}
		</>
	);
}

/**
 * The destination lives INSIDE the Servers panel: the rail still says Servers. The list stays mounted behind it -
 * hidden, not unmounted - so the row that opened the page survives to take focus back, with its scroll position.
 */
function ServersPanel({ shell }: { shell: ShellModel }) {
	const { state, now, activeSection, destination, scope } = shell;
	const { editing } = destination;
	return (
		<SectionPanel section="overview" active={activeSection}>
			{editing === undefined ? null : (
				<ServerEditPage
					key={editing.key}
					request={editing.request}
					servers={state.servers}
					onDirtyChange={destination.noteEditDirty}
					onTargetGone={destination.onTargetGone}
					onRequestClose={destination.requestLeaveEdit}
					onSaved={destination.leaveEdit}
				/>
			)}
			<div hidden={editing !== undefined}>
				<ServersSection
					servers={state.servers}
					hidden={state.hiddenGroups}
					usage={state.usage}
					currencySymbol={state.settings.usage.currencySymbol}
					now={now}
					onShowModels={scope.showServerModels}
					onEditServer={(label) => destination.openEdit({ kind: "edit", label })}
					onAdoptServer={(handle) => destination.openEdit({ kind: "adopt", handle })}
					onAddServer={() => destination.openEdit({ kind: "add" })}
				/>
			</div>
		</SectionPanel>
	);
}

function FeaturesPanel({ shell }: { shell: ShellModel }) {
	const { state, activeSection, writeFailures } = shell;
	return (
		<SectionPanel section="features" active={activeSection}>
			<FeaturesSection
				settings={state.settings}
				models={state.models}
				declaredServerLabels={state.servers
					.filter((server) => server.origin === "declared")
					.map((server) => server.label)}
				featureProbes={state.featureProbes}
				writeFailures={writeFailures}
			/>
		</SectionPanel>
	);
}

function SettingsPanel({ shell }: { shell: ShellModel }) {
	const { state, now, activeSection, editRecordRequest, writeFailures } = shell;
	return (
		<SectionPanel section="settings" active={activeSection}>
			<SettingsSection
				settings={state.settings}
				models={state.models}
				observedModelInfoKeys={state.observedModelInfoKeys}
				now={now}
				editRecordRequest={editRecordRequest}
				writeFailures={writeFailures}
			/>
		</SectionPanel>
	);
}

function ModelsPanel({ shell }: { shell: ShellModel }) {
	const { state, activeSection, scope, inspector } = shell;
	return (
		<SectionPanel section="models" active={activeSection}>
			<ModelsSection
				models={state.models}
				serverCount={state.servers.length}
				currencySymbol={state.settings.usage.currencySymbol}
				scope={scope.label === undefined ? undefined : { label: scope.label, onClear: scope.clear }}
				onInspect={inspector.inspect}
			/>
		</SectionPanel>
	);
}

function DiagnosticsPanel({ shell }: { shell: ShellModel }) {
	const { state, stateSeq, section, activeSection, inspector } = shell;
	return (
		<SectionPanel section="diagnostics" active={activeSection}>
			<DiagnosticsSection
				servers={state.servers}
				verdictRows={state.verdictRows}
				modelCount={state.servedModelCount}
				diagnostics={state.diagnostics}
				active={section === "diagnostics"}
				stateSeq={stateSeq}
				currencySymbol={state.settings.usage.currencySymbol}
				onInspect={inspector.inspect}
			/>
		</SectionPanel>
	);
}

/**
 * The inspector overlay, above the tab panels so it opens in place on any tab; the configure-jumps close the overlay
 * first - the editor they land on is the next surface.
 */
function InspectorOverlay({ shell }: { shell: ShellModel }) {
	const { state, stateSeq, section, inspector } = shell;
	if (inspector.model === undefined) {
		return null;
	}
	return (
		<ModelInspector
			model={inspector.model}
			stateSeq={stateSeq}
			currencySymbol={state.settings.usage.currencySymbol}
			anchor={inspector.anchor}
			fallbackFocusId={`tab-${section}`}
			onClose={inspector.close}
			onEditRecord={(kind, key, create) => {
				inspector.close();
				shell.editRecord(kind, key, create);
			}}
			onEditEntry={(label) => {
				inspector.close();
				shell.editEntry(label);
			}}
		/>
	);
}

/** The navigation guard's question, a modal: leaving a dirty page is a decision about the whole page. */
function DiscardQuestion({ destination }: { destination: EditDestination }) {
	if (destination.editing === undefined || !destination.confirmingDiscard) {
		return null;
	}
	return (
		<ConfirmDialog
			question={l10n.t("Discard unsaved changes?")}
			confirmLabel={l10n.t("Discard")}
			cancelLabel={l10n.t("Keep editing")}
			surfaceId="server-edit-page"
			onConfirm={destination.leaveEdit}
			onCancel={destination.keepEditing}
		/>
	);
}

/**
 * The shell once the first push landed. Esc while the destination is open is the shell's, and only what reaches it (the
 * listbox and matcher overlay stop their own). On the shell rather than the pane because the rail is a sibling - a
 * reader who just clicked a rail item has focus there.
 */
function Shell({ shell, toastDurationMs }: { shell: ShellModel; toastDurationMs: number }) {
	const { state, now, activeSection, destination } = shell;
	return (
		<AnnounceOnceScope>
			<main
				className="shell"
				onKeyDown={(event) => {
					if (destination.editing === undefined || event.key !== "Escape") {
						return;
					}
					event.preventDefault();
					event.stopPropagation();
					destination.requestLeaveEdit();
				}}
			>
				<Rail
					sections={railSections(state)}
					active={activeSection}
					onSelect={destination.selectSection}
					serverCount={state.servers.length}
					overall={overallState(state.verdictRows, state.servedModelCount)}
					synced={lastSync(state.servers, now)}
				/>
				<div className="pane">
					<PaneTopLines shell={shell} />
					<ServersPanel shell={shell} />
					<FeaturesPanel shell={shell} />
					<SettingsPanel shell={shell} />
					<ModelsPanel shell={shell} />
					<DiagnosticsPanel shell={shell} />
				</div>
				<ToastHost toasts={shell.toasts} durationMs={toastDurationMs} onDismiss={shell.dismissToast} />
				<InspectorOverlay shell={shell} />
				<DiscardQuestion destination={destination} />
			</main>
		</AnnounceOnceScope>
	);
}

export function App({ toastDurationMs = TOAST_DURATION_MS }: { toastDurationMs?: number } = {}) {
	const shell = useShell();
	if (shell === undefined) {
		return <LoadingSkeleton />;
	}
	return <Shell shell={shell} toastDurationMs={toastDurationMs} />;
}
