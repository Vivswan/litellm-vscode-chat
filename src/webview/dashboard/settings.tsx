import { useEffect, useState } from "preact/hooks";
import type { BooleanSettingId, DashboardSettings, NumberSettingId } from "../../extension/dashboard/protocol";
import {
	BOOLEAN_SETTING_IDS,
	BOOLEAN_SETTINGS,
	NUMBER_SETTING_IDS,
	NUMBER_SETTINGS,
} from "../../extension/dashboard/protocol";
import type { FailuresByIntent } from "./app";
import { HeadersEditor, ModelParametersEditor } from "./recordEditors";
import { postMessage } from "./vscodeApi";

/**
 * A number setting edited as draft text and committed on blur or Enter, so
 * half-typed values never reach the configuration. An external state push
 * resets the draft to the store's value.
 */
function NumberField({ id, value }: { id: NumberSettingId; value: number | null }) {
	const spec = NUMBER_SETTINGS[id];
	const [text, setText] = useState(value === null ? "" : String(value));
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		setText(value === null ? "" : String(value));
		setError(undefined);
	}, [value]);

	const commit = () => {
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			if (!spec.nullable) {
				setError("Enter a number");
				return;
			}
			setError(undefined);
			if (value !== null) {
				postMessage({ type: "setNumberSetting", setting: id, value: null });
			}
			return;
		}
		const parsed = Number(trimmed);
		if (!Number.isFinite(parsed)) {
			setError("Not a number");
			return;
		}
		if (parsed < spec.minimum) {
			setError(`Must be at least ${spec.minimum}`);
			return;
		}
		setError(undefined);
		if (parsed !== value) {
			postMessage({ type: "setNumberSetting", setting: id, value: parsed });
		}
	};

	const inputId = `setting-${id}`;
	return (
		<div class="field">
			<label for={inputId}>{spec.label}</label>
			<input
				id={inputId}
				type="number"
				min={spec.minimum}
				class={error === undefined ? "" : "invalid"}
				value={text}
				onInput={(event) => setText(event.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						commit();
					}
				}}
			/>
			{error === undefined ? <span class="hint">{spec.description}</span> : <span class="error">{error}</span>}
		</div>
	);
}

function BooleanField({ id, value }: { id: BooleanSettingId; value: boolean }) {
	const spec = BOOLEAN_SETTINGS[id];
	const inputId = `setting-${id}`;
	return (
		<div class="field">
			<label for={inputId}>{spec.label}</label>
			<input
				id={inputId}
				type="checkbox"
				checked={value}
				onChange={(event) =>
					postMessage({ type: "setBooleanSetting", setting: id, value: event.currentTarget.checked })
				}
			/>
			<span class="hint">{spec.description}</span>
		</div>
	);
}

export function SettingsSection({ settings, failures }: { settings: DashboardSettings; failures: FailuresByIntent }) {
	return (
		<section>
			<h2>Settings</h2>
			<div class="toolbar">
				<button
					type="button"
					class="secondary"
					onClick={() => postMessage({ type: "executeCommand", command: "openSettings" })}
				>
					Open in Settings editor
				</button>
			</div>
			{NUMBER_SETTING_IDS.map((id) => (
				<NumberField key={id} id={id} value={settings.numbers[id]} />
			))}
			{BOOLEAN_SETTING_IDS.map((id) => (
				<BooleanField key={id} id={id} value={settings.booleans[id]} />
			))}
			<ModelParametersEditor scoped={settings.modelParameters} failure={failures.setModelParameters} />
			<HeadersEditor scoped={settings.headers} failure={failures.setHeaders} />
		</section>
	);
}
