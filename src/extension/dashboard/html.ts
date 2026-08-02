/**
 * The dashboard webview's HTML shell: a strict CSP, one nonce'd script tag
 * for the bundled Preact app, and the stylesheet. Pure string building so the
 * CSP and script wiring are unit-testable; panel.ts supplies the nonce and
 * the webview-translated script URI.
 */

export interface DashboardHtmlOptions {
	/** The webview's CSP source (webview.cspSource). */
	readonly cspSource: string;
	/** Nonce authorizing exactly this document's script tags. */
	readonly nonce: string;
	/** The dashboard bundle as a webview URI string. */
	readonly scriptUri: string;
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
	/* Section h2s under the tab bar stay for structure (headings anchor the
	   help glyphs and assistive navigation) but carry no rule of their own:
	   the tab bar above already draws the divider. */
	h2 {
		font-size: 1.05em;
		font-weight: 600;
		margin: 0 0 8px;
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

	/* Status pills: tone dot, plain-language verdict, relative time. One
	   vocabulary for the hero's overall verdict and every server row, so the
	   page's state indicators cannot drift apart visually. */
	.pill { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-weight: 600; }
	.pill .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
	.pill .pill-time { color: var(--vscode-descriptionForeground); font-weight: 400; }
	.tone-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
	.tone-error { color: var(--vscode-errorForeground); }
	.tone-warn { color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-charts-yellow)); }
	.tone-muted { color: var(--vscode-descriptionForeground); }

	/* The section tab bar: native panel-title anatomy (muted labels, 1px
	   underline on the active one) on the panelTitle tokens, sticky so the
	   section switcher survives scrolling a long models table. The negative
	   margins let the underline run the full panel width while labels keep
	   the content's left edge. */
	.tabs {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		gap: 8px;
		margin: 16px -24px 8px;
		padding: 4px 24px 0;
		background: var(--vscode-editor-background, var(--vscode-panel-background));
		border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
	}
	button.tab {
		background: transparent;
		border: none;
		border-bottom: 1px solid transparent;
		border-radius: 0;
		margin-bottom: -1px;
		padding: 6px 2px;
		color: var(--vscode-panelTitle-inactiveForeground, var(--vscode-descriptionForeground));
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	button.tab:hover {
		background: transparent;
		color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
	}
	button.tab[aria-selected="true"] {
		color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
		border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder));
	}
	button.tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

	table { border-collapse: collapse; width: 100%; margin: 8px 0; }
	.table-scroll { overflow-x: auto; }
	/* The models scrollport is a section (a labelled, focusable region), so
	   the generic section top margin would open a stray 32px gap between the
	   filter bar and the table; the table's own 8px rhythm is the intent. */
	section.table-scroll { margin-top: 0; }
	/* Long model lists render windowed inside their own scrollport at the
	   bottom of the combined page. The cap keeps the whole scrollport on
	   screen once the page has scrolled the models heading up to the sticky
	   tab bar: the chrome above and below it (tab bar, heading, filter bar,
	   page padding) measures a bit over 11em at the default font, and the
	   em unit keeps the budget honest when the host font or zoom grows it.
	   The floor keeps the scrollport usable in short windows. The sticky
	   header keeps the sort controls reachable mid-list; the fixed row height
	   that makes the scroll arithmetic exact lives on table.models below,
	   shared with the non-windowed path. */
	.table-scroll.windowed {
		max-height: max(280px, calc(100vh - 13em));
		overflow-y: auto;
		border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
	}
	.table-scroll.windowed:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.table-scroll.windowed thead th {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--vscode-editor-background, var(--vscode-panel-background));
	}
	/* Every models table shares one single-line rhythm, windowed or not:
	   nowrap cells at a fixed 26px row height, so pricing never breaks
	   mid-expression and row heights cannot vary with wrapping. The height
	   doubles as the windowing arithmetic's anchor (the component measures
	   the first rendered row, 26px as the fallback), so both render paths
	   must keep the same rule. */
	table.models tbody tr:not(.spacer) { height: 26px; }
	table.models tbody td { padding-top: 0; padding-bottom: 0; white-space: nowrap; }
	th button.sort {
		background: transparent;
		border: none;
		border-radius: 0;
		padding: 0;
		color: inherit;
		font: inherit;
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}
	th button.sort:hover { background: transparent; color: var(--vscode-foreground); }
	.sort-arrow { display: inline-flex; }
	.sort-arrow.desc { transform: rotate(180deg); }
	/* Inactive columns keep a resting affordance: a dim arrow surfaces on the
	   header's hover or focus, so sortability is discoverable before the
	   first click. */
	.sort-arrow.idle { opacity: 0; }
	th:hover .sort-arrow.idle, button.sort:focus-visible .sort-arrow.idle { opacity: 0.45; }
	/* Per-row icon actions surface on the row's hover or when focus is inside
	   it; opacity (not visibility) keeps them in the Tab order throughout. */
	button.icon-action { opacity: 0; transition: opacity 120ms ease-out; }
	tr:hover button.icon-action, tr:focus-within button.icon-action, button.icon-action:focus-visible { opacity: 1; }
	/* A server row's model count doubling as the jump into the models section:
	   keeps the cell's numeric look, with a dotted underline as the only hint
	   that it does something. */
	td.num button.count-link {
		padding: 0 4px;
		font-variant-numeric: tabular-nums;
		text-decoration: underline dotted;
		text-underline-offset: 2px;
	}
	th, td {
		text-align: left;
		padding: 3px 12px 3px 0;
		border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		vertical-align: baseline;
	}
	th { color: var(--vscode-descriptionForeground); font-weight: 600; white-space: nowrap; }
	tbody tr:hover { background: var(--vscode-list-hoverBackground, transparent); }
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
	/* Left-aligned so a lone action (an external row's Edit, the adoption
	   entry point) sits where every row's Edit sits, and is the last thing a
	   narrow viewport's horizontal scroll loses instead of the first. */
	td.actions { white-space: nowrap; }
	/* The models table's column budget: the default table must fit the 960px
	   main column with no horizontal scroll (scroll stays only as a fallback
	   for extreme content). Right padding tighter than the generic 12px, none
	   at all on the trailing action column, and an ellipsis cap on the two
	   free-text columns; the capabilities tip carries the full list, and a
	   trimmed name stays whole in the DOM and the inspector's heading. The
	   inline-blocks align bottom because a baseline-aligned box with hidden
	   overflow would ride up off the row's shared baseline. */
	table.models th, table.models td { padding-right: 8px; }
	table.models th:last-child, table.models td:last-child { padding-right: 0; }
	/* The models table's name cell keeps its copy action on the name's line. */
	td.model-name { white-space: nowrap; }
	.model-name-text {
		display: inline-block;
		max-width: 17em;
		overflow: hidden;
		text-overflow: ellipsis;
		vertical-align: bottom;
	}
	td.caps .tip-wrap { max-width: 100%; }
	.caps-text {
		display: inline-block;
		max-width: 10em;
		overflow: hidden;
		text-overflow: ellipsis;
		vertical-align: bottom;
	}

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
	.field label, .field .field-label { color: var(--vscode-foreground); }
	/* A label with its help glyph as one grid cell, so the glyph sits on the
	   label's baseline instead of taking a grid track of its own. */
	.field .label-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
	/* A fixed, non-editable value (the adopt form's base URL): plain dimmed
	   text, so it cannot be mistaken for an input that merely looks disabled. */
	.field .readonly-value { color: var(--vscode-descriptionForeground); padding: 3px 0; overflow-wrap: anywhere; }
	.field .hint, .field .error, .field .secret-where { grid-column: 2; margin: 0; font-size: 0.9em; }
	/* Hints may run wider than the 320px control column so they wrap at the
	   same measure as the storage-choice row above them, not visibly narrower. */
	.field .hint { width: max-content; max-width: 420px; }
	.error { color: var(--vscode-errorForeground); }

	/* The "?" help affordance next to section titles and field labels: a
	   muted circled glyph revealing a tooltip this document draws itself,
	   because native title tooltips do not reliably render in the webview
	   host and never show on keyboard focus. The wrapper anchors the tip;
	   hovering the wrapper or keyboard-focusing the button shows it.
	   A button so it is keyboard-focusable, but styled out of button chrome. */
	.help-wrap { position: relative; display: inline-flex; flex: none; }
	button.help {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		width: 14px;
		height: 14px;
		padding: 0;
		background: transparent;
		border: 1px solid var(--vscode-descriptionForeground);
		border-radius: 50%;
		color: var(--vscode-descriptionForeground);
		font-size: 10px;
		font-weight: 600;
		line-height: 1;
		cursor: help;
		user-select: none;
		vertical-align: text-bottom;
	}
	button.help:hover { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-foreground); }
	button.help:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	/* The tip mirrors the editor's hover widget (same theme tokens) and sits
	   above the trigger. The font resets so heading styles cannot leak in,
	   and pointer-events stays off so the tip never traps the mouse. */
	.help-tip {
		display: none;
		position: absolute;
		bottom: calc(100% + 6px);
		left: -8px;
		z-index: 100;
		width: max-content;
		max-width: min(320px, calc(100vw - 48px));
		padding: 6px 10px;
		background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
		color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
		border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
		border-radius: 3px;
		box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
		font-size: var(--vscode-font-size);
		font-weight: 400;
		line-height: 1.5;
		text-align: left;
		white-space: normal;
		overflow-wrap: break-word;
		pointer-events: none;
	}
	.help-wrap:hover .help-tip, button.help:focus-visible + .help-tip { display: block; }
	/* The "learn more" anchor beside section titles and in notices: opens the
	   matching docs page on GitHub (the webview host opens plain anchors
	   externally, so no CSP grant is involved). Quiet, on the textLink tokens;
	   the external-link glyph is the affordance. */
	a.docs-link {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--vscode-textLink-foreground);
		text-decoration: none;
	}
	a.docs-link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
	/* The page header: the title with one quiet Report-a-bug action on its
	   right, so filing an issue is reachable from anywhere on the page. The
	   title keeps h1's top margin; align-items end keeps the action on the
	   title's baseline band rather than floating above it. */
	.page-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px;
	}
	.page-head h1 { margin-bottom: 0; }
	/* The Diagnostics tab's connection block and feedback rows. The facts and
	   the outcome grid render selectable prose (this tab is where users copy
	   state from when asking for help); each feedback row is one action plus
	   its muted one-liner. */
	.diag-facts { list-style: none; padding: 0; margin: 8px 0 12px; }
	.diag-facts li { margin: 4px 0; }
	/* The outcome grid: one compact row per server, hugging its content
	   instead of the generic full-width table rule. A row's error or
	   params-inactive warning spans beneath it as its own line; rows followed
	   by such a note drop their rule (.no-rule) so each server group reads as
	   one block. No hover band: the grid is prose to read and copy, not a
	   control surface. */
	table.diag-grid { width: auto; }
	.diag-grid th, .diag-grid td { padding-right: 20px; }
	.diag-grid th:last-child, .diag-grid td:last-child { padding-right: 0; }
	.diag-grid tbody tr:hover { background: transparent; }
	.diag-grid tr.no-rule td { border-bottom: none; }
	.diag-grid tr.diag-note td { padding: 0 0 5px 12px; }
	.diag-grid tr.diag-note.error td { color: var(--vscode-errorForeground); }
	.diag-grid tr.diag-note.warn td { color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-charts-yellow)); }
	.diag-url { font-family: var(--vscode-editor-font-family); font-size: 0.95em; word-break: break-all; }
	.diag-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 4px; }
	.diag-actions button { display: inline-flex; align-items: center; gap: 5px; }
	.feedback-links { list-style: none; padding: 0; margin: 8px 0; }
	.feedback-links li { margin: 8px 0; }
	.feedback-links li .hint { margin-left: 8px; }
	/* A button that reads like the anchors beside it (Report a bug posts an
	   intent, so it cannot be an anchor); still a real button for focus and
	   keyboard activation. */
	button.linkish {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 0;
		border: none;
		background: none;
		color: var(--vscode-textLink-foreground);
		font-size: inherit;
	}
	button.linkish:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; background: none; }
	/* Hover tips over non-interactive inline content (badges, status pills):
	   the same tip element, revealed by hovering the wrapper. Extra detail
	   only; anything load-bearing also renders as visible text. */
	.tip-wrap { position: relative; display: inline-flex; }
	.tip-wrap:hover .help-tip, .tip-wrap:focus-visible .help-tip, .tip-wrap:focus-within .help-tip { display: block; }
	.tip-wrap[tabindex]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	.tip-wrap + .tip-wrap { margin-left: 4px; }
	/* Triggers in the page's top band (the first section heading) flip the
	   tip below them; above would clip against the top of the document. */
	.help-wrap.below .help-tip { bottom: auto; top: calc(100% + 6px); }

	/* The settings form follows the native Settings editor's row anatomy:
	   semibold title, muted description, control below. Titles, descriptions,
	   controls, and group headings share the section's left edge with the h2
	   and the record editors; the modified accent bar and the hover band hang
	   into a small gutter left of that edge (the body's 24px padding absorbs
	   the overhang), so marking a row never shifts its text. */
	.settings-groups { max-width: 680px; }
	.settings-group { margin: 16px 0 0; }
	.settings-group-title {
		font-size: 0.8em;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--vscode-descriptionForeground);
		margin: 0 0 2px;
	}
	.setting-row {
		position: relative;
		margin-left: -10px;
		padding: 6px 12px 8px 10px;
		border-radius: 2px;
	}
	.setting-row:hover, .setting-row:focus-within { background: var(--vscode-list-hoverBackground, transparent); }
	/* The bar is inset from the row's ends so two adjacent modified rows read
	   as two indicators, not one continuous bar. */
	.setting-row::before {
		content: "";
		position: absolute;
		left: 0;
		top: 8px;
		bottom: 8px;
		width: 2px;
		border-radius: 1px;
	}
	.setting-row.modified::before {
		background: var(--vscode-settings-modifiedItemIndicator, var(--vscode-focusBorder));
	}
	.setting-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.setting-title { display: block; font-weight: 600; }
	/* The modified annotation appends after the title, so appearing never
	   moves the row's text; nowrap keeps "Modified in ... (default: ...)"
	   dropping to the next line whole when the head runs out of room. */
	.setting-modified-note {
		color: var(--vscode-descriptionForeground);
		font-size: 0.85em;
		font-weight: 400;
		white-space: nowrap;
	}
	.setting-desc { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 2px 0 0; }
	.setting-control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
	/* Wide enough for the nullable field's "derived from context length"
	   placeholder to read whole, not just for the digits. Duration fields are
	   type="text" (the s/m/h suffixes need letters) and share the width so a
	   grammar change never shifts the column. */
	.setting-control input[type="number"], .setting-control input[type="text"] { width: 200px; }
	.setting-control input[type="number"] { appearance: textfield; }
	/* Plain fields like the native Settings editor: no spin buttons popping in
	   on hover/focus and compressing the value. */
	.setting-control input[type="number"]::-webkit-outer-spin-button,
	.setting-control input[type="number"]::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}
	.setting-unit, .setting-equiv {
		color: var(--vscode-descriptionForeground);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.setting-control .error { margin: 0; font-size: 0.9em; }
	.setting-check { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
	.setting-check input[type="checkbox"] {
		flex: none;
		margin: 1px 0 0;
		accent-color: var(--vscode-button-background);
		cursor: pointer;
	}
	.setting-check input[type="checkbox"]:focus { outline-offset: 1px; }
	.setting-check .setting-desc { margin: 0; }
	/* Reset appears only on configured rows, on hover or while the row holds
	   focus; hidden via visibility (not display) so the control row's layout
	   does not jump when it appears, and in DOM order after the input so Tab
	   reaches it from the field it resets. */
	.setting-row .reset { visibility: hidden; }
	.setting-row:hover .reset, .setting-row:focus-within .reset { visibility: visible; }
	/* The settings.json jump beside each row title follows the Reset idiom
	   (visibility, not display, so the head never reflows); on the record
	   editors' h3 headings it rests visible, like the docs links there. */
	.setting-row .reveal-json { visibility: hidden; padding: 0 4px; }
	.setting-row:hover .reveal-json, .setting-row:focus-within .reveal-json { visibility: visible; }
	h3 .reveal-json { padding: 0 4px; }
	/* The record editors' headings space their trailing icons (help, docs,
	   settings.json jump) at the same 8px rhythm the section h2s use. */
	h3.head-with-icons { display: flex; align-items: center; gap: 8px; }

	.badge {
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
	/* The hidden-groups line under the servers table: one muted sentence
	   stating the count, and a quiet row per group when expanded. */
	.hidden-groups { margin: 4px 0 8px; color: var(--vscode-descriptionForeground); }
	.hidden-groups > p { margin: 4px 0; }
	.hidden-groups ul { list-style: none; margin: 4px 0; padding: 0 0 0 12px; }
	.hidden-groups li { padding: 2px 0; }
	.hidden-groups .hidden-label { font-weight: 600; }
	.caps { color: var(--vscode-descriptionForeground); }
	.state-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
	.state-error { color: var(--vscode-errorForeground); }
	.state-warn { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); }
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
	/* An input with its help glyph as one grid cell; the input keeps the
	   width the glyph leaves, and the column assignment moves to the cell. */
	.row .cell { display: flex; gap: 6px; align-items: center; min-width: 0; }
	.row .cell.key { grid-column: 1; }
	.row .cell.value { grid-column: 2; }
	.row .cell input.key, .row .cell input.value { grid-column: auto; flex: 1; min-width: 0; }
	.row button { grid-column: 3; justify-self: start; }
	.row .error { grid-column: 1 / -1; font-size: 0.9em; margin: 0; }
	.group {
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		border-radius: 4px;
		padding: 8px 16px;
		margin: 8px 0;
		background: var(--vscode-editorWidget-background, transparent);
	}
	/* The record editors' Apply outcome, next to the button it reports on. */
	.apply-status { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
	.apply-status.saved { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
	/* Another scope's record, rendered with the same row grid but inert. */
	.other-scope { margin: 12px 0 0; }
	.other-scope > .hint { margin: 0 0 2px; }
	/* The Edit-as-JSON side door: one textarea in place of the rows. */
	.record-json textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: inherit;
		color: var(--vscode-input-foreground);
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 2px;
		padding: 4px 8px;
	}
	.record-json textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.record-json .error { font-size: 0.9em; margin: 4px 0; }

	/* The effective-parameters inspector (the models table's Params slide-over):
	   read-only prose and one small table, muted where a value is not sent.
	   The row's Params action keeps the quiet chrome but stays visible at
	   rest: it is the inspector's only entry point, and a hover-revealed
	   control at the table's right edge is undiscoverable. */
	.params-inspector h3 { display: flex; align-items: center; gap: 8px; margin: 4px 24px 4px 0; }
	.params-inspector .params-identity { overflow-wrap: anywhere; }
	.params-inspector table.params td, .params-inspector table.params th { padding-right: 10px; }
	.params-inspector .param-name, .params-inspector .param-value {
		font-family: var(--vscode-editor-font-family, monospace);
		overflow-wrap: anywhere;
	}
	.params-inspector .param-not-sent td { color: var(--vscode-descriptionForeground); }
	.params-inspector .param-skip { color: var(--vscode-descriptionForeground); }
	.params-inspector .param-shadowed td {
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
		border-bottom: none;
		padding-top: 0;
	}
	.params-inspector .param-shadowed .param-value { text-decoration: line-through; }
	.params-inspector .params-replaced ul {
		list-style: none;
		margin: 4px 0 8px;
		padding: 0 0 0 12px;
		color: var(--vscode-descriptionForeground);
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.9em;
	}
	/* The always-sent fields render as code chips on one labeled line, and the
	   caveats as labeled definition pairs: fixed explanations are structure
	   here, never stacked prose paragraphs. */
	.params-inspector .model-facts {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 3px 12px;
		margin: 8px 0 12px;
	}
	.params-inspector .model-facts div { display: contents; }
	.params-inspector .model-facts dd { margin: 0; }
	.params-inspector .params-fixed {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		align-items: baseline;
		margin: 8px 0;
	}
	.params-inspector code {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.9em;
		background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.15));
		padding: 1px 5px;
		border-radius: 3px;
	}
	.params-caveat-label {
		font-size: 0.8em;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--vscode-descriptionForeground);
	}
	/* The max_tokens derivation: always present, so it renders as a footer
	   band clearly distinct from the parameter table above it - a stray
	   unstyled paragraph there reads like a collapsed table row. It keeps the
	   full foreground (the value always goes out; muting it would demote the
	   one line every request obeys). */
	.params-inspector .params-max-tokens {
		margin: 12px 0 8px;
		padding: 6px 10px;
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		border-radius: 3px;
		background: var(--vscode-editorWidget-background, transparent);
	}
	.params-inspector .params-caveats {
		border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		margin-top: 12px;
		padding-top: 8px;
	}
	.params-inspector .params-caveats div { margin: 4px 0; }
	.params-inspector .params-caveats dt { display: inline; }
	.params-inspector .params-caveats dd { display: inline; margin: 0 0 0 8px; }

	.form-card {
		max-width: 640px;
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
		border-radius: 4px;
		padding: 8px 16px 16px;
		margin: 8px 0;
		background: var(--vscode-editorWidget-background, transparent);
	}
	.form-card h3 { font-size: 1em; font-weight: 600; margin: 8px 0; }

	/* The server form's slide-over: a scrim over the page and a focus-trapped
	   panel on the right edge. Elevation is the shadow alone; the one motion
	   is the panel's 200ms entrance, and it stands down for users who asked
	   the OS for reduced motion. */
	/* The scrim dims at a fixed alpha: theme widget-shadow values range from
	   translucent black to fully opaque accent colors, so keying the scrim to
	   the token either vanishes or paints a solid wall depending on theme. */
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: rgba(0, 0, 0, 0.45);
		border: none;
		border-radius: 0;
		padding: 0;
		cursor: default;
	}
	/* The scrim is a button (Esc-and-click-to-close semantics), so the generic
	   button:hover rule outranks .scrim by one specificity point and would
	   fade the whole page to opaque hover-blue the moment the pointer rests
	   on it - which is immediately, since the button that opened the panel
	   sits under it. */
	button.scrim:hover { background: rgba(0, 0, 0, 0.45); }
	.slide-over {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 41;
		width: min(460px, 92vw);
		box-sizing: border-box;
		overflow-y: auto;
		padding: 12px 20px 20px;
		background: var(--vscode-editor-background, var(--vscode-panel-background));
		box-shadow: -6px 0 16px rgba(0, 0, 0, 0.35);
		animation: slide-in 200ms ease-out;
	}
	@keyframes slide-in {
		from { transform: translateX(32px); opacity: 0; }
	}
	@media (prefers-reduced-motion: reduce) {
		.slide-over { animation: none; }
	}
	.slide-over .slide-close { position: absolute; top: 12px; right: 12px; }
	/* Inside the panel the form sheds its card chrome (the panel IS the
	   surface) and fields stack label-over-control: a 460px panel has no room
	   for the two-column field grid. */
	.slide-over .form-card { border: none; border-radius: 0; padding: 0; margin: 0; max-width: none; background: transparent; }
	.slide-over .form-card h3 { font-size: 1.05em; margin: 4px 24px 16px 0; }
	/* The 460px panel breathes more than the inline card: taller gaps between
	   the stacked fields and the collapsed groups keep the column scannable. */
	.slide-over .field { grid-template-columns: 1fr; margin: 14px 0; gap: 6px 12px; }
	.slide-over .field .hint, .slide-over .field .error, .slide-over .field .secret-where, .slide-over .field .secret-remove { grid-column: 1; }
	.slide-over .field .hint { width: auto; max-width: none; }
	.slide-over details { margin: 16px 0; }
	.slide-over .secret-where { flex-wrap: wrap; white-space: normal; }
	/* The form's Save/Cancel row pins to the panel's bottom edge, so the
	   commit action never scrolls out of a long form. */
	.slide-over .form-card > .toolbar {
		position: sticky;
		bottom: -20px;
		margin: 16px -20px -20px;
		padding: 12px 20px;
		background: var(--vscode-editor-background, var(--vscode-panel-background));
		border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
	}
	/* The draft-connection test's inline outcome, in the same footer row as
	   the buttons that produced it; explicitly selectable so an error message
	   can be copied into an issue or a terminal. */
	.test-result {
		font-size: 0.9em;
		user-select: text;
		overflow-wrap: anywhere;
	}
	/* A failed test's troubleshooting link: its own line inside the alert,
	   under the error message it belongs to. */
	.test-hint {
		display: block;
		margin-top: 2px;
	}
	/* A failed server entry's inline troubleshooting link: the label and its
	   external-link icon stay together mid-sentence in the joined banner. */
	.banner-hint {
		white-space: nowrap;
	}
	/* The discard confirm pins to the panel's bottom edge so it is in view
	   wherever the Esc that raised it was pressed. */
	.discard-confirm {
		position: sticky;
		z-index: 2;
		bottom: -20px;
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin: 16px -20px -20px;
		padding: 12px 20px;
		background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
		border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
	}
	.discard-confirm span { font-weight: 600; }
	.slide-notice {
		position: sticky;
		z-index: 2;
		bottom: -20px;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin: 8px -20px -20px;
		padding: 12px 20px;
		background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
		border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
		color: var(--vscode-descriptionForeground);
	}

	.icon { display: inline-block; vertical-align: text-bottom; flex: none; }

	/* The busy marker inside an in-flight Save/Adopt button; motion here is
	   state, not decoration, so it survives reduced-motion (slowed). */
	.spinner {
		display: inline-block;
		box-sizing: border-box;
		width: 12px;
		height: 12px;
		flex: none;
		border: 2px solid currentColor;
		border-top-color: transparent;
		border-radius: 50%;
		vertical-align: text-bottom;
		animation: spinner-turn 800ms linear infinite;
	}
	@keyframes spinner-turn {
		to { transform: rotate(360deg); }
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner { animation-duration: 2.4s; }
	}

	/* Outcome banners: a failure stays until dismissed or resolved, laid out
	   as message plus its Dismiss on one line. */
	.banner {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
		border-radius: 4px;
		padding: 4px 12px;
		margin: 8px 0;
		max-width: 640px;
	}
	.banner p { margin: 4px 0; }
	.banner-error {
		border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
		background: var(--vscode-inputValidation-errorBackground, transparent);
	}
	/* The tinted background plus border already carry the severity; red text
	   on the red errorBackground computes near 4:1 in Dark+ - marginal at
	   this size - so the banner's body stays on the plain foreground. */
	.banner-error, .banner-error .error { color: var(--vscode-foreground); }
	.banner-warn {
		border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
		background: var(--vscode-inputValidation-warningBackground, transparent);
	}

	/* Success toasts: bottom-right like the host's own notifications,
	   transient, always manually dismissible. */
	.toasts {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 60;
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: min(360px, calc(100vw - 32px));
	}
	.toast {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 6px 6px 12px;
		border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
		border-radius: 4px;
		background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
		color: var(--vscode-notifications-foreground, var(--vscode-foreground));
		box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
	}
	details { margin: 8px 0; }
	summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
	details[open] summary { margin-bottom: 4px; }
	details.fine-print { margin: 4px 0 8px; }
	details.fine-print summary { font-size: 0.9em; }
	details.fine-print p { margin: 4px 0 0; font-size: 0.9em; }
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
	/* A secret input with its Show/Hide toggle riding inside the field's
	   right edge, so the input's border lines up flush with every other
	   field in the form. */
	.secret-input { position: relative; display: flex; }
	.secret-input input { flex: 1; min-width: 0; padding-right: 52px; }
	.secret-input button { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); }
	/* The remove choice is destructive, not a third storage location: its own
	   line under the storage radios, reading in the error tone once armed. */
	.secret-remove {
		display: flex;
		gap: 6px;
		align-items: center;
		font-size: 0.9em;
		color: var(--vscode-descriptionForeground);
		grid-column: 2;
		cursor: pointer;
		width: max-content;
	}
	.secret-remove input[type="checkbox"] { flex: none; margin: 0; cursor: pointer; }
	.secret-remove.armed { color: var(--vscode-errorForeground); }

	.filterbar { display: flex; gap: 12px; align-items: baseline; margin: 8px 0; flex-wrap: wrap; }
	.filterbar input { min-width: 260px; }
	/* The active server scope as a chip beside the filter input: same quiet
	   chrome as a badge, plus its clear button riding inside. */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 2px 1px 8px;
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
		border-radius: 9px;
		font-size: 0.9em;
		white-space: nowrap;
	}
	.chip button { padding: 0 4px; }
	/* Landing target of the servers table's model-count links; the margin
	   keeps the heading clear of the sticky tab bar, and the programmatic
	   focus (a container, not a control) draws no ring. */
	#models-section { scroll-margin-top: 44px; outline: none; }

	.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
	.empty-block {
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		border-radius: 4px;
		padding: 8px 16px;
		margin: 8px 0;
	}
	.empty-block p { margin: 8px 0; }
	/* The guided start when no server is configured yet: a welcome, the three
	   steps in plain words, and the primary action - not a bare table. */
	.empty-start {
		max-width: 560px;
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
		border-radius: 4px;
		padding: 16px 24px 20px;
		margin: 16px 0;
		background: var(--vscode-editorWidget-background, transparent);
	}
	.empty-start h3 { margin: 0 0 4px; }
	.empty-start ol { margin: 8px 0 16px; padding-left: 20px; }
	.empty-start li { margin: 6px 0; }
	/* One-time informational callout (e.g. the post-adoption duplicate-group
	   note): quiet card, no alarm colors. */
	.notice {
		border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
		border-radius: 4px;
		padding: 8px 16px;
		margin: 8px 0;
		max-width: 640px;
		background: var(--vscode-editorWidget-background, transparent);
	}
	.notice p { margin: 4px 0; }
	ol.notice-steps { margin: 4px 0; padding-left: 20px; }
	ol.notice-steps li { margin: 2px 0; }
	.notice .toolbar { margin: 8px 0 0; }
	.skeleton { border-radius: 3px; background: var(--vscode-foreground); opacity: 0.12; }

	/* Narrow panels drop columns instead of demanding a horizontal scroll
	   toward off-screen actions. Media queries, not element observation: the
	   webview panel IS the viewport (the 960px main column only ever shrinks
	   with it), and the happy-dom suite could not measure widths anyway. Each
	   breakpoint is the width where the remaining column set stops fitting
	   the main column (viewport minus the body's 48px padding), from the
	   budget above: full set ~945px, then ~670, ~480, ~350. */
	@media (max-width: 1000px) {
		/* The most derivable columns go first: family is an ID prefix and the
		   token limits are capability detail, while pricing and capabilities
		   are what the table is scanned for. */
		table.models .col-family, table.models .col-input, table.models .col-output { display: none; }
	}
	@media (max-width: 780px) {
		table.models .model-name-text { max-width: 14em; }
		/* The servers table stacks into card-style blocks: rows carry actions
		   with no other route, so they must be reachable without horizontal
		   scrolling, and 780px is where the full row set stops fitting. */
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
	@media (max-width: 670px) {
		table.models .col-caps { display: none; }
	}
	@media (max-width: 560px) {
		table.models .col-price { display: none; }
		table.models .model-name-text { max-width: 12em; }
	}
	@media (max-width: 500px) {
		.field { grid-template-columns: 1fr; }
		.field .hint, .field .error, .field .secret-where, .field .secret-remove { grid-column: 1; }
		.field .hint { width: auto; max-width: none; }
		.secret-where { flex-wrap: wrap; white-space: normal; }
		.row { grid-template-columns: 1fr; }
		.row input.key, .row input.value, .row button, .row .error { grid-column: 1; }
		.row .cell.key, .row .cell.value { grid-column: 1; }
	}
`;

export function buildDashboardHtml(options: DashboardHtmlOptions): string {
	const nonce = escapeHtml(options.nonce);
	const cspSource = escapeHtml(options.cspSource);
	const scriptUri = escapeHtml(options.scriptUri);
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
		content="default-src 'none'; form-action 'none'; base-uri 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>LiteLLM Dashboard</title>
	<style>${STYLES}</style>
</head>
<body>
	<div id="root"></div>
	${bundleScript}<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
