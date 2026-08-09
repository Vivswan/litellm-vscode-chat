import * as l10n from "@vscode/l10n";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type {
	DashboardIntentType,
	DashboardSectionId,
	DashboardServer,
	DashboardState,
	ExtensionToWebviewMessage,
} from "../../extension/dashboard/protocol";
import {
	classifyOverall,
	DASHBOARD_SECTION_IDS,
	failuresAfterStatePush,
	isExtensionMessageType,
	latestCheckedMs,
} from "../../extension/dashboard/protocol";
import type { ModelCapabilitiesResponse } from "./capsInspector";
import { CapsInspector } from "./capsInspector";
import type { ResolvedModelsResponse } from "./diagnostics";
import { DiagnosticsSection } from "./diagnostics";
import { FailureText } from "./failureText";
import { IconBug, IconClose } from "./icons";
import { ModelsSection } from "./models";
import type { ModelParametersResponse } from "./paramsInspector";
import { ParamsInspector } from "./paramsInspector";
import type { CatalogSearchResponse, IntentFailure } from "./recordEditors";
import type { ServerEditRequest } from "./servers";
import { ServersSection } from "./servers";
import type { EditRecordRequest } from "./settings";
import { SettingsSection } from "./settings";
import { relativeTime, useNow } from "./time";
import { UsageSection } from "./usage";
import { postMessage } from "./vscodeApi";

/** The section tabs; the ID list lives in the protocol module because focusSection deep-links name them. */
const SECTION_IDS = DASHBOARD_SECTION_IDS;
type SectionId = DashboardSectionId;

/** The tab labels, resolved at render time (no module-level localized constants). */
function sectionLabel(section: SectionId): string {
	switch (section) {
		case "overview":
			return l10n.t("Servers & Models");
		case "usage":
			return l10n.t("Usage");
		case "settings":
			return l10n.t("Settings");
		case "diagnostics":
			return l10n.t("Diagnostics");
	}
}

/**
 * Messages arriving on the window come from the extension only (the CSP
 * allows no other frames), so a shape check on the discriminant suffices.
 * The accepted set is derived from the message union in the protocol module,
 * so a new message type cannot be silently dropped here.
 */
function asExtensionMessage(data: unknown): ExtensionToWebviewMessage | undefined {
	if (typeof data !== "object" || data === null) {
		return undefined;
	}
	const type = (data as { type?: unknown }).type;
	return isExtensionMessageType(type) ? (data as ExtensionToWebviewMessage) : undefined;
}

/** The latest reported intent failures, keyed by the failed intent's type. */
export type FailuresByIntent = Readonly<Partial<Record<DashboardIntentType, IntentFailure>>>;

/**
 * The latest inlineSecrets response (the edit form's on-demand prefill); the
 * open form matches it against its own requestId. Held outside DashboardState
 * on purpose: state pushes never carry secret material.
 */
export type InlineSecretsResponse = Extract<ExtensionToWebviewMessage, { type: "inlineSecrets" }>;

/** The latest intentSucceeded notice; editors match it against their own requestId. */
export interface IntentAck {
	readonly seq: number;
	readonly requestId: string;
	/** The extension's optional caveat about the success (see intentSucceeded). */
	readonly message?: string | undefined;
}

/**
 * The server intents whose success gets a transient toast, with static base
 * copy (never text from the payload). Scalar and record edits stay silent:
 * their success is the value visibly updating in place. The adopt toast
 * carries no caveat text because the post-adoption notice already renders
 * the extension's message in full. Resolved at call time (no module-level
 * localized constants).
 */
function toastText(intentType: DashboardIntentType): string | undefined {
	switch (intentType) {
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
		<div class="toast">
			<span>{toast.text}</span>
			<button
				type="button"
				class="quiet"
				aria-label={l10n.t("Dismiss notification")}
				onClick={() => onDismiss(toast.id)}
			>
				<IconClose />
			</button>
		</div>
	);
}

