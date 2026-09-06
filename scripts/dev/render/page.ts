/**
 * The rendered page: the dashboard shell assembled the way the webview host
 * does, the message-replay stub that stands in for the extension, the
 * determinism CSS, and the pinned measurement font faces.
 */
import { buildDashboardHtml } from "../../../src/extension/dashboard/html.ts";
import type { UiAccent, UiTheme } from "../../../src/shared/config/settingSpec.ts";
import { DEFAULT_UI_ACCENT, DEFAULT_UI_THEME } from "../../../src/shared/config/settingSpec.ts";
import { DASHBOARD_STYLESHEET_FILENAME } from "../../../src/shared/webviewPaths.ts";
import { RENDER_EPOCH_MS } from "../renderClock.ts";
import type { HostTheme } from "./hostThemes.ts";
import { inlineTokenStyle } from "./hostThemes.ts";

/** The reader's own two appearance settings, the vocabularies the shell stamps. */
export type AppTheme = UiTheme;

export type Accent = UiAccent;

/** JSON hardened for an inline script body, like html.ts's inlineScriptJson (which is module-private). */
function inlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/**
 * The acquireVsCodeApi stub: the page's {type:"ready"} post replays the
 * fixture's messages as window "message" events and flips window.__ready, and
 * every post lands in window.__posted for steps to inspect. It also freezes the
 * page's clock to RENDER_EPOCH_MS before the bundle loads, since relative-time
 * labels otherwise shift with the wall clock. Carrying the shell's nonce, it
 * doubles as the CSP violation collector: a component that only works without
 * the policy must fail here, not in the webview.
 */
function stubScript(nonce: string, messages: readonly unknown[], respond: Readonly<Record<string, unknown>>): string {
	return `<script nonce="${nonce}">
	window.__cspViolations = [];
	document.addEventListener("securitypolicyviolation", (event) => {
		window.__cspViolations.push(event.violatedDirective + " blocked " + (event.blockedURI || "inline"));
	});
	{
		const epoch = ${RENDER_EPOCH_MS};
		const RealDate = Date;
		// A Proxy rather than a subclass: it stays callable without new
		// (RealDate() semantics) and keeps Date.name and the statics intact.
		window.Date = new Proxy(RealDate, {
			construct(target, args) {
				return args.length === 0 ? new target(epoch) : new target(...args);
			},
			apply() {
				return new RealDate(epoch).toString();
			},
			get(target, key, receiver) {
				return key === "now" ? () => epoch : Reflect.get(target, key, receiver);
			},
		});
	}
	window.__fixtureMessages = ${inlineJson(messages)};
	window.__fixtureResponses = ${inlineJson(respond)};
	window.acquireVsCodeApi = () => ({
		postMessage(message) {
			window.__posted = window.__posted || [];
			window.__posted.push(message);
			if (message && message.kind === "request" && message.method === "ready") {
				// One message per frame, because that is how the editor delivers
				// them and because React has to COMMIT between them: a whole-list
				// dispatch let a focusSection reach app.tsx while the first state
				// push was still uncommitted, and the shot silently landed on the
				// wrong section - which no render can catch, since the PNG is
				// written and the right size. A bare setTimeout(0) is not enough
				// (React's Scheduler can still beat the commit); rAF resolves after
				// it, and the trailing timeout returns to a plain task.
				let next = 0;
				const pump = () => {
					if (next >= window.__fixtureMessages.length) {
						window.__ready = true;
						return;
					}
					window.dispatchEvent(new MessageEvent("message", { data: window.__fixtureMessages[next++] }));
					requestAnimationFrame(() => setTimeout(pump, 0));
				};
				pump();
			}
			// Canned request answers: fill the request's id and method into the
			// envelope template, like the extension's responders, asynchronously
			// so the page's own state update (the pending id) lands first.
			if (message && message.kind === "request" && message.id && window.__fixtureResponses[message.method]) {
				const data = Object.assign({}, window.__fixtureResponses[message.method], {
					id: message.id,
					method: message.method,
				});
				setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data })), 0);
			}
		},
		getState() {},
		setState() {},
	});
	</script>`;
}

/**
 * Always-on determinism styles: CSS animations, transitions, and the text
 * caret's blink phase depend on capture timing, so two renders of the same
 * fixture would differ pixel for pixel. Presentation is otherwise untouched.
 */
