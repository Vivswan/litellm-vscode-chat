/**
 * The dashboard webview's HTML shell: a strict CSP, one nonce'd script tag
 * for the bundled Preact app, and a link to the bundled stylesheet. Pure
 * string building so the CSP and script wiring are unit-testable; panel.ts
 * supplies the nonce and the webview-translated script and style URIs.
 */

export interface DashboardHtmlOptions {
	/** The webview's CSP source (webview.cspSource). */
	readonly cspSource: string;
	/** Nonce authorizing exactly this document's script tags. */
	readonly nonce: string;
	/** The dashboard bundle as a webview URI string. */
	readonly scriptUri: string;
	/** The dashboard stylesheet as a webview URI string. */
	readonly styleUri: string;
	/** The host's display language (vscode.env.language), rendered as the document's lang attribute. */
	readonly language: string;
	/** The host-resolved l10n bundle (vscode.l10n.bundle) injected for @vscode/l10n; undefined under English. */
	readonly l10nBundle: Readonly<Record<string, string>> | undefined;
}

/** Minimal HTML attribute/text escaping for the interpolated values. */
function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * JSON hardened for an inline script body: "<" cannot open "</script>" or
 * "<!--"; U+2028/U+2029 are escaped for defense-in-depth.
 */
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
	// The bundle rides an inline script so @vscode/l10n is configured before
	// the dashboard bundle's first render; absent under English on purpose
	// (t() then falls back to its inline message).
	const bundleScript =
		options.l10nBundle !== undefined
			? `<script nonce="${nonce}">window.__l10nBundle = ${inlineScriptJson(options.l10nBundle)};</script>\n\t`
			: "";
	return `<!DOCTYPE html>
<html lang="${language}">
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
