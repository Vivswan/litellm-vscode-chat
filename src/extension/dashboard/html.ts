import type { UiAccent, UiTheme } from "../../shared/config/settingSpec";

/**
 * Pure string building so the CSP and script wiring are unit-testable; panel.ts supplies the nonce and the
 * webview-translated URIs.
 */

export interface DashboardHtmlOptions {
	/** The webview's CSP source (webview.cspSource). */
	readonly cspSource: string;
	readonly nonce: string;
	readonly scriptUri: string;
	readonly styleUri: string;
	/** vscode.env.language, rendered as the document's lang attribute. */
	readonly language: string;
	/** The host-resolved l10n bundle (vscode.l10n.bundle) for @vscode/l10n; undefined under English. */
	readonly l10nBundle: Readonly<Record<string, string>> | undefined;
	readonly theme: UiTheme;
	readonly accent: UiAccent;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

/** JSON hardened for an inline script body: "<" cannot open "</script>" or "<!--"; U+2028/U+2029 escaped too. */
function inlineScriptJson(value: Readonly<Record<string, string>>): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

export function buildDashboardHtml(options: DashboardHtmlOptions): string {
	const nonce = escapeHtml(options.nonce);
	const cspSource = escapeHtml(options.cspSource);
	const scriptUri = escapeHtml(options.scriptUri);
	const styleUri = escapeHtml(options.styleUri);
	const language = escapeHtml(options.language);
	// Inline so @vscode/l10n is configured before the bundle's first render;
	// absent under English (t() falls back to its inline message).
	const bundleScript =
		options.l10nBundle !== undefined
			? `<script nonce="${nonce}">window.__l10nBundle = ${inlineScriptJson(options.l10nBundle)};</script>\n\t`
			: "";
	// Stamped on the root so the stylesheet keys its palettes off them before the bundle runs: a reader who pinned
	// light never sees a dark frame.
	const theme = escapeHtml(options.theme);
	const accent = escapeHtml(options.accent);
	return `<!DOCTYPE html>
<html lang="${language}" data-theme="${theme}" data-accent="${accent}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; form-action 'none'; base-uri 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>LiteLLM Dashboard</title>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div id="root"></div>
	${bundleScript}<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
