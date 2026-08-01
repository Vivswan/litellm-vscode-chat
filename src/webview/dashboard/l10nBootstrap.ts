/**
 * Configures @vscode/l10n from the bundle the extension's HTML shell injects
 * into the page (window.__l10nBundle, written by buildDashboardHtml before
 * the dashboard bundle loads). Must run before the first render: t() resolves
 * against whatever is configured at call time. Under an English host no
 * bundle is injected and l10n stays unconfigured, so t() returns its inline
 * English message.
 */
import * as l10n from "@vscode/l10n";
import { isRecord, isUnsafeRecordKey } from "../../extension/dashboard/protocol";

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
