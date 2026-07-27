import { useEffect, useState } from "preact/hooks";
import type { DashboardServer, DashboardState, ExtensionToWebviewMessage } from "../../extension/dashboard/protocol";
import { classifyOverall, failuresAfterStatePush } from "../../extension/dashboard/protocol";
import { ModelsSection } from "./models";
import type { IntentFailure } from "./recordEditors";
import { ServersSection } from "./servers";
import { SettingsSection } from "./settings";
import { postMessage } from "./vscodeApi";

/**
 * Messages arriving on the window come from the extension only (the CSP
 * allows no other frames), so a shape check on the discriminant suffices.
 */
function asExtensionMessage(data: unknown): ExtensionToWebviewMessage | undefined {
	if (typeof data !== "object" || data === null) {
		return undefined;
	}
	const type = (data as { type?: unknown }).type;
	return type === "state" || type === "intentFailed" || type === "intentSucceeded"
		? (data as ExtensionToWebviewMessage)
		: undefined;
}

/** The latest reported intent failures, keyed by the failed intent's type. */
export type FailuresByIntent = Readonly<Record<string, IntentFailure>>;

/** The latest intentSucceeded notice; editors match it against their own requestId. */
export interface IntentAck {
	readonly seq: number;
	readonly requestId: string;
	/** The extension's optional caveat about the success (see intentSucceeded). */
	readonly message?: string | undefined;
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

function lastSync(servers: readonly DashboardServer[]): string | undefined {
	const times = servers
		.map((server) => (server.lastChecked === undefined ? Number.NaN : new Date(server.lastChecked).getTime()))
		.filter((time) => !Number.isNaN(time));
	if (times.length === 0) {
		return undefined;
	}
	return new Date(Math.max(...times)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The at-a-glance strip the status bar click promises: overall state, counts, last sync, and Sync. */
function StatusHero({ state }: { state: DashboardState }) {
	const overall = overallState(state.servers);
	const synced = lastSync(state.servers);
	return (
		<div class="hero">
			<span class={`overall tone-${overall.tone}`}>
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
export function App() {
	const [state, setState] = useState<DashboardState | undefined>(undefined);
	const [ack, setAck] = useState<IntentAck | undefined>(undefined);
	const [failures, setFailures] = useState<FailuresByIntent>({});

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

	const dismissFailure = (intentType: string) => {
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
			<ServersSection servers={state.servers} ack={ack} failures={failures} onDismissFailure={dismissFailure} />
			<ModelsSection models={state.models} serverCount={state.servers.length} />
			<SettingsSection settings={state.settings} failures={failures} />
		</main>
	);
}
