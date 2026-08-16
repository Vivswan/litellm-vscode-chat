/**
 * Configures @vscode/l10n from the bundle the HTML shell injects (window.__l10nBundle).
 * Must run before the first render: t() resolves against whatever is configured at call
 * time. An English host injects no bundle and t() returns its inline message.
 */
import * as l10n from "@vscode/l10n";
import { isRecord, isUnsafeRecordKey } from "../../shared/util/json";

declare global {
	interface Window {
		/** Injected by the extension side; a trust boundary, so validated here and never blindly cast. */
		__l10nBundle?: unknown;
	}
}

/** The injected value as a flat string-to-string table, or undefined for any other shape. */
function parseBundle(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const bundle: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isUnsafeRecordKey(key)) {
			// __proto__-class keys cannot be honest l10n keys; drop them rather
			// than trust assignment to silently no-op.
			continue;
		}
		if (typeof entry !== "string") {
			return undefined;
		}
		bundle[key] = entry;
	}
	return bundle;
}

/** Read and validate the injected bundle; configure @vscode/l10n only when it holds one. */
export function bootstrapL10n(): void {
	const bundle = parseBundle(window.__l10nBundle);
	if (bundle !== undefined) {
		l10n.config({ contents: bundle });
	}
}