/**
 * The toast stack, bottom-right like the host's own notifications. The
 * container is a polite live region so a save's outcome is announced without
 * stealing focus from wherever the user is typing.
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
		<div class="toasts" role="status" aria-live="polite">
			{toasts.map((toast) => (
				<Toast key={toast.id} toast={toast} durationMs={durationMs} onDismiss={onDismiss} />
			))}
		</div>
	);
}

type Overall = { tone: "ok" | "error" | "warn" | "muted"; word: string };

/**
 * The hero's overall verdict. The classification is shared with the
 * Diagnostics tab (classifyOverall in the protocol module); this only maps
 * it to the hero's tone and word, with the tab's legacy-registry rule
 * mirrored so the strip and the tab never disagree about the same install.
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

/** The at-a-glance strip the status bar click promises: overall state, counts, last sync, and Sync. */
function StatusHero({ state, now }: { state: DashboardState; now: number }) {
	const overall = overallState(state.servers, state.legacyServerCount);
	const synced = lastSync(state.servers, now);
	return (
		<div class="hero">
			<span class={`pill tone-${overall.tone}`}>
				<span class="dot" />
				{overall.word}
			</span>
			<span class="stat">
				<strong>{state.servers.length}</strong>{" "}
				{state.servers.length === 1
					? l10n.t({ message: "server", comment: ["singular noun after the count in the hero strip"] })
					: l10n.t({ message: "servers", comment: ["plural noun after the count in the hero strip"] })}
			</span>
			<span class="stat">
				<strong>{state.models.length}</strong>{" "}
				{state.models.length === 1
					? l10n.t({ message: "model", comment: ["singular noun after the count in the hero strip"] })
					: l10n.t({ message: "models", comment: ["plural noun after the count in the hero strip"] })}
			</span>
			{synced !== undefined ? <span class="stat">{l10n.t("last sync {0}", synced)}</span> : null}
			<span class="spacer" />
			<button
				type="button"
				class="secondary"
				disabled={state.servers.length === 0}
				onClick={() => postMessage({ type: "executeCommand", command: "syncModels" })}
			>
				{l10n.t("Sync models")}
			</button>
		</div>
	);
}

/** Grey stand-ins shaped like the page (title, hero strip, tab bar, a table); no spinner, no motion. */
function LoadingSkeleton() {
	return (
		<main aria-label={l10n.t("Loading")}>
			<div class="skeleton" style={{ height: "20px", width: "220px", margin: "24px 0 4px" }} />
			<div class="skeleton" style={{ height: "13px", width: "420px", margin: "8px 0 16px" }} />
			<div class="skeleton" style={{ height: "38px", margin: "16px 0 24px" }} />
			<div class="skeleton" style={{ height: "26px", width: "260px", margin: "0 0 24px" }} />
			<div class="skeleton" style={{ height: "14px", width: "120px", margin: "0 0 12px" }} />
			<div class="skeleton" style={{ height: "24px", margin: "8px 0" }} />
			<div class="skeleton" style={{ height: "24px", margin: "8px 0" }} />
			<div class="skeleton" style={{ height: "24px", margin: "8px 0" }} />
			<div class="skeleton" style={{ height: "24px", margin: "8px 0" }} />
		</main>
	);
}

/**
 * The section tab bar. Native panel-tab anatomy (underlined active title on
 * the panelTitle theme tokens) with the WAI-ARIA tabs contract: roving
 * tabindex, arrow keys move focus and selection together, Home/End jump. The
 * inactive panels stay mounted below (hidden, not unmounted) so an open form
 * or a half-typed filter survives a visit to another section. The tabs carry
 * no count badges: the hero directly above already shows the server and
 * model totals.
 */