export const DETERMINISM_CSS =
	"*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/**
 * The scrollbar slice of VS Code's injected webview defaults: the editor
 * writes these into every webview document AHEAD of the extension's
 * stylesheets, inside @layer vscode-default, so any author rule beats them.
 * Current hosts inject the html scrollbar-color rule (read from the shipped
 * webview prelude, vs/workbench/contrib/webview/browser/pre/index.html): a
 * non-auto scrollbar-color inherits into every scroller, paints the track in
 * opaque editor-background, and DISABLES ::-webkit-scrollbar styling wholesale.
 * Older hosts injected the ::-webkit-scrollbar rules instead. Both halves are
 * emulated so a --show-scrollbars render proves the dashboard's own scrollbar
 * rules beat whichever the host injects.
 */
export const VSCODE_DEFAULT_CSS = `@layer vscode-default {
	html { scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); }
	::-webkit-scrollbar { width: 10px; height: 10px; }
	::-webkit-scrollbar-corner { background-color: var(--vscode-editor-background); }
	::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); }
	::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
	::-webkit-scrollbar-thumb:active { background-color: var(--vscode-scrollbarSlider-activeBackground); }
}`;

/**
 * The measurement-mode font pin. Every measurement run (--widths or
 * --pane-widths) swaps the font tokens - the host pair and Tailwind's - for
 * these faces, whose ascent/descent/line-gap overrides make every line-box
 * metric a fixed fraction of the font size: heights measure the same on every
 * platform, so a green sweep on macOS predicts the Linux-only CI gate (the
 * host's mono fallback once rounded a mixed sans+mono line box 1px taller
 * there).
 * Screenshot runs (--out alone) keep the native stacks: design review judges
 * the host's fonts, measurement judges the pinned ones. Horizontal metrics
 * cannot be overridden in CSS, so the local() chains allow only faces with
 * IDENTICAL advance widths by design (Liberation Sans carries Arial's,
 * Liberation Mono carries Courier New's) and the engagement control measures
 * a reference string against those advances: a platform resolving anything
 * else fails the run loudly instead of measuring different wrap points. The
 * divergent faces are the same sources with deliberately different vertical
 * metrics - same advances, so a swap changes ONLY the metrics - for
 * check-geometry's probe that a text-bearing slot's height does not depend
 * on font metrics at all.
 */
const PINNED_SANS_SOURCES = `local("Arial"), local("Liberation Sans")`;

const PINNED_MONO_SOURCES = `local("Courier New"), local("Liberation Mono")`;

/** Near Arial's real metrics, so pinning moves today's measurements as little as possible. */
const PINNED_FONT_METRICS = { ascent: 90, descent: 22 };

const DIVERGENT_FONT_METRICS = { ascent: 160, descent: 40 };

/** What a line-height: normal line box must measure under each face, at 100px font size. */
export const PINNED_CONTROL_PX = PINNED_FONT_METRICS.ascent + PINNED_FONT_METRICS.descent;

export const DIVERGENT_CONTROL_PX = DIVERGENT_FONT_METRICS.ascent + DIVERGENT_FONT_METRICS.descent;

/** The advance-width control: this string at 100px must measure the faces' shared design advances. */
export const ADVANCE_CONTROL_TEXT = "Illustrative Mix 0123456789";

/** Arial's design advances for the string (Liberation Sans carries the same by design). */
export const ADVANCE_CONTROL_SANS_PX = 1217.39;

/** Courier New and Liberation Mono advance every glyph 1229/2048 em (~0.6); the tolerance absorbs the remainder. */
export const ADVANCE_CONTROL_MONO_PX = ADVANCE_CONTROL_TEXT.length * 60;

/** Advances are design-identical; the slack only absorbs rasterizer rounding. */
export const ADVANCE_TOLERANCE_PX = 1;

function fontFace(family: string, sources: string, metrics: { ascent: number; descent: number }): string {
	return (
		`@font-face { font-family: ${family}; src: ${sources}; ascent-override: ${metrics.ascent}%; ` +
		`descent-override: ${metrics.descent}%; line-gap-override: 0%; }`
	);
}

export function measurementFontCss(): string {
	return [
		fontFace("geometry-pinned-sans", PINNED_SANS_SOURCES, PINNED_FONT_METRICS),
		fontFace("geometry-pinned-mono", PINNED_MONO_SOURCES, PINNED_FONT_METRICS),
		fontFace("geometry-divergent-sans", PINNED_SANS_SOURCES, DIVERGENT_FONT_METRICS),
		fontFace("geometry-divergent-mono", PINNED_MONO_SOURCES, DIVERGENT_FONT_METRICS),
	].join("\n");
}

