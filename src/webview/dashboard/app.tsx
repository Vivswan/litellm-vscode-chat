import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type {
	DashboardIntentType,
	DashboardServer,
	DashboardState,
	ExtensionToWebviewMessage,
} from "../../extension/dashboard/protocol";
import { classifyOverall, failuresAfterStatePush, isExtensionMessageType } from "../../extension/dashboard/protocol";
import { IconClose } from "./icons";
import { ModelsSection } from "./models";
import type { IntentFailure } from "./recordEditors";
import { ServersSection } from "./servers";
import { SettingsSection } from "./settings";
import { relativeTime, useNow } from "./time";
import { postMessage } from "./vscodeApi";

/** The dashboard's top-level sections, one tab each; servers first because setup starts there. */
const SECTION_IDS = ["servers", "models", "settings"] as const;
type SectionId = (typeof SECTION_IDS)[number];

const SECTION_LABELS: Record<SectionId, string> = {
	servers: "Servers",
	models: "Models",
	settings: "Settings",
};

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
 * the extension's message in full.
 */
const TOAST_TEXT: Partial<Record<DashboardIntentType, string>> = {
	saveServerSetting: "Server saved",
	removeServerSetting: "Server removed",
	adoptServer: "Server adopted",
};

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
			<button type="button" class="quiet" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
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
 * diagnostics dialog (classifyOverall in the protocol module); this only maps
 * it to the hero's tone and word.
 */
function overallState(servers: readonly DashboardServer[]): Overall {
	switch (classifyOverall(servers)) {
		case "not-configured":
			return { tone: "muted", word: "Not configured" };
		case "error":
			return { tone: "error", word: "Error" };
		case "degraded":
			return { tone: "warn", word: "Degraded" };
		case "waiting":
			return { tone: "muted", word: "Waiting for first sync" };
		case "connected":
			return { tone: "ok", word: "Connected" };
	}
}

function lastSync(servers: readonly DashboardServer[], now: number): string | undefined {
	const times = servers
		.map((server) => (server.lastChecked === undefined ? Number.NaN : new Date(server.lastChecked).getTime()))
		.filter((time) => !Number.isNaN(time));
	if (times.length === 0) {
		return undefined;
	}
	return relativeTime(new Date(Math.max(...times)).toISOString(), now);
}

/** The at-a-glance strip the status bar click promises: overall state, counts, last sync, and Sync. */
function StatusHero({ state }: { state: DashboardState }) {
	const overall = overallState(state.servers);
	const synced = lastSync(state.servers, useNow());
	return (
		<div class="hero">
			<span class={`pill overall tone-${overall.tone}`}>
				<span class="dot" />
				{overall.word}
			</span>
			<span class="stat">
				<strong>{state.servers.length}</strong> {state.servers.length === 1 ? "server" : "servers"}
			</span>
			<span class="stat">
				<strong>{state.models.length}</strong> {state.models.length === 1 ? "model" : "models"}
			</span>
			{synced !== undefined ? <span class="stat">last sync {synced}</span> : null}
			<span class="spacer" />
			<button
				type="button"
				class="secondary"
				disabled={state.servers.length === 0}
				onClick={() => postMessage({ type: "executeCommand", command: "syncModels" })}
			>
				Sync models
			</button>
		</div>
	);
}

/** Grey stand-ins shaped like the page (title, hero strip, a table); no spinner, no motion. */
function LoadingSkeleton() {
	return (
		<main aria-label="Loading">
			<div class="skeleton" style={{ height: "20px", width: "220px", margin: "24px 0 4px" }} />
			<div class="skeleton" style={{ height: "13px", width: "420px", margin: "8px 0 16px" }} />
			<div class="skeleton" style={{ height: "38px", margin: "16px 0 32px" }} />
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
 * or a half-typed filter survives a visit to another section.
 */
function SectionTabs({
	active,
	counts,
	onSelect,
}: {
	active: SectionId;
	counts: Partial<Record<SectionId, number>>;
	onSelect: (section: SectionId) => void;
}) {
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
		<div class="tabs" role="tablist" aria-label="Dashboard sections" onKeyDown={onKeyDown}>
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
					{SECTION_LABELS[section]}
					{counts[section] !== undefined ? <span class="count">{counts[section]}</span> : null}
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
	const [section, setSection] = useState<SectionId>("servers");
	const [ack, setAck] = useState<IntentAck | undefined>(undefined);
	const [failures, setFailures] = useState<FailuresByIntent>({});
	const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
	const [inlineSecrets, setInlineSecrets] = useState<InlineSecretsResponse | undefined>(undefined);
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
				return;
			}
			if (message.type === "inlineSecrets") {
				setInlineSecrets(message);
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
				const base = TOAST_TEXT[message.intentType];
				if (base !== undefined) {
					const caveat = message.intentType !== "adoptServer" ? message.message : undefined;
					const text = caveat !== undefined ? `${base}. ${caveat}` : base;
					setToasts((current) => [...current, { id: seq, text }]);
				}
				return;
			}
			const failure: IntentFailure = {
				seq,
				message: message.message,
				kind: message.kind,
				requestId: message.requestId,
			};
			setFailures((current) => ({ ...current, [message.intentType]: failure }));
		};
		window.addEventListener("message", onMessage);
		postMessage({ type: "ready" });
		return () => window.removeEventListener("message", onMessage);
	}, []);

	if (state === undefined) {
		return <LoadingSkeleton />;
	}

	const dismissFailure = (intentType: DashboardIntentType) => {
		setFailures((current) => {
			const { [intentType]: _dropped, ...rest } = current;
			return rest;
		});
	};

	const scalarFailure =
		failures.setNumberSetting ?? failures.setBooleanSetting ?? failures.resetSetting ?? failures.executeCommand;
	return (
		<main>
			<h1>LiteLLM Dashboard</h1>
			<p class="hint">Servers, models, and settings in one place; edits land in your VS Code settings.</p>
			<StatusHero state={state} />
			{scalarFailure !== undefined ? <p class="error">The last change did not apply: {scalarFailure.message}</p> : null}
			<SectionTabs
				active={section}
				counts={{ servers: state.servers.length, models: state.models.length }}
				onSelect={setSection}
			/>
			<SectionPanel section="servers" active={section}>
				<ServersSection
					servers={state.servers}
					ack={ack}
					failures={failures}
					inlineSecrets={inlineSecrets}
					onDismissFailure={dismissFailure}
					onClearInlineSecrets={() => setInlineSecrets(undefined)}
				/>
			</SectionPanel>
			<SectionPanel section="models" active={section}>
				<ModelsSection models={state.models} serverCount={state.servers.length} />
			</SectionPanel>
			<SectionPanel section="settings" active={section}>
				<SettingsSection settings={state.settings} failures={failures} />
			</SectionPanel>
			<ToastHost toasts={toasts} durationMs={toastDurationMs} onDismiss={dismissToast} />
		</main>
	);
}
