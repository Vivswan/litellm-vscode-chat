/**
 * Dumb data on purpose - the dashboard (not this module) decides presentation and localization.
 *
 *   each hint is recomputed from the live configuration -> DERIVED, never persisted
 */

import { isRecord } from "../../../shared/util/json";
import { LEGACY_HEADERS_ID, NEW_MODEL_CAPABILITIES_ID, NEW_MODEL_PARAMETERS_ID } from "./legacyIds";
import { isUrlScopedKey } from "./records";

export type LegacyHintKind = "inert-url-scoped-key" | "inert-global-headers";

export interface LegacyHint {
	readonly kind: LegacyHintKind;
	/** The leftover key: a record key for scoped-key hints, the setting id for the headers hint. */
	readonly oldKey: string;
	/** The setting id the leftover sits in. */
	readonly detail: string;
}

export interface LegacyHintInput {
	/** The global `headers` value (the removed setting's leftover), as configured. */
	readonly globalHeadersValue: unknown;
	readonly modelParametersValue: unknown;
	readonly modelCapabilitiesValue: unknown;
}

function scopedKeyHints(value: unknown, settingId: string): LegacyHint[] {
	if (!isRecord(value)) {
		return [];
	}
	return Object.keys(value)
		.filter(isUrlScopedKey)
		.map((key) => ({ kind: "inert-url-scoped-key" as const, oldKey: key, detail: settingId }));
}

/**
 *   Base URLs are user text -> must never reach logs or issue reports
 */
export function collectLegacyHints(input: LegacyHintInput): LegacyHint[] {
	const hints = [
		...scopedKeyHints(input.modelParametersValue, NEW_MODEL_PARAMETERS_ID),
		...scopedKeyHints(input.modelCapabilitiesValue, NEW_MODEL_CAPABILITIES_ID),
	];
	if (isRecord(input.globalHeadersValue) && Object.keys(input.globalHeadersValue).length > 0) {
		hints.push({ kind: "inert-global-headers", oldKey: LEGACY_HEADERS_ID, detail: LEGACY_HEADERS_ID });
	}
	return hints;
}
