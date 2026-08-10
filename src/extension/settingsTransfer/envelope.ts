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
 * Pure and vscode-free, like the rest of src/extension/settingsTransfer/.
 */

import { CONFIG_SECTION } from "../../shared/config/settingSpec";

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
 * in `unknownKeys`, reported in the preview and never written.
 */
export type ParseEnvelopeResult =
	| {
			readonly ok: true;
			readonly settings: Readonly<Record<string, unknown>>;
			readonly unknownKeys: readonly string[];
	  }
	| { readonly ok: false; readonly reason: "not-json" | "not-an-export" | "newer-version" };

/** Wrap already-built settings (see exportBuild.ts) in the versioned envelope. */
export function buildEnvelope(
	_settings: Readonly<Record<string, unknown>>,
	_exportedBy: string
): SettingsExportEnvelope {
	throw new Error("unimplemented");
}

/** Parse a candidate export file's raw text; see ParseEnvelopeResult for the verdicts. */
export function parseEnvelope(_raw: string): ParseEnvelopeResult {
	throw new Error("unimplemented");
}
