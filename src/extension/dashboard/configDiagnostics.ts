/**
 * Free text stays structural (setting ids, record keys, header names) - never entered values - because the entry
 * problems also ride the copyable diagnostics block.
 */

import type { ConfigDiagnosticView, HiddenGroup } from "../../dashboard/viewModels";
import { NUMBER_SETTING_IDS } from "../../dashboard/viewModels";
import type { CredentialRejection } from "../../provider/catalog/groupModels";
import type { ModelCapabilitiesRecord } from "../../shared/config/capabilityResolution";
import { filterUnrecognizedKeyDiagnostics, lintCapabilityRecords } from "../../shared/config/capabilityResolution";
import { lintParameterRecords } from "../../shared/config/parameterResolution";
import type { RecordDiagnostic } from "../../shared/config/recordResolution";
import { acceptsNumberSetting } from "../../shared/config/settingSpec";
import type { RecordShapeReport } from "../../shared/config/settings";
import {
	normalizeModelCapabilities,
	normalizeModelParameters,
	normalizeUsageAlertThresholds,
	USAGE_ALERT_THRESHOLDS_SETTING_KEY,
} from "../../shared/config/settings";
import { presentCarriers } from "../../shared/serverEntry";
import { collectLegacyHints } from "../migrations/settingsRedesign/hints";
import {
	LEGACY_HEADERS_ID,
	NEW_MODEL_CAPABILITIES_ID,
	NEW_MODEL_PARAMETERS_ID,
} from "../migrations/settingsRedesign/legacyIds";
import type { DeclaredServerView, ServerEntryReport } from "../servers/serverSync";
import type { SettingsReader } from "./state";
import { rejectsWithOwnRow } from "./state";

/** The field under `auth` (or `auth.oauth`) a dropped credential lives in, as the servers setting spells it. */
const CREDENTIAL_PATHS: Record<CredentialRejection["field"], string> = {
	apiKey: "apiKey",
	virtualKeyValue: "virtualKey.value",
};

export interface ConfigDiagnosticsInput {
	readonly reader: SettingsReader;
	/** The per-entry acceptance reports (serverSettingReports over the raw setting). */
	readonly entryReports: readonly ServerEntryReport[];
	readonly declared: readonly Pick<
		DeclaredServerView,
		"label" | "modelParameters" | "modelCapabilities" | "rejectedCredentials" | "oauthTokenUrl" | "oauthClientId"
	>[];
	/**
	 * The groups the user's configuration hides (removed, or superseded), as the state builder renders them
	 * (visibleHiddenGroups).
	 */
	readonly hiddenGroups: readonly HiddenGroup[];
	/**
	 * Each entry's observed /model/info key set, by entry label: the evidence the entry-layer advisory hints filter
	 * against. Server-derived strings: never logged, membership through the Map only.
	 *
	 * An absent entry has no set -> its unrecognized-key hints drop (no false hints on declared-only entries, expected
	 *   modelInfo failures, the /models fallback, or pre-discovery)
	 */
	readonly observedKeysByEntry?: ReadonlyMap<string, readonly string[]> | undefined;
	/**
	 * The observed-key union across servers that reported a set: the global records' evidence - a global record applies
	 * to every server, so a key any server observed is real. Undefined when no server reported a set; then every global
	 * hint drops.
	 *
	 * Known residual: with mixed evidence, a key only an evidence-less server knows still hints -> the hint stays
	 *   advisory-severity
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
		// A surviving unrecognized-key is advisory by construction: the filter already dropped everything without
		// evidence. Every other kind warns.
		severity: diagnostic.kind === "unrecognized-key" ? ("advisory" as const) : ("warning" as const),
	}));
}

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

	// The records normalizer is the one classifier of a map's shape; its refusals land here so a "oops" map or a
	// "gpt-4": "oops" entry does not read as "no overrides" with nothing saying why.
	const shapeReport =
		(setting: "models.parameters" | "models.capabilities"): RecordShapeReport =>
		(problem) => {
			diagnostics.push({
				kind: "setting-shape",
				setting,
				...(problem.kind === "map"
					? {}
					: { key: problem.key, reason: problem.kind === "entry" ? "not-object" : "reserved-name" }),
				severity: "warning",
			});
		};
	const globalParameters = normalizeModelParameters(modelParametersValue, shapeReport("models.parameters"));
	const globalCapabilities = normalizeModelCapabilities(modelCapabilitiesValue, shapeReport("models.capabilities"));

	// The two global records, linted record-level so keys no model matches still report.
	diagnostics.push(
		...recordDiagnostics("models.parameters", undefined, lintParameterRecords(globalParameters)),
		...recordDiagnostics("models.capabilities", undefined, capabilityLint(globalCapabilities, input.observedKeysUnion))
	);

	for (const view of input.declared) {
		for (const field of view.rejectedCredentials ?? []) {
			// The key and the virtual key ride inside auth.oauth when the entry declares OAuth (parseAuth flattens the
			// companion), so the path points where the user wrote it.
			const inOAuth = presentCarriers("oauthClientSecret", view) !== undefined;
			diagnostics.push({
				kind: "credential",
				label: view.label,
				path: `auth.${inOAuth ? "oauth." : ""}${CREDENTIAL_PATHS[field]}`,
				severity: "warning",
			});
		}
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

	// Each carries whether a server row was drawn for it, read from the same rejectsWithOwnRow rule buildServers draws
	// by, so the Diagnostics destination can drop exactly the problems a row already states. Keyed by the report's own
	// index, never by object identity: the rule returns narrowed copies, and a Set of those would match nothing here.
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

	// Hidden groups (removed, or superseded) serve no models; the Diagnostics tab must say so (a hidden-only setup
	// otherwise reads as a healthy configuration with zero models and no visible cause).
	if (input.hiddenGroups.length > 0) {
		diagnostics.push({
			kind: "hidden-groups",
			labels: input.hiddenGroups.map((group) => group.label),
			severity: "warning",
		});
	}

	// Out-of-range usage.alertThresholds values are dropped, not clamped, and the drop is a diagnostic rather than
	// silent.
	const rawThresholds = input.reader.get(USAGE_ALERT_THRESHOLDS_SETTING_KEY);
	if (Array.isArray(rawThresholds)) {
		const kept = normalizeUsageAlertThresholds(rawThresholds).length;
		const distinct = new Set(rawThresholds.map((value) => JSON.stringify(value))).size;
		const dropped = distinct - kept;
		if (dropped > 0) {
			diagnostics.push({ kind: "thresholds", dropped, severity: "warning" });
		}
	}

	// A number setting outside its contract reads as the default (settings.ts judges by the same rule), and the user
	// learns it here by key and bound: a chat.timeout of 2147483648 would otherwise become five minutes in silence.
	for (const setting of NUMBER_SETTING_IDS) {
		const raw = input.reader.get(setting);
		if (raw !== undefined && !acceptsNumberSetting(setting, raw)) {
			diagnostics.push({ kind: "number-setting", setting, severity: "warning" });
		}
	}

	return diagnostics;
}
