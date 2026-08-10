/**
 * The settings-export file envelope: the versioned JSON shape
 * `{ "litellm-vscode-chat": 1, "exportedBy": "<ext version>", "settings": {...} }`
 * and its lenient parser. The integer under the config-section key is the
 * FORMAT version and the file discriminant (an unknown higher value reads as
 * "exported by a newer version"); `exportedBy` is informational only, never
 * a compatibility gate. Guards are hand-rolled, not zod: the servers grammar's
 * source of truth is parseServersSetting, a zod mirror would drift, and zod
 * stays at the webview trust boundary and out of this dependency-free core.
 *
 * Pure and vscode-free.
 */

import { ALL_SETTING_KEYS, CONFIG_SECTION } from "../../shared/config/settingSpec";
import { isRecord } from "../../shared/util/json";

/** The format version this build writes and the highest one it can read. */
export const SETTINGS_EXPORT_FORMAT_VERSION = 1;

/** The export file's top-level shape; the config-section-named key doubles as the discriminant. */
export interface SettingsExportEnvelope {
	readonly [CONFIG_SECTION]: typeof SETTINGS_EXPORT_FORMAT_VERSION;
	readonly exportedBy: string;
	/** Setting values keyed by their litellm-vscode-chat.* key names (section prefix stripped). */
	readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * A parsed export file, or why it is not one: "not-json" (unparseable),
 * "not-an-export" (JSON without the discriminant shape), "newer-version"
 * (a format version above SETTINGS_EXPORT_FORMAT_VERSION). On ok, `settings`
 * holds only ALL_SETTING_KEYS members; file keys outside the vocabulary land
 * in `unknownKeys`, reported in the preview and never written. `exportedBy`
 * is the envelope's field when it carries a string - diagnostics provenance
 * only, never a compatibility gate.
 */
export type ParseEnvelopeResult =
	| {
			readonly ok: true;
			readonly settings: Readonly<Record<string, unknown>>;
			readonly unknownKeys: readonly string[];
			readonly exportedBy: string | undefined;
	  }
	| { readonly ok: false; readonly reason: "not-json" | "not-an-export" }
	| { readonly ok: false; readonly reason: "newer-version"; readonly exportedBy: string | undefined };

/** Wrap already-built settings (see exportBuild.ts) in the versioned envelope. */
export function buildEnvelope(settings: Readonly<Record<string, unknown>>, exportedBy: string): SettingsExportEnvelope {
	return {
		[CONFIG_SECTION]: SETTINGS_EXPORT_FORMAT_VERSION,
		exportedBy,
		settings,
	};
}

/** Parse a candidate export file's raw text; see ParseEnvelopeResult for the verdicts. */
export function parseEnvelope(raw: string): ParseEnvelopeResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "not-json" };
	}
	if (!isRecord(parsed)) {
		return { ok: false, reason: "not-an-export" };
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
