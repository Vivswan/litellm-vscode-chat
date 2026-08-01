/**
 * Configures @vscode/l10n from the bundle the extension's HTML shell injects
 * into the page (window.__l10nBundle, written by buildDashboardHtml before
 * the dashboard bundle loads). Must run before the first render: t() resolves
 * against whatever is configured at call time. Under an English host no
 * bundle is injected and l10n stays unconfigured, so t() returns its inline
 * English message.
 */
import * as l10n from "@vscode/l10n";
import { z } from "zod";

declare global {
	interface Window {
		/** Injected by the extension side; a trust boundary, so validated here and never blindly cast. */
		__l10nBundle?: unknown;
	}
}

const bundleSchema = z.record(z.string(), z.string());

/** Read and validate the injected bundle; configure @vscode/l10n only when it holds one. */
export function bootstrapL10n(): void {
	const parsed = bundleSchema.safeParse(window.__l10nBundle);
	if (parsed.success) {
		l10n.config({ contents: parsed.data });
	}
}
