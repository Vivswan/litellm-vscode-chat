/**
 * Dashboard hints for legacy leftovers the redesign migration deliberately
 * leaves in place. DERIVED, never persisted: each hint is recomputed from
 * the live configuration, so it appears exactly while the inert state exists
 * and disappears the moment a later activation's migration pass (or the
 * user) resolves it. Dumb data on purpose - the dashboard (not this module)
 * decides presentation and localization.
 */

import { isRecord } from "../../../shared/util/json";
import { LEGACY_HEADERS_ID, NEW_MODEL_CAPABILITIES_ID, NEW_MODEL_PARAMETERS_ID } from "./legacyIds";
import { isUrlScopedKey } from "./records";

export type LegacyHintKind = "inert-url-scoped-key" | "inert-global-headers" | "parked-global-headers";

export interface LegacyHint {
	readonly kind: LegacyHintKind;
	/** The leftover key: a record key for scoped-key hints, the setting id for the headers hints. */
	readonly oldKey: string;
	/** The setting id the leftover sits in, or the parked header names. */
	readonly detail: string;
}

export interface LegacyHintInput {
	/** The global `headers` value (the removed setting's leftover), as configured. */
	readonly globalHeadersValue: unknown;
	/** The models.parameters setting value, as configured. */
	readonly modelParametersValue: unknown;
	/** The models.capabilities setting value, as configured. */
	readonly modelCapabilitiesValue: unknown;
	/** The PARKED_GLOBAL_HEADERS_KEY globalState value ({ headers, migratedAt }), when present. */
	readonly parkedGlobalHeadersValue?: unknown;
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
 * Every legacy leftover worth a dashboard hint: server-URL-scoped keys still
 * sitting in a global record (they match no model ID under the new grammar),
 * a global headers value no entry could receive, and a parked global
 * headers value (the removed setting also reached servers without a
 * declared entry; adopting the group restores them). Base URLs and header
 * names are user text - the hints are for the local dashboard only and must
 * never reach logs or issue reports.
 */
export function collectLegacyHints(input: LegacyHintInput): LegacyHint[] {
	const hints = [
		...scopedKeyHints(input.modelParametersValue, NEW_MODEL_PARAMETERS_ID),
		...scopedKeyHints(input.modelCapabilitiesValue, NEW_MODEL_CAPABILITIES_ID),
	];
	if (isRecord(input.globalHeadersValue) && Object.keys(input.globalHeadersValue).length > 0) {
		hints.push({ kind: "inert-global-headers", oldKey: LEGACY_HEADERS_ID, detail: LEGACY_HEADERS_ID });
	}
	if (isRecord(input.parkedGlobalHeadersValue)) {
		const parked = input.parkedGlobalHeadersValue.headers;
		// Only a value that really carried header names has a loss to report;
		// the migration parks nothing else, and a stale record from an older
		// build must not raise a hint the user cannot dismiss.
		if (isRecord(parked) && Object.keys(parked).length > 0) {
			hints.push({
				kind: "parked-global-headers",
				oldKey: LEGACY_HEADERS_ID,
				detail: Object.keys(parked).sort().join(", "),
			});
		}
	}
	return hints;
}