/**
 * The flags decide the appearance VALUES, not the fixture: the webview restamps
 * the root element from every state push, so a fixture's own theme and accent
 * would overwrite the shell's stamp and render every --app-theme and --accent
 * as the default. The two SCOPES ride through instead, because nothing stamps
 * them and they are what draws a row's modified marker and offers its Reset.
 */
export function withAppearance(messages: readonly unknown[], theme: AppTheme, accent: Accent): readonly unknown[] {
	// The scope a forced non-default value implies - such a value only exists
	// BECAUSE some scope wrote it - as "global", where the dashboard writes. Both
	// arms normalize to null because the row tests `!== null`, so an absent scope
	// would otherwise render as configured.
	const forcedScope = (value: string, fallback: string, scope: unknown): unknown =>
		value === fallback ? (scope ?? null) : (scope ?? "global");
	return messages.map((message) => {
		const push = message as { kind?: unknown; state?: { settings?: { appearance?: Record<string, unknown> } } };
		if (push.kind !== "push" || push.state?.settings === undefined) {
			return message;
		}
		const appearance = push.state.settings.appearance ?? {};
		return {
			...push,
			state: {
				...push.state,
				settings: {
					...push.state.settings,
					appearance: {
						...appearance,
						theme,
						accent,
						themeScope: forcedScope(theme, DEFAULT_UI_THEME, appearance.themeScope),
						accentScope: forcedScope(accent, DEFAULT_UI_ACCENT, appearance.accentScope),
					},
				},
			},
		};
	});
}

/**
 * The standalone page: the real HTML shell, CSP meta included with file: as the
 * style source so the policy is enforced exactly as the webview enforces it,
 * plus the harness.css link (inline style tags would violate that policy) and
 * the acquireVsCodeApi stub, which precedes the bundle tag so it exists when
 * the bundle's module scope calls it.
 */
export function buildPageHtml(
	messages: readonly unknown[],
	respond: Readonly<Record<string, unknown>>,
	hostTheme: HostTheme,
	forcedTheme: AppTheme,
	accent: Accent,
	tokensCss: string
): string {
	const nonce = "dev-nonce";
	let html = buildDashboardHtml({
		cspSource: "file:",
		nonce,
		scriptUri: "./dashboard.js",
		styleUri: `./${DASHBOARD_STYLESHEET_FILENAME}`,
		language: "en",
		l10nBundle: undefined,
		theme: forcedTheme,
		accent,
	});
	// The editor injects its defaults before the extension's stylesheets; the
	// emulation keeps that order so the layer cascade matches the webview's.
	const dashboardLink = `<link rel="stylesheet" href="./${DASHBOARD_STYLESHEET_FILENAME}">`;
	if (!html.includes(dashboardLink)) {
		throw new Error("Unexpected dashboard HTML shape: the stylesheet link was not found");
	}
	html = html.replace(dashboardLink, `<link rel="stylesheet" href="./vscode-default.css">\n\t${dashboardLink}`);
	html = html.replace("</head>", `<link rel="stylesheet" href="./harness.css">\n</head>`);
	if (tokensCss !== "") {
		const attribute = inlineTokenStyle(tokensCss).replaceAll('"', "&quot;");
		if (!html.includes("<html ")) {
			throw new Error("Unexpected dashboard HTML shape: no <html> element to carry the host's token styles");
		}
		html = html.replace("<html ", `<html style="${attribute}" `);
	}
	// VS Code stamps the theme kind onto the body, and theme.css keys its
	// contrast overrides off that class. HC light carries both classes, exactly
	// as the host's applyStyles does, so a rule keyed on only one of them cannot
	// behave differently here than in the editor.
	const bodyClass = {
		dark: "vscode-dark",
		light: "vscode-light",
		"high-contrast": "vscode-high-contrast",
		"high-contrast-light": "vscode-high-contrast-light vscode-high-contrast",
		"forced-colors": "vscode-high-contrast",
	}[hostTheme];
	if (!html.includes("<body>")) {
		throw new Error("Unexpected dashboard HTML shape: no bare <body> to stamp the theme class onto");
	}
	html = html.replace("<body>", `<body class="${bodyClass}">`);
	const bundleTag = `<script nonce="${nonce}" src="./dashboard.js"></script>`;
	if (!html.includes(bundleTag)) {
		throw new Error("Unexpected dashboard HTML shape: the bundle script tag was not found");
	}
	return html.replace(bundleTag, `${stubScript(nonce, messages, respond)}\n\t${bundleTag}`);
}