function SectionTabs({ active, onSelect }: { active: SectionId; onSelect: (section: SectionId) => void }) {
	const select = (section: SectionId) => {
		onSelect(section);
		document.getElementById(`tab-${section}`)?.focus();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		const index = SECTION_IDS.indexOf(active);
		if (event.key === "ArrowRight") {
			select(SECTION_IDS[(index + 1) % SECTION_IDS.length] as SectionId);
		} else if (event.key === "ArrowLeft") {
			select(SECTION_IDS[(index + SECTION_IDS.length - 1) % SECTION_IDS.length] as SectionId);
		} else if (event.key === "Home") {
			select(SECTION_IDS[0] as SectionId);
		} else if (event.key === "End") {
			select(SECTION_IDS[SECTION_IDS.length - 1] as SectionId);
		} else {
			return;
		}
		event.preventDefault();
	};
	return (
		<div class="tabs" role="tablist" aria-label={l10n.t("Dashboard sections")} onKeyDown={onKeyDown}>
			{SECTION_IDS.map((section) => (
				<button
					key={section}
					type="button"
					class="tab"
					role="tab"
					id={`tab-${section}`}
					aria-selected={section === active}
					aria-controls={`panel-${section}`}
					tabIndex={section === active ? 0 : -1}
					onClick={() => onSelect(section)}
				>
					{sectionLabel(section)}
				</button>
			))}
		</div>
	);
}

/** One tab's content, kept mounted while hidden; see SectionTabs. */
function SectionPanel({
	section,
	active,
	children,
}: {
	section: SectionId;
	active: SectionId;
	children: ComponentChildren;
}) {
	return (
		<div role="tabpanel" id={`panel-${section}`} aria-labelledby={`tab-${section}`} hidden={section !== active}>
			{children}
		</div>
	);
}

/**
 * The dashboard root: holds the latest pushed state and the latest intent
 * outcomes, nothing else. The extension re-pushes the full state on every
 * store change, so this component never mutates or persists what it renders.
 * A state push retires only the failure notices of intents whose success
 * signal is the push itself (the record and scalar editors); server intents
 * carry a requestId and get correlated outcome notices, so their failures
 * clear on their own success or an explicit dismissal, never on a push - the
 * sync a partially applied save triggers pushes state moments later and must
 * not erase the warning that save raised.
 */
