/**
 * Leftovers of the settings shape of 0.4.4 and earlier that the live configuration still carries and nothing reads:
 * URL-scoped record keys (the removed `"<baseUrl>/matcher"` grammar) and a value under the removed global `headers`
 * setting. Dumb data on purpose - the dashboard (not this module) decides presentation and localization.
 *
 *   each hint is recomputed from the live configuration -> DERIVED, never persisted
 */

import { MODEL_CAPABILITIES_SETTING_KEY, MODEL_PARAMETERS_SETTING_KEY } from "../../shared/config/settingSpec";
import { isRecord } from "../../shared/util/json";

/** The removed global headers setting; its value is applied to nothing. */
export const LEGACY_HEADERS_ID = "headers";

type LegacyHintKind = "inert-url-scoped-key" | "inert-global-headers";

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

/** A record key in the removed server-scoped grammar: no model ID carries a scheme separator. */
function isUrlScopedKey(key: string): boolean {
	return key.includes("://");
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
		...scopedKeyHints(input.modelParametersValue, MODEL_PARAMETERS_SETTING_KEY),
		...scopedKeyHints(input.modelCapabilitiesValue, MODEL_CAPABILITIES_SETTING_KEY),
	];
	if (isRecord(input.globalHeadersValue) && Object.keys(input.globalHeadersValue).length > 0) {
		hints.push({ kind: "inert-global-headers", oldKey: LEGACY_HEADERS_ID, detail: LEGACY_HEADERS_ID });
	}
	return hints;
}
