import * as l10n from "@vscode/l10n";
import type { SettingRowId, SettingScope } from "../../dashboard/viewModels";
import type { SessionFingerprintStrategy, SessionFingerprintValue } from "../../shared/config/settingSpec";
import { SESSION_FINGERPRINT_STRATEGIES } from "../../shared/config/settingSpec";
import { helpSessionFingerprintStrategy } from "./helpText";
import { EnumSettingRow } from "./settingRows";

/**
 * The session fingerprint rows: the knob that says what a request's LiteLLM session id is derived from, and the chat's
 * companion toggle for how a chat's own fingerprint is derived.
 *
 *   One component for the eight rows: the six feature knobs and the chat knob differ only in the values they accept and
 *     in what the "?" explains, so a row that is a call site and a label function keeps them from drifting apart.
 */

/** The row's title; the group heading already says which surface the row belongs to. */
export function sessionFingerprintTitle(): string {
	return l10n.t("Session fingerprint");
}

/** The row's one-liner: what the knob chooses. */
export function sessionFingerprintDescription(): string {
	return l10n.t("Which requests LiteLLM groups as one session.");
}

/** The strategy toggle's title and description. */
export function sessionFingerprintStrategyTitle(): string {
	return l10n.t("Fingerprint strategy");
}

export function sessionFingerprintStrategyDescription(): string {
	return l10n.t("How a chat fingerprint is generated.");
}

/** The values, as the row shows them: what the requests are grouped by. */
function sessionFingerprintValueLabel(value: SessionFingerprintValue): string {
	switch (value) {
		case "off":
			return l10n.t({
				message: "Off",
				comment: ["The session fingerprint's off value: no session id rides the request"],
			});
		case "conversation":
			return l10n.t("Per chat");
		case "workspace":
			return l10n.t("Per workspace");
		case "window":
			return l10n.t("Per window");
	}
}

/** The strategies, as the row shows them: how a chat's own fingerprint is derived. */
function sessionFingerprintStrategyLabel(strategy: SessionFingerprintStrategy): string {
	switch (strategy) {
		case "durable":
			return l10n.t("Single fingerprint per chat");
		case "collecting":
			return l10n.t("Refine once identifiable");
	}
}

/**
 * The fingerprint row, in one of its two shapes: the chat knob, which can point at one conversation, and a feature
 * knob, which cannot. The value type follows the options the caller passes, so the write it fires carries exactly the
 * words that knob accepts.
 */
export function SessionFingerprintSettingRow<T extends SessionFingerprintValue>({
	settingId,
	value,
	options,
	help,
	onPick,
	configuredScope,
	hidden,
}: {
	settingId: SettingRowId;
	value: T;
	options: readonly T[];
	help: string;
	onPick: (value: T) => void;
	configuredScope: SettingScope | null;
	hidden: boolean;
}) {
	return (
		<EnumSettingRow
			settingId={settingId}
			title={sessionFingerprintTitle()}
			description={sessionFingerprintDescription()}
			help={help}
			value={value}
			options={options}
			optionLabel={sessionFingerprintValueLabel}
			onPick={onPick}
			configuredScope={configuredScope}
			hidden={hidden}
		/>
	);
}

/** The chat's strategy toggle: a vocabulary of its own, so it is a row of its own and not a fingerprint value. */
export function SessionFingerprintStrategyRow({
	value,
	configuredScope,
	hidden,
	onPick,
}: {
	value: SessionFingerprintStrategy;
	configuredScope: SettingScope | null;
	hidden: boolean;
	onPick: (value: SessionFingerprintStrategy) => void;
}) {
	return (
		<EnumSettingRow
			settingId="chat.sessionFingerprintStrategy"
			title={sessionFingerprintStrategyTitle()}
			description={sessionFingerprintStrategyDescription()}
			help={helpSessionFingerprintStrategy()}
			value={value}
			options={SESSION_FINGERPRINT_STRATEGIES}
			optionLabel={sessionFingerprintStrategyLabel}
			onPick={onPick}
			configuredScope={configuredScope}
			hidden={hidden}
		/>
	);
}
