/**
 * The Configuration diagnostics builder: every settings problem the extension
 * can spot, reduced to the serializable ConfigDiagnosticView list the
 * Diagnostics tab renders (each also rendered beside the row or editor it
 * concerns). Pure over its inputs; panel.ts supplies the live configuration
 * reader and globalState values. Free text stays structural (setting ids,
 * record keys, header names) - never entered values - because the entry
 * problems also ride the copyable diagnostics block.
 */

import { lintCapabilityRecords } from "../../shared/config/capabilityResolution";
import { lintParameterRecords } from "../../shared/config/parameterResolution";
import type { RecordDiagnostic } from "../../shared/config/recordResolution";
import {
	normalizeModelCapabilities,
	normalizeModelParameters,
	normalizeUsageAlertThresholds,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
} from "../../shared/config/settings";
import { collectLegacyHints } from "../migrations/settingsRedesign/hints";
import {
	LEGACY_HEADERS_ID,
	NEW_MODEL_CAPABILITIES_ID,
	NEW_MODEL_PARAMETERS_ID,
} from "../migrations/settingsRedesign/legacyIds";
import type { DeclaredServerView, ServerEntryReport } from "../servers/serverSync";
import type { ConfigDiagnosticView, HiddenGroup } from "./protocol";
import type { SettingsReader } from "./state";

export interface ConfigDiagnosticsInput {
	/** The litellm-vscode-chat configuration section; the builder reads the record settings and leftovers itself. */
	readonly reader: SettingsReader;
	/** The PARKED_GLOBAL_HEADERS_KEY globalState value, when present. */
	readonly parkedGlobalHeadersValue: unknown;
	/** Whether any externally managed provider group exists right now; gates the parked-headers hint. */
	readonly hasExternalGroups: boolean;
	/** The per-entry acceptance reports (serverSettingReports over the raw setting). */
	readonly entryReports: readonly ServerEntryReport[];
	/** The declared entries' own records, for the entry-layer record lints. */
	readonly declared: readonly Pick<DeclaredServerView, "label" | "modelParameters" | "modelCapabilities">[];
	/** The groups hidden by an explicit removal, as the state builder renders them (visibleHiddenGroups). */
	readonly hiddenGroups: readonly HiddenGroup[];
}

function recordDiagnostics(
	setting: "models.parameters" | "models.capabilities",
	entryLabel: string | undefined,
	diagnostics: readonly RecordDiagnostic[]
): ConfigDiagnosticView[] {
	return diagnostics.map((diagnostic) => ({
		kind: "record" as const,
		setting,
		...(entryLabel !== undefined ? { entryLabel } : {}),
		diagnostic,
	}));
}

export function buildConfigDiagnostics(input: ConfigDiagnosticsInput): ConfigDiagnosticView[] {
	const diagnostics: ConfigDiagnosticView[] = [];
	const modelParametersValue = input.reader.get(NEW_MODEL_PARAMETERS_ID);
	const modelCapabilitiesValue = input.reader.get(NEW_MODEL_CAPABILITIES_ID);

	// The two global records, linted record-level so keys no model matches
	// still report (invalid matchers, unforceable names, unknown
	// _inherit_from keys).
	diagnostics.push(
		...recordDiagnostics(
			"models.parameters",
			undefined,
			lintParameterRecords(normalizeModelParameters(modelParametersValue))
		),
		...recordDiagnostics(
			"models.capabilities",
			undefined,
			lintCapabilityRecords(normalizeModelCapabilities(modelCapabilitiesValue))
		)
	);

	// Every entry's own records, attributed to the entry.
	for (const view of input.declared) {
		if (view.modelParameters !== undefined) {
			diagnostics.push(
				...recordDiagnostics("models.parameters", view.label, lintParameterRecords(view.modelParameters))
			);
		}
		if (view.modelCapabilities !== undefined) {
			diagnostics.push(
				...recordDiagnostics("models.capabilities", view.label, lintCapabilityRecords(view.modelCapabilities))
			);
		}
	}

	// The servers-setting parser's per-entry reports: misconfigured entries
	// (skipped whole) and accepted entries with ignored pieces alike.
	for (const report of input.entryReports) {
		if (report.problems.length > 0) {
			diagnostics.push({
				kind: "entry",
				...(report.label !== undefined ? { label: report.label } : {}),
				position: report.index + 1,
				problems: report.problems,
				misconfigured: !report.accepted,
			});
		}
	}

	// Legacy leftovers the redesign migration deliberately left in place. The
	// parked-headers hint renders only while externally managed groups exist:
	// it exists to say those groups no longer receive the removed global
	// headers, and adopting restores them (R3 ruling).
	for (const hint of collectLegacyHints({
		globalHeadersValue: input.reader.get(LEGACY_HEADERS_ID),
		modelParametersValue,
		modelCapabilitiesValue,
		parkedGlobalHeadersValue: input.parkedGlobalHeadersValue,
	})) {
		if (hint.kind === "parked-global-headers" && !input.hasExternalGroups) {
			continue;
		}
		diagnostics.push({ kind: "legacy", hint: hint.kind, oldKey: hint.oldKey, detail: hint.detail });
	}

	// Groups hidden by an explicit removal serve no models; the Diagnostics
	// tab must say so (a hidden-only setup otherwise reads as a healthy
	// configuration with zero models and no visible cause). Labels are the
	// same ones the hidden-groups line renders.
	if (input.hiddenGroups.length > 0) {
		diagnostics.push({ kind: "hidden-groups", labels: input.hiddenGroups.map((group) => group.label) });
	}

	// Out-of-range usage.alertThresholds values are dropped, not clamped
	// (Q3 ruling); the drop is a diagnostic, never silent.
	const rawThresholds = input.reader.get(USAGE_ALERT_THRESHOLDS_SETTING_KEY);
	if (Array.isArray(rawThresholds)) {
		const kept = normalizeUsageAlertThresholds(rawThresholds).length;
		const distinct = new Set(rawThresholds.map((value) => JSON.stringify(value))).size;
		const dropped = distinct - kept;
		if (dropped > 0) {
			diagnostics.push({ kind: "thresholds", dropped });
		}
	}

	return diagnostics;
}
