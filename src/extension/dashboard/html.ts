/**
 * The dashboard webview's HTML shell: a strict CSP, one nonce'd script tag
 * for the bundled Preact app, and the stylesheet. Pure string building so the
 * CSP and script wiring are unit-testable; panel.ts supplies the nonce and
 * the webview-translated script URI.
 */

export interface DashboardHtmlOptions {
	/** The webview's CSP source (webview.cspSource). */
	readonly cspSource: string;
	/** Nonce authorizing exactly this document's script tag. */
	readonly nonce: string;
	/** The dashboard bundle as a webview URI string. */
	readonly scriptUri: string;
}

/** Minimal HTML attribute/text escaping for the interpolated values. */
function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * All styling uses the host's theme tokens (var(--vscode-*)) so the dashboard
 * follows every color theme without shipping a framework.
 */
const STYLES = `
	body {
		color: var(--vscode-foreground);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		margin: 0;
		padding: 0 20px 40px;
	}
	main { max-width: 960px; margin: 0 auto; }
	h1 { font-size: 1.4em; font-weight: 600; margin: 20px 0 4px; }
	h2 {
		font-size: 1.1em;
		font-weight: 600;
		margin: 28px 0 8px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--vscode-widget-border, transparent);
	}
	p.hint, span.hint { color: var(--vscode-descriptionForeground); margin: 2px 0 8px; }
	table { border-collapse: collapse; width: 100%; margin: 8px 0; }
	th, td {
		text-align: left;
		padding: 4px 10px 4px 0;
		border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		vertical-align: top;
	}
	th { color: var(--vscode-descriptionForeground); font-weight: 600; }
	td.num, th.num { text-align: right; }
	.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
	button {
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 2px;
		padding: 4px 12px;
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary {
		color: var(--vscode-button-secondaryForeground);
		background: var(--vscode-button-secondaryBackground);
	}
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button:disabled { opacity: 0.5; cursor: default; }
	input[type="text"], input[type="number"] {
		color: var(--vscode-input-foreground);
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 2px;
		padding: 3px 6px;
		font-family: inherit;
		font-size: inherit;
	}
	input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	input.invalid { border-color: var(--vscode-inputValidation-errorBorder, #f00); }
	.field { display: flex; align-items: baseline; gap: 10px; margin: 6px 0; flex-wrap: wrap; }
	.field label { min-width: 220px; }
	.error {
		color: var(--vscode-errorForeground);
	}
	.badge {
		display: inline-block;
		padding: 0 6px;
		margin-right: 4px;
		border-radius: 8px;
		font-size: 0.85em;
		color: var(--vscode-badge-foreground);
		background: var(--vscode-badge-background);
		white-space: nowrap;
	}
	.state-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
	.state-error { color: var(--vscode-errorForeground); }
	.rows { margin: 4px 0 8px; }
	.row { display: flex; gap: 6px; align-items: center; margin: 3px 0; flex-wrap: wrap; }
	.row input.key { width: 220px; }
	.row input.value { width: 260px; }
	.group {
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		border-radius: 4px;
		padding: 8px 12px;
		margin: 8px 0;
	}
	.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
`;

export function buildDashboardHtml(options: DashboardHtmlOptions): string {
	const nonce = escapeHtml(options.nonce);
	const cspSource = escapeHtml(options.cspSource);
	const scriptUri = escapeHtml(options.scriptUri);
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; form-action 'none'; base-uri 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>LiteLLM Dashboard</title>
	<style>${STYLES}</style>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