export function App({ toastDurationMs = TOAST_DURATION_MS }: { toastDurationMs?: number } = {}) {
	const [state, setState] = useState<DashboardState | undefined>(undefined);
	const [section, setSection] = useState<SectionId>("overview");
	const [ack, setAck] = useState<IntentAck | undefined>(undefined);
	const [failures, setFailures] = useState<FailuresByIntent>({});
	const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
	const [inlineSecrets, setInlineSecrets] = useState<InlineSecretsResponse | undefined>(undefined);
	// The latest request/response answers (capability and params inspectors,
	// catalog search, resolved-models view); each consumer matches them
	// against its own requestId, like inlineSecrets.
	const [capsResponse, setCapsResponse] = useState<ModelCapabilitiesResponse | undefined>(undefined);
	const [paramsResponse, setParamsResponse] = useState<ModelParametersResponse | undefined>(undefined);
	const [resolvedResponse, setResolvedResponse] = useState<ResolvedModelsResponse | undefined>(undefined);
	const [catalogResults, setCatalogResults] = useState<CatalogSearchResponse | undefined>(undefined);
	// Bumped on every state push: the open inspectors and the resolved-models
	// view re-request on it so they follow configuration edits live.
	const [stateSeq, setStateSeq] = useState(0);
	// The open inspector overlay, held here so it opens IN PLACE over whatever
	// tab is active (the Diagnostics table's jump must not leave the tab). The
	// identity is (scopeKey, rawId, serverLabel), never the model object:
	// every state push rebuilds the models array, and the open inspector must
	// follow the fresh values or close when its row leaves the list. The
	// serverLabel matters because one snapshot can render under several
	// labels, giving rows identical (scopeKey, rawId); the inspector must
	// stay on the exact row whose action was clicked. `view` names which
	// inspector is open; one row, one slide-over at a time.
	const [inspecting, setInspecting] = useState<
		{ scopeKey: string; rawId: string; serverLabel: string; view: "params" | "caps" } | undefined
	>(undefined);
	// The inspectors' configure-jumps: into the settings record editors, and
	// into a server entry's edit form (the owner of entry-layer values).
	const [editRecordRequest, setEditRecordRequest] = useState<EditRecordRequest | undefined>(undefined);
	const [serverEditRequest, setServerEditRequest] = useState<ServerEditRequest | undefined>(undefined);
	// The models list's server scope (a server row's model-count link sets it,
	// the chip in the models filter bar clears it). Held here rather than in
	// ModelsSection because the servers table is the other end of the wire.
	const [serverScope, setServerScope] = useState<string | undefined>(undefined);
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
			if (message.type === "state") {
				setState(message.state);
				setFailures(failuresAfterStatePush);
				setStateSeq((current) => current + 1);
				return;
			}
			if (message.type === "focusSection") {
				// The extension's deep link (litellm.showDiagnostics landing on the
				// Diagnostics tab); the includes check drops a section this page
				// does not have instead of blanking every panel.
				if (SECTION_IDS.includes(message.section)) {
					setSection(message.section);
				}
				return;
			}
			if (message.type === "inlineSecrets") {
				setInlineSecrets(message);
				return;
			}
			if (message.type === "modelCapabilities") {
				setCapsResponse(message);
				return;
			}
			if (message.type === "modelParameters") {
				setParamsResponse(message);
				return;
			}
			if (message.type === "resolvedModels") {
				setResolvedResponse(message);
				return;
			}
			if (message.type === "catalogSearchResults") {
				setCatalogResults(message);
				return;
			}
			seq += 1;
			if (message.type === "intentSucceeded") {
				setAck({ seq, requestId: message.requestId, message: message.message });
				setFailures((current) => {
					if (current[message.intentType] === undefined) {
						return current;
					}
					const { [message.intentType]: _dropped, ...rest } = current;
					return rest;
				});
				const base = toastText(message.intentType);
				if (base !== undefined) {
					const caveat = message.intentType !== "adoptServer" ? message.message : undefined;
					const text = caveat !== undefined ? `${base}. ${caveat}` : base;
					// The stack stays readable: at most three, oldest dropped first.
					setToasts((current) => [...current, { id: seq, text }].slice(-3));
				}
				return;
			}
			const failure: IntentFailure = {
				seq,
				message: message.message,
				kind: message.kind,
				requestId: message.requestId,
				classification: message.classification,
			};
			setFailures((current) => ({ ...current, [message.intentType]: failure }));
		};
		window.addEventListener("message", onMessage);
		postMessage({ type: "ready" });
		return () => window.removeEventListener("message", onMessage);
	}, []);

	// A scope whose server left the list would filter the table down to
	// nothing with no row left to explain why, so it clears itself.
	useEffect(() => {
		if (serverScope !== undefined && state !== undefined && !state.servers.some((s) => s.label === serverScope)) {
			setServerScope(undefined);
		}
	}, [serverScope, state]);

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

	if (state === undefined) {
		return <LoadingSkeleton />;
	}

	const dismissFailure = (intentType: DashboardIntentType) => {
		setFailures((current) => {
			const { [intentType]: _dropped, ...rest } = current;
			return rest;
		});
	};

	const showServerModels = (label: string) => {
		setServerScope(label);
		// The jump moves the reading position and the keyboard position
		// together: without the focus call, Tab would continue from the count
		// link the user just left behind.
		const target = document.getElementById("models-section");
		target?.scrollIntoView();
		target?.focus({ preventScroll: true });
	};

	// A model's inspector overlay: opened from the models table or the
	// Resolved-models table, rendered over the ACTIVE tab (no tab switch - the
	// Diagnostics reader keeps their place; closing just removes the overlay).
	const inspectModel = (target: { scopeKey: string; rawId: string; serverLabel: string }, view: "params" | "caps") => {
		setInspecting({ ...target, view });
	};

	// The inspectors' configure-jump: land on the settings tab with the right
	// record editor focused (or a fresh exact-ID draft created).
	const editRecord = (kind: "parameters" | "capabilities", key: string, create: boolean) => {
		setSection("settings");
		setEditRecordRequest((current) => ({ seq: (current?.seq ?? 0) + 1, kind, key, create }));
	};

	// An entry-owned value's jump: its record lives in the server entry, so the
	// destination is the entry's edit form on the overview section.
	const editEntry = (label: string) => {
		setSection("overview");
		setServerEditRequest((current) => ({ seq: (current?.seq ?? 0) + 1, label }));
	};

	// The single-shot setting writes share one failure surface: every one of
	// these rows (numbers, booleans, resets, command kicks, and the usage
	// alert-thresholds editor) commits on its own without a draft to reopen,
	// so the last failed write reports here.
	const scalarFailure =
		failures.setNumberSetting ??
		failures.setBooleanSetting ??
		failures.resetSetting ??
		failures.setUsageAlertThresholds ??
		failures.executeCommand;
	return (
		<main>
			<div class="page-head">
				<h1>{l10n.t("LiteLLM Dashboard")}</h1>
				<button
					type="button"
					class="quiet"
					onClick={() => postMessage({ type: "executeCommand", command: "reportIssue" })}
				>
					<IconBug /> {l10n.t("Report a bug")}
				</button>
			</div>
			<p class="hint">{l10n.t("Servers, models, and settings in one place; edits land in your VS Code settings.")}</p>
			<StatusHero state={state} now={now} />
			{scalarFailure !== undefined ? (
				<p class="error">
					<FailureText
						message={scalarFailure.message}
						frame={(headline) => l10n.t("The last change did not apply: {0}", headline)}
					/>
				</p>
			) : null}
			<SectionTabs active={section} onSelect={setSection} />
			<SectionPanel section="overview" active={section}>
				<ServersSection
					servers={state.servers}
					hidden={state.hiddenGroups}
					usage={state.usage}
					now={now}
					ack={ack}
					failures={failures}
					inlineSecrets={inlineSecrets}
					catalogResults={catalogResults}
					onDismissFailure={dismissFailure}
					onClearInlineSecrets={() => setInlineSecrets(undefined)}
					onShowModels={showServerModels}
					editRequest={serverEditRequest}
				/>
				{/* With zero servers the guided start card is the whole story; a
				    second empty block under it would dilute it. */}
				{state.servers.length > 0 ? (
					<ModelsSection
						models={state.models}
						serverCount={state.servers.length}
						scope={
							serverScope !== undefined ? { label: serverScope, onClear: () => setServerScope(undefined) } : undefined
						}
						onInspect={inspectModel}
					/>
				) : null}
			</SectionPanel>
			<SectionPanel section="usage" active={section}>
				<UsageSection usage={state.usage} serverCount={state.servers.length} now={now} />
			</SectionPanel>
			<SectionPanel section="settings" active={section}>
				<SettingsSection
					settings={state.settings}
					models={state.models}
					ack={ack}
					failures={failures}
					catalogResults={catalogResults}
					now={now}
					editRecordRequest={editRecordRequest}
				/>
			</SectionPanel>
			<SectionPanel section="diagnostics" active={section}>
				<DiagnosticsSection
					servers={state.servers}
					modelCount={state.models.length}
					legacyServerCount={state.legacyServerCount}
					diagnostics={state.diagnostics}
					resolvedResponse={resolvedResponse}
					active={section === "diagnostics"}
					stateSeq={stateSeq}
					onInspect={inspectModel}
					now={now}
				/>
			</SectionPanel>
			<ToastHost toasts={toasts} durationMs={toastDurationMs} onDismiss={dismissToast} />
			{/* The inspector overlays, above the tab panels so they open in place
			    on any tab; the configure-jumps close the overlay first - the
			    editor they land on is the next surface. */}
			{inspectedModel !== undefined && inspecting?.view === "params" ? (
				<ParamsInspector
					model={inspectedModel}
					response={paramsResponse}
					stateSeq={stateSeq}
					fallbackFocusId={`tab-${section}`}
					onClose={() => setInspecting(undefined)}
					onEditRecord={(key, create) => {
						setInspecting(undefined);
						editRecord("parameters", key, create);
					}}
					onEditEntry={(label) => {
						setInspecting(undefined);
						editEntry(label);
					}}
				/>
			) : null}
			{inspectedModel !== undefined && inspecting?.view === "caps" ? (
				<CapsInspector
					model={inspectedModel}
					response={capsResponse}
					stateSeq={stateSeq}
					fallbackFocusId={`tab-${section}`}
					onClose={() => setInspecting(undefined)}
					onEditRecord={(key, create) => {
						setInspecting(undefined);
						editRecord("capabilities", key, create);
					}}
					onEditEntry={(label) => {
						setInspecting(undefined);
						editEntry(label);
					}}
				/>
			) : null}
		</main>
	);
}
