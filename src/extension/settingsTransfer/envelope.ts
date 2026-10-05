/**
 * The integer under the config-section key is the FORMAT version and the file discriminant (an unknown higher value
 * reads as "exported by a newer version"); `exportedBy` is informational only, never a compatibility gate.
 *
 *   parseServersSetting is the servers grammar's source of truth and a zod mirror would drift -> Guards are
 *       hand-rolled, not zod
 */

import { ALL_SETTING_KEYS, CONFIG_SECTION } from "../../shared/config/settingSpec";
import { isRecord, nonFiniteNumberPath } from "../../shared/util/json";

/** The format version this build writes and the highest one it can read. */
export const SETTINGS_EXPORT_FORMAT_VERSION = 1;

export interface SettingsExportEnvelope {
	readonly [CONFIG_SECTION]: typeof SETTINGS_EXPORT_FORMAT_VERSION;
	readonly exportedBy: string;
	/** Setting values keyed by their litellm-vscode-chat.* key names (section prefix stripped). */
	readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * On ok, `settings` holds only ALL_SETTING_KEYS members; file keys outside the vocabulary land in `unknownKeys`,
 * reported in the preview and never written.
 */
export type ParseEnvelopeResult =
	| {
			readonly ok: true;
			readonly settings: Readonly<Record<string, unknown>>;
			readonly unknownKeys: readonly string[];
			readonly exportedBy: string | undefined;
	  }
	| { readonly ok: false; readonly reason: "not-json" | "not-an-export" }
	| { readonly ok: false; readonly reason: "overflowing-number"; readonly path: string }
	| { readonly ok: false; readonly reason: "newer-version"; readonly exportedBy: string | undefined };

export function buildEnvelope(settings: Readonly<Record<string, unknown>>, exportedBy: string): SettingsExportEnvelope {
	return {
		[CONFIG_SECTION]: SETTINGS_EXPORT_FORMAT_VERSION,
		exportedBy,
		settings,
	};
}

export function parseEnvelope(raw: string): ParseEnvelopeResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "not-json" };
	}
	if (!isRecord(parsed)) {
		// A bare number (1e999 included) is no export; the overflow scan below always has a key to name.
		return { ok: false, reason: "not-an-export" };
	}
	const overflowAt = nonFiniteNumberPath(parsed);
	if (overflowAt !== undefined) {
		// 1e999 parsed to Infinity and would import as null: no repair, so the file is refused whole, naming the value
		// by its settings path (the envelope wrapper is not the user's to fix).
		return { ok: false, reason: "overflowing-number", path: overflowAt.replace(/^settings\./, "") };
	}
	const version = parsed[CONFIG_SECTION];
	if (typeof version !== "number") {
		return { ok: false, reason: "not-an-export" };
	}
	const exportedBy = typeof parsed.exportedBy === "string" ? parsed.exportedBy : undefined;
	if (version > SETTINGS_EXPORT_FORMAT_VERSION) {
		return { ok: false, reason: "newer-version", exportedBy };
	}
	const rawSettings = parsed.settings;
	if (!isRecord(rawSettings)) {
		return { ok: false, reason: "not-an-export" };
	}
	const settings: Record<string, unknown> = {};
	const unknownKeys: string[] = [];
	for (const key of Object.keys(rawSettings)) {
		if (ALL_SETTING_KEYS.includes(key)) {
			settings[key] = rawSettings[key];
		} else {
			unknownKeys.push(key);
		}
	}
	return { ok: true, settings, unknownKeys, exportedBy };
}
