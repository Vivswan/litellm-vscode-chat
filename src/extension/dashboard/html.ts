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
 * follows every color theme without shipping a framework. The layout runs on
 * an 8px rhythm; motion is limited to sub-150ms hover transitions.
 */
const STYLES = `
	body {
		color: var(--vscode-foreground);
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		margin: 0;
		padding: 0 24px 48px;
	}
	main { max-width: 960px; margin: 0 auto; }
	h1 { font-size: 1.35em; font-weight: 600; margin: 24px 0 4px; }
	h2 {
		font-size: 1.05em;
		font-weight: 600;
		margin: 0 0 8px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		display: flex;
		align-items: center;
		gap: 8px;
	}
	h3 { font-size: 1em; font-weight: 600; margin: 24px 0 8px; }
	section { margin-top: 32px; }
	p.hint, span.hint { color: var(--vscode-descriptionForeground); margin: 4px 0 8px; }
	p { margin: 4px 0 8px; }

	/* Status hero: the at-a-glance layer the status bar click promises. */
	.hero {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
		margin: 16px 0 0;
		padding: 8px 16px;
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
		border-radius: 4px;
		background: var(--vscode-editorWidget-background, transparent);
	}
	.hero .stat { color: var(--vscode-descriptionForeground); white-space: nowrap; }
	.hero .stat strong { color: var(--vscode-foreground); font-weight: 600; }
	.hero .spacer { flex: 1; }
	.overall { font-weight: 600; white-space: nowrap; }
	.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: currentColor; }
	.tone-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
	.tone-error { color: var(--vscode-errorForeground); }
	.tone-warn { color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-charts-yellow)); }
	.tone-muted { color: var(--vscode-descriptionForeground); }

	table { border-collapse: collapse; width: 100%; margin: 8px 0; }
	.table-scroll { overflow-x: auto; }
	th, td {
		text-align: left;
		padding: 3px 12px 3px 0;
		border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		vertical-align: baseline;
	}
	th { color: var(--vscode-descriptionForeground); font-weight: 600; white-space: nowrap; }
	tbody tr:hover { background: var(--vscode-list-hoverBackground, transparent); }
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
	td.actions { white-space: nowrap; text-align: right; }

	.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; align-items: center; }
	button {
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 2px;
		padding: 4px 12px;
		cursor: pointer;
		font-family: inherit;
		font-size: inherit;
		transition: background-color 120ms ease-out;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary {
		color: var(--vscode-button-secondaryForeground);
		background: var(--vscode-button-secondaryBackground);
	}
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button.quiet {
		color: var(--vscode-descriptionForeground);
		background: transparent;
		border-color: transparent;
		padding: 2px 6px;
	}
	button.quiet:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)); }
	/* After button.quiet:hover so an armed destructive confirm stays in the
	   error color while hovered. */
	button.quiet.state-error { color: var(--vscode-errorForeground); }
	button:disabled { opacity: 0.5; cursor: default; }
	button:focus-visible, summary:focus-visible, a:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 1px;
	}

	input[type="text"], input[type="password"], input[type="number"] {
		color: var(--vscode-input-foreground);
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 2px;
		padding: 3px 6px;
		font-family: inherit;
		font-size: inherit;
	}
	input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
	input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	input.invalid { border-color: var(--vscode-inputValidation-errorBorder, #f00); }

	.field { display: grid; grid-template-columns: 220px minmax(200px, 320px); gap: 4px 12px; align-items: center; margin: 8px 0; }
	.field label { color: var(--vscode-foreground); }
	.field .hint, .field .error, .field .secret-where { grid-column: 2; margin: 0; font-size: 0.9em; }
	/* Hints may run wider than the 320px control column so they wrap at the
	   same measure as the storage-choice row above them, not visibly narrower. */
	.field .hint { width: max-content; max-width: 420px; }
	.error { color: var(--vscode-errorForeground); }

	.badge, .count {
		display: inline-block;
		padding: 0 6px;
		border-radius: 8px;
		font-size: 0.85em;
		color: var(--vscode-descriptionForeground);
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
		background: transparent;
		white-space: nowrap;
	}
	.badge + .badge { margin-left: 4px; }
	.count { font-weight: 400; }
	.caps { color: var(--vscode-descriptionForeground); }
	.state-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
	.state-error { color: var(--vscode-errorForeground); }
	.state-muted { color: var(--vscode-descriptionForeground); }

	.rows { margin: 4px 0 8px; }
	.row {
		display: grid;
		grid-template-columns: 220px minmax(200px, 1fr) auto;
		gap: 4px 8px;
		align-items: center;
		margin: 4px 0;
	}
	.row input.key { grid-column: 1; width: auto; }
	.row input.value { grid-column: 2; width: auto; }
	.row button { grid-column: 3; justify-self: start; }
	.row .error { grid-column: 1 / -1; font-size: 0.9em; margin: 0; }
	.group {
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		border-radius: 4px;
		padding: 8px 16px;
		margin: 8px 0;
		background: var(--vscode-editorWidget-background, transparent);
	}

	.form-card {
		max-width: 640px;
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
		border-radius: 4px;
		padding: 8px 16px 16px;
		margin: 8px 0;
		background: var(--vscode-editorWidget-background, transparent);
	}
	.form-card h3 { font-size: 1em; font-weight: 600; margin: 8px 0; }
	details { margin: 8px 0; }
	summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
	details[open] summary { margin-bottom: 4px; }
	.secret-where {
		display: flex;
		gap: 12px;
		align-items: center;
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
		white-space: nowrap;
	}
	.secret-where label { display: flex; gap: 4px; align-items: center; }
	.secret-where .where-label { color: var(--vscode-foreground); }

	.filterbar { display: flex; gap: 12px; align-items: baseline; margin: 8px 0; flex-wrap: wrap; }
	.filterbar input { min-width: 260px; }

	.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
	.empty-block {
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		border-radius: 4px;
		padding: 8px 16px;
		margin: 8px 0;
	}
	.empty-block p { margin: 8px 0; }
	.skeleton { border-radius: 3px; background: var(--vscode-foreground); opacity: 0.12; }

	@media (max-width: 500px) {
		.field { grid-template-columns: 1fr; }
		.field .hint, .field .error, .field .secret-where { grid-column: 1; }
		.field .hint { width: auto; max-width: none; }
		.secret-where { flex-wrap: wrap; white-space: normal; }
		.row { grid-template-columns: 1fr; }
		.row input.key, .row input.value, .row button, .row .error { grid-column: 1; }
		/* The servers table stacks into card-style blocks: rows carry actions
		   with no other route, so they must be reachable without horizontal
		   scrolling. */
		table.servers, table.servers tbody, table.servers tr, table.servers td { display: block; }
		table.servers thead { display: none; }
		table.servers tr {
			border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
			border-radius: 4px;
			padding: 4px 12px 8px;
			margin: 8px 0;
		}
		table.servers td { border-bottom: none; padding: 2px 0; }
		table.servers td.num, table.servers td.actions { text-align: left; }
		table.servers td:first-child { font-weight: 600; }
		table.servers td:empty { display: none; }
		table.servers td[data-label]::before {
			content: attr(data-label) ": ";
			color: var(--vscode-descriptionForeground);
		}
	}
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
