/**
 * The Configuration diagnostics builder: every settings problem the extension
 * can spot, reduced to the serializable ConfigDiagnosticView list the
 * Diagnostics tab renders. Pure over its inputs. Free text stays structural
 * (setting ids, record keys, header names) - never entered values - because
 * the entry problems also ride the copyable diagnostics block.
 */

import type { ConfigDiagnosticView, HiddenGroup } from "../../dashboard/viewModels";
import type { ModelCapabilitiesRecord } from "../../shared/config/capabilityResolution";
import { filterUnrecognizedKeyDiagnostics, lintCapabilityRecords } from "../../shared/config/capabilityResolution";
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
import type { SettingsReader } from "./state";
import { rejectsWithOwnRow } from "./state";

export interface ConfigDiagnosticsInput {
	/** The litellm-vscode-chat configuration section; the builder reads the record settings and leftovers itself. */
	readonly reader: SettingsReader;
	/** The per-entry acceptance reports (serverSettingReports over the raw setting). */
	readonly entryReports: readonly ServerEntryReport[];
	/** The declared entries' own records, for the entry-layer record lints. */
	readonly declared: readonly Pick<DeclaredServerView, "label" | "modelParameters" | "modelCapabilities">[];
	/** The groups hidden by an explicit removal, as the state builder renders them (visibleHiddenGroups). */
	readonly hiddenGroups: readonly HiddenGroup[];
	/**
	 * Each entry's observed /model/info key set, by entry label: the evidence
	 * the entry-layer advisory hints filter against. An absent entry has no
	 * set, so its unrecognized-key hints drop (no false hints on declared-only
	 * entries, expected modelInfo failures, the /models fallback, or
	 * pre-discovery). Server-derived strings: never logged, membership through
	 * the Map only.
	 */
	readonly observedKeysByEntry?: ReadonlyMap<string, readonly string[]> | undefined;
	/**
	 * The observed-key union across servers that reported a set: the global
	 * records' evidence - a global record applies to every server, so a key any
	 * server observed is real. Undefined when no server reported a set; then
	 * every global hint drops. Known residual: with mixed evidence, a key only
	 * an evidence-less server knows still hints, which is why the hint stays
	 * advisory-severity.
	 */
	readonly observedKeysUnion?: readonly string[] | undefined;
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
		// A surviving unrecognized-key is advisory by construction: the filter
		// already dropped everything without evidence. Every other kind warns.
		severity: diagnostic.kind === "unrecognized-key" ? ("advisory" as const) : ("warning" as const),
	}));
}

/** The capabilities-record lint with the advisory filter applied; see filterUnrecognizedKeyDiagnostics. */
function capabilityLint(
	records: ModelCapabilitiesRecord,
	observedKeys: readonly string[] | undefined
): readonly RecordDiagnostic[] {
	return filterUnrecognizedKeyDiagnostics(lintCapabilityRecords(records), observedKeys);
}

export function buildConfigDiagnostics(input: ConfigDiagnosticsInput): ConfigDiagnosticView[] {
	const diagnostics: ConfigDiagnosticView[] = [];
	const modelParametersValue = input.reader.get(NEW_MODEL_PARAMETERS_ID);
	const modelCapabilitiesValue = input.reader.get(NEW_MODEL_CAPABILITIES_ID);

	// The two global records, linted record-level so keys no model matches
	// still report. Capability unrecognized-key hints filter against the
	// cross-server observed union: a global record applies everywhere.
	diagnostics.push(
		...recordDiagnostics(
			"models.parameters",
			undefined,
			lintParameterRecords(normalizeModelParameters(modelParametersValue))
		),
		...recordDiagnostics(
			"models.capabilities",
			undefined,
			capabilityLint(normalizeModelCapabilities(modelCapabilitiesValue), input.observedKeysUnion)
		)
	);

	// Every entry's own records, attributed to the entry; the entry's
	// capability hints filter against its own server's observed set.
	for (const view of input.declared) {
		if (view.modelParameters !== undefined) {
			diagnostics.push(
				...recordDiagnostics("models.parameters", view.label, lintParameterRecords(view.modelParameters))
			);
		}
		if (view.modelCapabilities !== undefined) {
			diagnostics.push(
				...recordDiagnostics(
					"models.capabilities",
					view.label,
					capabilityLint(view.modelCapabilities, input.observedKeysByEntry?.get(view.label))
				)
			);
		}
	}

	// The servers-setting parser's per-entry reports. Each carries whether a
	// server row was drawn for it, read from the same rejectsWithOwnRow rule
	// buildServers draws by, so the Diagnostics destination can drop exactly
	// the problems a row already states.
	// Keyed by the report's own index, never by object identity: the rule
	// returns narrowed copies, and a Set of those would match nothing here.
	const drawnRows = new Set(rejectsWithOwnRow(input.entryReports, input.declared).map((report) => report.index));
	for (const report of input.entryReports) {
		if (report.problems.length > 0) {
			diagnostics.push({
				kind: "entry",
				...(report.label !== undefined ? { label: report.label } : {}),
				position: report.index + 1,
				problems: report.problems,
				misconfigured: !report.accepted,
				rowOwned: drawnRows.has(report.index),
				severity: "warning",
			});
		}
	}

	// Legacy leftovers the redesign migration deliberately left in place.
	for (const hint of collectLegacyHints({
		globalHeadersValue: input.reader.get(LEGACY_HEADERS_ID),
		modelParametersValue,
		modelCapabilitiesValue,
	})) {
		diagnostics.push({
			kind: "legacy",
			hint: hint.kind,
			oldKey: hint.oldKey,
			detail: hint.detail,
			severity: "warning",
		});
	}

	// Groups hidden by an explicit removal serve no models; the Diagnostics
	// tab must say so (a hidden-only setup otherwise reads as a healthy
	// configuration with zero models and no visible cause).
	if (input.hiddenGroups.length > 0) {
		diagnostics.push({
			kind: "hidden-groups",
			labels: input.hiddenGroups.map((group) => group.label),
			severity: "warning",
		});
	}

	// Out-of-range usage.alertThresholds values are dropped, not clamped, and
	// the drop is a diagnostic rather than silent.
	const rawThresholds = input.reader.get(USAGE_ALERT_THRESHOLDS_SETTING_KEY);
	if (Array.isArray(rawThresholds)) {
		const kept = normalizeUsageAlertThresholds(rawThresholds).length;
		const distinct = new Set(rawThresholds.map((value) => JSON.stringify(value))).size;
		const dropped = distinct - kept;
		if (dropped > 0) {
			diagnostics.push({ kind: "thresholds", dropped, severity: "warning" });
		}
	}

	return diagnostics;
}
