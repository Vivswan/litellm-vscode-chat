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
import type { DeclaredServerView } from "../servers/serverSync/engine";
import { rejectsWithOwnRow } from "../servers/serverSync/rejects";
import type { ServerEntryReport } from "../servers/serverSync/setting";
import type { SettingsReader } from "./state";

/** The field under `auth` (or `auth.oauth`) a dropped credential lives in, as the servers setting spells it. */
const CREDENTIAL_PATHS: Record<CredentialRejection["field"], string> = {
	apiKey: "apiKey",
	virtualKeyValue: "virtualKey.value",
};

/**
 * The observed-key sets are server-derived strings: never logged, membership through the Map only. An entry with no set
 * has no evidence, so its unrecognized-key hints drop, and declared-only entries, expected modelInfo failures, the
 * /models fallback, and pre-discovery raise no false hints.
 *
 * A global record applies to every server, so a key any server observed is real evidence for it. An undefined union
 * drops every global hint. Known residual: with mixed evidence, a key only an evidence-less server knows still hints,
 * so the hint stays advisory-severity.
 */
export interface ConfigDiagnosticsInput {
	/** Reads the global records, the legacy headers key, and the usage settings the global rows judge. */
	readonly reader: SettingsReader;

	/** The per-entry acceptance reports (serverSettingReports over the raw setting). */
	readonly entryReports: readonly ServerEntryReport[];

	/** The accepted entries' records and auth fields the per-entry rows judge. */
	readonly declared: readonly Pick<
		DeclaredServerView,
		"label" | "modelParameters" | "modelCapabilities" | "rejectedCredentials" | "oauthTokenUrl" | "oauthClientId"
	>[];

	/** The hidden groups as the state builder renders them (visibleHiddenGroups): removed, or superseded. */
	readonly hiddenGroups: readonly HiddenGroup[];

	/** Each entry's observed /model/info key set, by entry label: what the entry-layer advisory hints filter against. */
	readonly observedKeysByEntry?: ReadonlyMap<string, readonly string[]> | undefined;

	/** The observed-key union over the servers that reported one: the global rows' evidence; undefined when none did. */
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
		...(entryLabel === undefined ? {} : { entryLabel }),
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

/** A shape reporter that appends one setting-shape diagnostic per refusal the records normalizer raises. */
function shapeReporter(
	setting: "models.parameters" | "models.capabilities",
	diagnostics: ConfigDiagnosticView[]
): RecordShapeReport {
	return (problem) => {
		diagnostics.push({
			kind: "setting-shape",
			setting,
			...(problem.kind === "map"
				? {}
				: { key: problem.key, reason: problem.kind === "entry" ? "not-object" : "reserved-name" }),
			severity: "warning",
		});
	};
}

/** One accepted entry's diagnostics: its dropped credentials, then its own two records linted record-level. */
function entryDiagnostics(
	view: ConfigDiagnosticsInput["declared"][number],
	observedKeys: readonly string[] | undefined
): ConfigDiagnosticView[] {
	const diagnostics: ConfigDiagnosticView[] = [];
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
		diagnostics.push(...recordDiagnostics("models.parameters", view.label, lintParameterRecords(view.modelParameters)));
	}
	if (view.modelCapabilities !== undefined) {
		diagnostics.push(
			...recordDiagnostics("models.capabilities", view.label, capabilityLint(view.modelCapabilities, observedKeys))
		);
	}

	return diagnostics;
}

/**
 * One diagnostic per entry report with problems. Each carries whether a server row was drawn for it, read from the
 * same rejectsWithOwnRow rule buildServers draws by, so the Diagnostics destination can drop exactly the problems a row
 * already states. Keyed by the report's own index, never by object identity: the rule returns narrowed copies, and a
 * Set of those would match nothing here.
 */
function entryReportDiagnostics(input: ConfigDiagnosticsInput): ConfigDiagnosticView[] {
	const drawnRows = new Set(rejectsWithOwnRow(input.entryReports, input.declared).map((report) => report.index));
	return input.entryReports
		.filter((report) => report.problems.length > 0)
		.map((report) => ({
			kind: "entry",
			...(report.label === undefined ? {} : { label: report.label }),
			position: report.index + 1,
			problems: report.problems,
			misconfigured: !report.accepted,
			rowOwned: drawnRows.has(report.index),
			severity: "warning",
		}));
}

