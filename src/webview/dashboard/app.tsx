import { useEffect, useState } from "preact/hooks";
import type { DashboardState, ExtensionToWebviewMessage } from "../../extension/dashboard/protocol";
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
	return type === "state" || type === "intentFailed" ? (data as ExtensionToWebviewMessage) : undefined;
}

/** The latest reported intent failures, keyed by the failed intent's type. */
export type FailuresByIntent = Readonly<Record<string, IntentFailure>>;

/**
 * The dashboard root: holds the latest pushed state and the latest failure
 * notices, nothing else. The extension re-pushes the full state on every
 * store change, so this component never mutates or persists what it renders;
 * a state push also clears the failure notices, because a push means a write
 * landed (failed writes push no state).
 */
export function App() {
	const [state, setState] = useState<DashboardState | undefined>(undefined);
	const [failures, setFailures] = useState<FailuresByIntent>({});

	useEffect(() => {
		let failureSeq = 0;
		const onMessage = (event: MessageEvent) => {
			const message = asExtensionMessage(event.data);
			if (message === undefined) {
				return;
			}
			if (message.type === "state") {
				setState(message.state);
				setFailures({});
				return;
			}
			failureSeq += 1;
			const failure: IntentFailure = { seq: failureSeq, message: message.message };
			setFailures((current) => ({ ...current, [message.intentType]: failure }));
		};
		window.addEventListener("message", onMessage);
		postMessage({ type: "ready" });
		return () => window.removeEventListener("message", onMessage);
	}, []);

	if (state === undefined) {
		return <p class="empty">Loading the LiteLLM dashboard...</p>;
	}

	const scalarFailure = failures.setNumberSetting ?? failures.setBooleanSetting ?? failures.executeCommand;
	return (
		<main>
			<h1>LiteLLM Dashboard</h1>
			<p class="hint">
				A live view over your servers, models, and settings. Edits here change the same settings the native Settings
				editor shows.
			</p>
			{scalarFailure !== undefined ? <p class="error">The last change was not saved: {scalarFailure.message}</p> : null}
			<ServersSection servers={state.servers} />
			<ModelsSection models={state.models} serverCount={state.servers.length} />
			<SettingsSection settings={state.settings} failures={failures} />
		</main>
	);
}