/**
 * The usage.alertThresholds drop count as a diagnostic: out-of-range values are dropped, not clamped, and the drop is
 * reported rather than silent.
 */
function thresholdDiagnostics(reader: SettingsReader): ConfigDiagnosticView[] {
	const rawThresholds = reader.get(USAGE_ALERT_THRESHOLDS_SETTING_KEY);
	if (!Array.isArray(rawThresholds)) {
		return [];
	}
	const kept = normalizeUsageAlertThresholds(rawThresholds).length;
	const distinct = new Set(rawThresholds.map((value) => JSON.stringify(value))).size;
	const dropped = distinct - kept;
	return dropped > 0 ? [{ kind: "thresholds", dropped, severity: "warning" }] : [];
}

/**
 * One diagnostic per number setting outside its contract: such a value reads as the default (settings.ts judges by
 * the same rule), and the user learns it here by key and bound. A chat.timeout of 2147483648 would otherwise become
 * five minutes in silence.
 */
function numberSettingDiagnostics(reader: SettingsReader): ConfigDiagnosticView[] {
	return NUMBER_SETTING_IDS.flatMap((setting) => {
		const raw = reader.get(setting);
		if (raw !== undefined && !acceptsNumberSetting(setting, raw)) {
			return [{ kind: "number-setting", setting, severity: "warning" }];
		}
		return [];
	});
}

/**
 * Every configuration diagnostic, in display order: the two global records' shape and lint, each entry's, the entry
 * reports, the legacy hints, the hidden groups, the thresholds, and the number settings. The records normalizer is the
 * one classifier of a map's shape; its refusals land first so a "oops" map or a "gpt-4": "oops" entry does not read as
 * "no overrides" with nothing saying why.
 */
export function buildConfigDiagnostics(input: ConfigDiagnosticsInput): ConfigDiagnosticView[] {
	const modelParametersValue = input.reader.get(NEW_MODEL_PARAMETERS_ID);
	const modelCapabilitiesValue = input.reader.get(NEW_MODEL_CAPABILITIES_ID);
	const shape: ConfigDiagnosticView[] = [];
	const globalParameters = normalizeModelParameters(modelParametersValue, shapeReporter("models.parameters", shape));
	const globalCapabilities = normalizeModelCapabilities(
		modelCapabilitiesValue,
		shapeReporter("models.capabilities", shape)
	);
	const legacy = collectLegacyHints({
		globalHeadersValue: input.reader.get(LEGACY_HEADERS_ID),
		modelParametersValue,
		modelCapabilitiesValue,
	}).map(
		(hint): ConfigDiagnosticView => ({
			kind: "legacy",
			hint: hint.kind,
			oldKey: hint.oldKey,
			detail: hint.detail,
			severity: "warning",
		})
	);
	// Hidden groups (removed, or superseded) serve no models; the Diagnostics tab must say so (a hidden-only setup
	// otherwise reads as a healthy configuration with zero models and no visible cause).
	const hidden: ConfigDiagnosticView[] =
		input.hiddenGroups.length > 0
			? [{ kind: "hidden-groups", labels: input.hiddenGroups.map((group) => group.label), severity: "warning" }]
			: [];

	return [
		...shape,
		// The two global records, linted record-level so keys no model matches still report.
		...recordDiagnostics("models.parameters", undefined, lintParameterRecords(globalParameters)),
		...recordDiagnostics("models.capabilities", undefined, capabilityLint(globalCapabilities, input.observedKeysUnion)),
		...input.declared.flatMap((view) => entryDiagnostics(view, input.observedKeysByEntry?.get(view.label))),
		...entryReportDiagnostics(input),
		...legacy,
		...hidden,
		...thresholdDiagnostics(input.reader),
		...numberSettingDiagnostics(input.reader),
	];
}
