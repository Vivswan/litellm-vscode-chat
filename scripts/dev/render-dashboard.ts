/**
 * Dev-only visual render harness: screenshots the dashboard webview through
 * headless Chrome without launching VS Code (see usage() for the flags,
 * CHROME_BIN for Chrome discovery). Deliberately no pixel baseline. What it
 * does enforce: the page runs under the shell's real CSP and any violation
 * fails the render, the scroll offset is pinned before a full-page capture so
 * renders reproduce, and every run asserts the page does not scroll sideways at
 * the width it was shot at. When the harness and the editor disagree about how
 * the page is assembled, fix the harness FIRST: what this file emulates is a
 * claim about the editor, and a wrong claim certifies bugs absent.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDashboardHtml } from "../../src/extension/dashboard/html.ts";
import type { UiAccent, UiTheme } from "../../src/shared/config/settingSpec.ts";
import { DEFAULT_UI_ACCENT, DEFAULT_UI_THEME, UI_ACCENTS, UI_THEMES } from "../../src/shared/config/settingSpec.ts";
import {
	DASHBOARD_BUNDLE_FILENAME,
	DASHBOARD_STYLESHEET_FILENAME,
	WEBVIEW_DIST_SEGMENTS,
} from "../../src/shared/webviewPaths.ts";
import { RENDER_EPOCH_MS } from "./renderClock.ts";

/** Every host theme a render can emulate; the fixture field, page builder and flag parser all read this. */
const HOST_THEMES = ["dark", "light", "high-contrast", "high-contrast-light", "forced-colors"] as const;
type HostTheme = (typeof HOST_THEMES)[number];

/** The kinds of surface a host theme paints, which is what the wash scale keys off. */
const LIGHT_HOST_THEMES: ReadonlySet<HostTheme> = new Set<HostTheme>(["light", "high-contrast-light"]);

/** The reader's own two appearance settings, the vocabularies the shell stamps. */
type AppTheme = UiTheme;
type Accent = UiAccent;

/** What a fixture module default-exports; `messages` are ExtensionToWebviewMessage objects. */
export interface RenderFixture {
	/** Delivered to the page as window "message" events once it posts its ready request. */
	readonly messages: readonly unknown[];
	/** JS expressions evaluated in the page after the messages settle (awaited when they return promises). */
	readonly steps?: readonly string[];
	readonly viewport?: { readonly width: number; readonly height: number };
	/**
	 * Capture the viewport alone, as `--clip-viewport` does. Required when the
	 * fixture's subject IS the viewport edge - anything measuring against it or
	 * flipping away from it - because a full-page capture expands the viewport
	 * until the edge is not there.
	 */
	readonly clipViewport?: boolean;
	/** How long to wait after the ready handshake before steps and capture; default 300. */
	readonly settleMs?: number;
	/**
	 * Opts the fixture out of the width sweep, keeping the assertion at its own
	 * width. For a fixture whose state was MEASURED when it was built: a chip
	 * popover picks its side by measuring its anchor at open time, so narrowing
	 * afterwards leaves it on a side the component would never have chosen.
	 * Narrow behaviour belongs to a fixture opened AT the narrow width.
	 */
	readonly measuredAtOwnWidth?: boolean;
	/**
	 * The host theme the page emulates: the token set in harness.css plus the
	 * body class VS Code stamps. The two high-contrast kinds raise
	 * prefers-contrast; "forced-colors" adds forced-colors: active on top of HC
	 * dark, the way an OS high-contrast mode overrides author colors.
	 */
	readonly hostTheme?: HostTheme;
	/**
	 * Canned answers for posted requests: a request whose `method` matches a key
	 * gets the mapped envelope template dispatched back with its `id` and
	 * `method` filled in (the correlation the real extension performs). One
	 * template per method.
	 */
	readonly respond?: Readonly<Record<string, unknown>>;
}

const REPO_ROOT = path.resolve(__dirname, "../..");
/**
 * Where a --pane-widths search starts, from each side of the rail's collapse.
 * Starting points only - the search corrects itself from what it measures.
 */
const NARROW_PROBE_WIDTH = 320;
const WIDE_PROBE_WIDTH = 1920;
const READY_TIMEOUT_MS = 15000;
/**
 * Launch is the one phase that retries: on a loaded CI runner several Chromes
 * starting at once can starve each other past READY_TIMEOUT_MS, which says
 * nothing about the page. Anything after the DevTools server is up is a finding
 * about the code, and retrying it would mask nondeterminism instead of noise.
 */
const LAUNCH_ATTEMPTS = 3;
const MIN_PNG_BYTES = 10 * 1024;

function usage(): never {
	console.error(
		"usage: bun scripts/dev/render-dashboard.ts --fixture <fixture.ts> (--out <shot.png> | --widths N,N)" +
			" [--pane-widths N,N] [--width N] [--height N] [--theme <host theme>] [--dpr N]" +
			" [--accent blue|violet|teal|amber] [--app-theme auto|light|dark]" +
			" [--hover <css selector>] [--focus <css selector>] [--contrast <css selector>] [--contrast-large]" +
			" [--clip-viewport] [--html-out <page.html>] [--no-theme]"
	);
	process.exit(1);
}

/**
 * The VS Code Dark Modern theme tokens, approximated so a plain Chrome page
 * renders like the webview. Presentation aid only; --no-theme disables it.
 */
function themeCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #cccccc;
		--vscode-descriptionForeground: #9d9d9d;
		--vscode-editor-background: #1f1f1f;
		--vscode-panel-background: #181818;
		--vscode-editorWidget-background: #202020;
		--vscode-widget-border: #313131;
		--vscode-widget-shadow: rgba(0, 0, 0, 0.36);
		--vscode-focusBorder: #0078d4;
		--vscode-errorForeground: #f85149;
		--vscode-editorWarning-foreground: #cca700;
		--vscode-notificationsWarningIcon-foreground: #cca700;
		--vscode-testing-iconPassed: #73c991;
		--vscode-charts-green: #89d185;
		--vscode-charts-yellow: #cca700;
		--vscode-list-hoverBackground: #2a2d2e;
		--vscode-toolbar-hoverBackground: #5a5d5e50;
		--vscode-textLink-foreground: #4daafc;
		--vscode-textLink-activeForeground: #4daafc;
		--vscode-textCodeBlock-background: #2b2b2b;
		--vscode-panelTitle-activeForeground: #cccccc;
		--vscode-panelTitle-inactiveForeground: #9d9d9d;
		--vscode-panelTitle-activeBorder: #0078d4;
		--vscode-input-background: #313131;
		--vscode-input-foreground: #cccccc;
		--vscode-input-border: #3c3c3c;
		--vscode-input-placeholderForeground: #989898;
		--vscode-inputValidation-errorBackground: #5a1d1d;
		--vscode-inputValidation-errorBorder: #be1100;
		--vscode-inputValidation-warningBackground: #352a05;
		--vscode-inputValidation-warningBorder: #b89500;
		--vscode-button-background: #0078d4;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #ffffff1a;
		--vscode-button-hoverBackground: #026ec1;
		--vscode-button-secondaryBackground: #00000000;
		--vscode-button-secondaryForeground: #cccccc;
		--vscode-button-secondaryHoverBackground: #2b2b2b;
		--vscode-editorHoverWidget-background: #202020;
		--vscode-editorHoverWidget-foreground: #cccccc;
		--vscode-editorHoverWidget-border: #cccccc33;
		--vscode-notifications-background: #1f1f1f;
		--vscode-notifications-foreground: #cccccc;
		--vscode-notifications-border: #2b2b2b;
		--vscode-charts-red: #f14c4c;
		--vscode-disabledForeground: #cccccc80;
		--vscode-editorWidget-border: #cccccc33;
		--vscode-editorWidget-foreground: #cccccc;
		--vscode-list-hoverForeground: #cccccc;
		--vscode-panel-border: #2b2b2b;
		--vscode-progressBar-background: #0078d4;
		--vscode-statusBarItem-errorBackground: #b90f07;
		--vscode-statusBarItem-errorForeground: #ffffff;
		--vscode-textBlockQuote-background: #2b2b2b;
		--vscode-dropdown-background: #313131;
		--vscode-dropdown-foreground: #cccccc;
		--vscode-dropdown-border: #3c3c3c;
		--vscode-settings-modifiedItemIndicator: #bb800966;
	}
	`;
}

/**
 * The VS Code Light Modern tokens, over the same key set as the dark tokens
 * above: a token one theme defines and the other omits would read as a design
 * difference when it is really a gap in this file.
 */
function lightCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #3b3b3b;
		--vscode-descriptionForeground: #3b3b3b;
		--vscode-editor-background: #ffffff;
		--vscode-panel-background: #f8f8f8;
		--vscode-editorWidget-background: #f8f8f8;
		--vscode-widget-border: #e5e5e5;
		--vscode-widget-shadow: rgba(0, 0, 0, 0.16);
		--vscode-focusBorder: #005fb8;
		--vscode-errorForeground: #f85149;
		--vscode-editorWarning-foreground: #bf8803;
		--vscode-notificationsWarningIcon-foreground: #bf8803;
		--vscode-testing-iconPassed: #73c991;
		--vscode-charts-green: #388a34;
		--vscode-charts-yellow: #bf8803;
		--vscode-list-hoverBackground: #f2f2f2;
		--vscode-toolbar-hoverBackground: #b8b8b850;
		--vscode-textLink-foreground: #005fb8;
		--vscode-textLink-activeForeground: #005fb8;
		--vscode-textCodeBlock-background: #f8f8f8;
		--vscode-panelTitle-activeForeground: #3b3b3b;
		--vscode-panelTitle-inactiveForeground: #3b3b3b;
		--vscode-panelTitle-activeBorder: #005fb8;
		--vscode-input-background: #ffffff;
		--vscode-input-foreground: #3b3b3b;
		--vscode-input-border: #cecece;
		--vscode-input-placeholderForeground: #767676;
		--vscode-inputValidation-errorBackground: #f2dede;
		--vscode-inputValidation-errorBorder: #be1100;
		--vscode-inputValidation-warningBackground: #f6f5d2;
		--vscode-inputValidation-warningBorder: #b89500;
		--vscode-button-background: #005fb8;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #0000001a;
		--vscode-button-hoverBackground: #0258a8;
		--vscode-button-secondaryBackground: #e5e5e5;
		--vscode-button-secondaryForeground: #3b3b3b;
		--vscode-button-secondaryHoverBackground: #cccccc;
		--vscode-editorHoverWidget-background: #f8f8f8;
		--vscode-editorHoverWidget-foreground: #3b3b3b;
		--vscode-editorHoverWidget-border: #3b3b3b33;
		--vscode-notifications-background: #ffffff;
		--vscode-notifications-foreground: #3b3b3b;
		--vscode-notifications-border: #e5e5e5;
		--vscode-charts-red: #e51400;
		--vscode-disabledForeground: #61616180;
		--vscode-editorWidget-border: #3b3b3b33;
		--vscode-editorWidget-foreground: #3b3b3b;
		--vscode-list-hoverForeground: #3b3b3b;
		--vscode-panel-border: #e5e5e5;
		--vscode-progressBar-background: #005fb8;
		--vscode-statusBarItem-errorBackground: #c72e0f;
		--vscode-statusBarItem-errorForeground: #ffffff;
		--vscode-textBlockQuote-background: #f8f8f8;
		--vscode-dropdown-background: #ffffff;
		--vscode-dropdown-foreground: #3b3b3b;
		--vscode-dropdown-border: #cecece;
		--vscode-settings-modifiedItemIndicator: #bb800966;
	}
	`;
}

/**
 * The VS Code Dark High Contrast tokens, from the workbench color registry's
 * hcDark defaults. Deliberately sparse where the real theme is: secondary
 * backgrounds and list hover colors are genuinely null there, so the fallback
 * chains and theme.css's contrast overrides are what render. button.background
 * IS set - black, the whole reason theme.css cannot read an accent off it.
 */
function highContrastCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #ffffff;
		--vscode-descriptionForeground: #ffffffb3;
		--vscode-disabledForeground: #a5a5a5;
		--vscode-editor-background: #000000;
		--vscode-panel-background: #000000;
		--vscode-editorWidget-background: #0c141f;
		--vscode-widget-border: #6fc3df;
		--vscode-contrastBorder: #6fc3df;
		--vscode-contrastActiveBorder: #f38518;
		--vscode-focusBorder: #f38518;
		--vscode-errorForeground: #f48771;
		--vscode-editorWarning-foreground: #ffd370;
		--vscode-testing-iconPassed: #73c991;
		--vscode-textLink-foreground: #21a6ff;
		--vscode-textLink-activeForeground: #21a6ff;
		--vscode-textCodeBlock-background: #000000;
		--vscode-panelTitle-activeForeground: #ffffff;
		--vscode-panelTitle-inactiveForeground: #ffffff;
		--vscode-panelTitle-activeBorder: #6fc3df;
		--vscode-input-background: #000000;
		--vscode-input-foreground: #ffffff;
		--vscode-input-border: #6fc3df;
		--vscode-input-placeholderForeground: #ffffffb3;
		--vscode-inputValidation-errorBackground: #000000;
		--vscode-inputValidation-errorBorder: #f48771;
		--vscode-button-background: #000000;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #6fc3df;
		--vscode-editorHoverWidget-background: #0c141f;
		--vscode-editorHoverWidget-foreground: #ffffff;
		--vscode-editorHoverWidget-border: #6fc3df;
		--vscode-notifications-background: #000000;
		--vscode-notifications-foreground: #ffffff;
		--vscode-notifications-border: #6fc3df;
		--vscode-dropdown-background: #000000;
		--vscode-dropdown-foreground: #ffffff;
		--vscode-dropdown-border: #6fc3df;
	}
	`;
}

/**
 * The VS Code Light High Contrast tokens, from the registry's hcLight defaults.
 * Its own combination, and an unrenderable state is one nobody checks:
 * theme.css keys the wash scale off body.vscode-high-contrast-light, a class no
 * other render produces.
 */
function highContrastLightCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #292929;
		--vscode-descriptionForeground: #292929b3;
		--vscode-disabledForeground: #7f7f7f;
		--vscode-editor-background: #ffffff;
		--vscode-panel-background: #ffffff;
		--vscode-editorWidget-background: #ffffff;
		--vscode-widget-border: #0f4a85;
		--vscode-contrastBorder: #0f4a85;
		--vscode-contrastActiveBorder: #006bbd;
		--vscode-focusBorder: #006bbd;
		--vscode-errorForeground: #b5200d;
		--vscode-editorWarning-foreground: #895503;
		--vscode-testing-iconPassed: #007100;
		--vscode-textLink-foreground: #0f4a85;
		--vscode-textLink-activeForeground: #0f4a85;
		--vscode-textCodeBlock-background: #f2f2f2;
		--vscode-panelTitle-activeForeground: #292929;
		--vscode-panelTitle-inactiveForeground: #292929;
		--vscode-panelTitle-activeBorder: #b5200d;
		--vscode-input-background: #ffffff;
		--vscode-input-foreground: #292929;
		--vscode-input-border: #0f4a85;
		--vscode-input-placeholderForeground: #292929b3;
		--vscode-inputValidation-errorBackground: #ffffff;
		--vscode-inputValidation-errorBorder: #0f4a85;
		--vscode-button-background: #0f4a85;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #0f4a85;
		--vscode-editorHoverWidget-background: #ffffff;
		--vscode-editorHoverWidget-foreground: #292929;
		--vscode-editorHoverWidget-border: #0f4a85;
		--vscode-notifications-background: #ffffff;
		--vscode-notifications-foreground: #292929;
		--vscode-notifications-border: #0f4a85;
		--vscode-dropdown-background: #ffffff;
		--vscode-dropdown-foreground: #292929;
		--vscode-dropdown-border: #0f4a85;
	}
	`;
}

/**
 * Every --vscode-* token the stylesheet reads must be defined by the ORDINARY
 * themes: VS Code hands the real webview a full token set, so a token omitted
 * here falls back to whatever literal the stylesheet carries, and those
 * literals were written against dark. High contrast is exempt on purpose - the
 * real HC themes leave those values null, so its sparseness IS the fidelity -
 * and contrast-only tokens are exempt everywhere, since the ordinary themes do
 * not define them and the stylesheet reads them behind a fallback.
 */
const CONTRAST_ONLY_TOKENS = new Set(["--vscode-contrastBorder", "--vscode-contrastActiveBorder"]);

function assertThemeCoversStylesheet(stylesheet: string, tokensCss: string, hostTheme: string): void {
	const referenced = new Set([...stylesheet.matchAll(/var\((--vscode-[A-Za-z0-9-]+)/g)].map((match) => match[1]));
	const defined = new Set([...tokensCss.matchAll(/(--vscode-[A-Za-z0-9-]+)\s*:/g)].map((match) => match[1]));
	const missing = [...referenced].filter((token) => !defined.has(token) && !CONTRAST_ONLY_TOKENS.has(token)).sort();
	if (missing.length > 0) {
		throw new Error(
			`The ${hostTheme} token set omits ${missing.length} token(s) the stylesheet reads, so the render would` +
				` show the stylesheet's own fallbacks instead of the theme: ${missing.join(", ")}`
		);
	}
}

/**
 * The host's token delivery, reproduced exactly: VS Code writes --vscode-* one
 * by one onto the document element's inline style (webview/browser/pre/
 * index.html, applyStyles), not into a stylesheet. An inline declaration
 * outranks every author rule on the same element, so a stylesheet rule that
 * redefines a host token loses in the editor and would win here.
 */
function inlineTokenStyle(tokensCss: string): string {
	const declarations = [...tokensCss.matchAll(/(--vscode-[A-Za-z0-9-]+):\s*([^;]+);/g)].map(
		(match) => `${match[1]}: ${match[2]?.trim()}`
	);
	if (declarations.length === 0) {
		throw new Error("The token set produced no --vscode-* declarations; the render would show no theme at all");
	}
	return `${declarations.join("; ")};`;
}

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

function findChrome(): string {
	const fromEnv = process.env.CHROME_BIN;
	if (fromEnv !== undefined && fromEnv.length > 0) {
		if (!existsSync(fromEnv)) {
			throw new Error(`CHROME_BIN points at ${fromEnv}, which does not exist`);
		}
		return fromEnv;
	}
	const absoluteCandidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	];
	for (const candidate of absoluteCandidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	for (const name of ["chromium", "google-chrome", "google-chrome-stable", "chrome"]) {
		const which = spawnSync("which", [name], { encoding: "utf8" });
		if (which.status === 0) {
			const resolved = which.stdout.trim();
			if (resolved.length > 0) {
				return resolved;
			}
		}
	}
	throw new Error(
		"No Chrome found. Install Google Chrome or Chromium, or point CHROME_BIN at a Chrome binary" +
			" (tried the macOS app paths and chromium/google-chrome/google-chrome-stable/chrome on PATH)."
	);
}

/**
 * Chrome writes "<port>\n<browser ws path>" here once the DevTools server is
 * up. A Chrome that DIED on startup is not a slow one, so its exit ends the
 * wait immediately: otherwise a systematic launch failure (a forbidden sandbox,
 * a missing library) would spend the full deadline once per attempt per
 * fixture, and the sweep would hit its CI job timeout instead of reporting
 * which fixtures never ran.
 */
async function waitForDevtoolsPort(chrome: ChildProcess, userDataDir: string, timeoutMs: number): Promise<number> {
	const portFile = path.join(userDataDir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const port = Number((await fs.readFile(portFile, "utf8")).split("\n")[0]);
			if (Number.isInteger(port) && port > 0) {
				return port;
			}
		} catch {
			// Not written yet.
		}
		// Read AFTER the file check, so a Chrome that wrote the port and exited
		// in the same breath is still believed about the port.
		if (chrome.exitCode !== null || chrome.signalCode !== null) {
			throw new Error(
				`Chrome exited (code ${chrome.exitCode ?? "none"}, signal ${chrome.signalCode ?? "none"})` +
					` without writing ${portFile}`
			);
		}
		await delay(100);
	}
	throw new Error(`Chrome did not write ${portFile} within ${timeoutMs}ms`);
}

/**
 * Whether this platform has POSIX process groups. Windows does not: a
 * negative-pid probe reports ESRCH for a live Chrome there, and reading that as
 * "group gone" would skip the kill entirely.
 */
const CAN_SIGNAL_PROCESS_GROUP = process.platform !== "win32";

/**
 * Ends a Chrome by its whole process group, SIGTERM then SIGKILL: a launch
 * killed mid-startup can leave renderer and GPU children the browser process
 * never got around to owning. Liveness is judged on the GROUP, not the leader,
 * because those children can outlive the browser process - precisely the leak
 * this hunts. Where group signalling does not exist or fails, the direct handle
 * and its exit or signal code are the fallback.
 */
async function killChromeTree(chrome: ChildProcess): Promise<void> {
	// A spawn that never produced a pid has nothing to kill and reports neither
	// an exit code nor a signal, so the loop below would poll out its whole
	// grace period to signal nobody.
	if (chrome.pid === undefined) {
		return;
	}
	const leaderGone = (): boolean => chrome.exitCode !== null || chrome.signalCode !== null;
	const groupGone = (): boolean => {
		if (CAN_SIGNAL_PROCESS_GROUP && chrome.pid !== undefined) {
			try {
				process.kill(-chrome.pid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					return true;
				}
				// Probing failed some other way; the leader is the best signal left.
			}
		}
		return leaderGone();
	};
	const signalTree = (signal: NodeJS.Signals): void => {
		if (CAN_SIGNAL_PROCESS_GROUP && chrome.pid !== undefined) {
			try {
				process.kill(-chrome.pid, signal);
				return;
			} catch {
				// The group is gone or unaddressable; fall through to the handle.
			}
		}
		chrome.kill(signal);
	};
	if (groupGone()) {
		return;
	}
	signalTree("SIGTERM");
	const deadline = Date.now() + 2000;
	while (!groupGone() && Date.now() < deadline) {
		await delay(50);
	}
	if (!groupGone()) {
		signalTree("SIGKILL");
	}
}

/**
 * Launches Chrome and waits for its DevTools server, relaunching one that never
 * got there. Each attempt gets a FRESH profile directory, because the killed
 * attempt leaves a half-written one (SingletonLock included) behind; they live
 * under the caller's tmpRoot, so its one removal sweeps every attempt.
 * `onSpawn` hands the caller each attempt's process so a cancellation mid-wait
 * has something to kill, and `stopped` is read before every spawn with no await
 * in between: a cancellation that landed BETWEEN attempts already ran its
 * cleanup, and a relaunch after it would be a Chrome nothing kills.
 */
async function launchChrome(
	chromeBin: string,
	tmpRoot: string,
	flags: readonly string[],
	pageUrl: string,
	onSpawn: (chrome: ChildProcess) => void,
	stopped: () => boolean
): Promise<{ chrome: ChildProcess; port: number }> {
	for (let attempt = 1; ; attempt++) {
		const profileDir = path.join(tmpRoot, `profile-${attempt}`);
		await fs.mkdir(profileDir);
		if (stopped()) {
			throw new Error("Launch cancelled by a termination signal");
		}
		const chrome = spawn(chromeBin, [...flags, `--user-data-dir=${profileDir}`, pageUrl], {
			stdio: "ignore",
			// Its own process group where groups exist, so killChromeTree can
			// signal the whole tree.
			detached: CAN_SIGNAL_PROCESS_GROUP,
			env: { ...process.env, TZ: "UTC", LANG: "en_US.UTF-8" },
		});
		onSpawn(chrome);
		try {
			const port = await waitForDevtoolsPort(chrome, profileDir, READY_TIMEOUT_MS);
			return { chrome, port };
		} catch (error) {
			await killChromeTree(chrome);
			if (attempt >= LAUNCH_ATTEMPTS) {
				throw error;
			}
			console.log(
				`chrome launch ${attempt}/${LAUNCH_ATTEMPTS} brought up no DevTools server` +
					` (${error instanceof Error ? error.message : String(error)}); relaunching with a fresh profile`
			);
		}
	}
}

interface DevtoolsTarget {
	readonly type?: string;
	readonly url?: string;
	readonly webSocketDebuggerUrl?: string;
}

async function findPageTargetUrl(port: number, pageUrl: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = (await response.json()) as readonly DevtoolsTarget[];
			const page = targets.find((target) => target.type === "page" && target.url === pageUrl);
			if (page?.webSocketDebuggerUrl !== undefined) {
				return page.webSocketDebuggerUrl;
			}
		} catch {
			// DevTools HTTP endpoint not ready yet.
		}
		await delay(100);
	}
	throw new Error(`Chrome never listed a page target for ${pageUrl} within ${timeoutMs}ms`);
}

/** A minimal DevTools protocol client over Chrome's page WebSocket: send a method, await its result. */
class CdpConnection {
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private nextId = 1;

	private constructor(private readonly socket: WebSocket) {}

	static connect(url: string): Promise<CdpConnection> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			const connection = new CdpConnection(socket);
			socket.addEventListener("open", () => resolve(connection));
			socket.addEventListener("error", () => {
				reject(new Error(`DevTools WebSocket connection to ${url} failed`));
				connection.rejectPending(new Error("DevTools WebSocket errored"));
			});
			socket.addEventListener("message", (event) => connection.onMessage(String(event.data)));
			// A Chrome that dies mid-session must fail every in-flight command,
			// not leave its awaiter hanging forever.
			socket.addEventListener("close", () => connection.rejectPending(new Error("DevTools WebSocket closed")));
		});
	}

	private rejectPending(error: Error): void {
		for (const waiter of this.pending.values()) {
			waiter.reject(error);
		}
		this.pending.clear();
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	private onMessage(text: string): void {
		const message = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
		if (message.id === undefined) {
			return; // Protocol events; the harness only awaits command results.
		}
		const waiter = this.pending.get(message.id);
		if (waiter === undefined) {
			return;
		}
		this.pending.delete(message.id);
		if (message.error !== undefined) {
			waiter.reject(new Error(message.error.message ?? "DevTools command failed"));
		} else {
			waiter.resolve(message.result);
		}
	}

	close(): void {
		this.socket.close();
	}
}

interface EvaluateResult {
	readonly result?: { readonly value?: unknown };
	readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string } };
}

async function evaluate(cdp: CdpConnection, expression: string, awaitPromise = false): Promise<unknown> {
	const raw = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise })) as EvaluateResult;
	if (raw.exceptionDetails !== undefined) {
		const reason = raw.exceptionDetails.exception?.description ?? raw.exceptionDetails.text ?? "unknown error";
		throw new Error(`Page evaluation failed: ${reason}\n  in: ${expression}`);
	}
	return raw.result?.value;
}

async function loadFixture(fixturePath: string): Promise<RenderFixture> {
	const absolute = path.resolve(fixturePath);
	if (!existsSync(absolute)) {
		throw new Error(`Fixture not found: ${absolute}`);
	}
	const module = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
	const fixture = module.default;
	if (typeof fixture !== "object" || fixture === null || !Array.isArray((fixture as RenderFixture).messages)) {
		throw new Error(`Fixture ${absolute} must default-export { messages: unknown[]; steps?; viewport?; settleMs? }`);
	}
	return fixture as RenderFixture;
}

/**
 * Whether the built bundle predates any source it is built from. A stale bundle
 * makes the render evidence about the code as it WAS, silently and with
 * byte-identical output across a real change. Directories count as roots too,
 * because a deletion touches the parent and nothing else.
 */
function bundleIsStale(bundlePath: string, stylesheetPath: string): boolean {
	const built = Math.min(mtimeOf(bundlePath), mtimeOf(stylesheetPath));
	const roots = ["webview", "dashboard", "shared"].map((tree) => path.join(REPO_ROOT, "src", tree));
	return roots.some((root) => existsSync(root) && newestMtime(root) > built);
}

/** A path's mtime, or 0 for one that vanished under the walk (its parent directory carries the change). */
function mtimeOf(target: string): number {
	try {
		return statSync(target).mtimeMs;
	} catch {
		return 0;
	}
}

function newestMtime(dir: string): number {
	let latest = mtimeOf(dir);
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		latest = Math.max(latest, entry.isDirectory() ? newestMtime(full) : mtimeOf(full));
	}
	return latest;
}

async function ensureBundle(): Promise<{ bundlePath: string; stylesheetPath: string }> {
	const distDir = path.join(REPO_ROOT, ...WEBVIEW_DIST_SEGMENTS);
	const bundlePath = path.join(distDir, DASHBOARD_BUNDLE_FILENAME);
	const stylesheetPath = path.join(distDir, DASHBOARD_STYLESHEET_FILENAME);
	if (!existsSync(bundlePath) || !existsSync(stylesheetPath) || bundleIsStale(bundlePath, stylesheetPath)) {
		console.log(`${bundlePath} or ${stylesheetPath} missing or stale; running bun run bundle:dev`);
		const build = spawnSync("bun", ["run", "bundle:dev"], { cwd: REPO_ROOT, stdio: "inherit" });
		if (build.status !== 0 || !existsSync(bundlePath) || !existsSync(stylesheetPath)) {
			throw new Error("bun run bundle:dev did not produce the dashboard bundle and stylesheet");
		}
	}
	return { bundlePath, stylesheetPath };
}

/**
 * Always-on determinism styles: CSS animations, transitions, and the text
 * caret's blink phase depend on capture timing, so two renders of the same
 * fixture would differ pixel for pixel. Presentation is otherwise untouched.
 */
const DETERMINISM_CSS =
	"*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

/**
 * The measurement-mode font pin. Every measurement run (--widths or
 * --pane-widths) swaps the two font tokens for these faces, whose
 * ascent/descent/line-gap overrides make every line-box metric a fixed
 * fraction of the font size: heights measure the same on every platform, so
 * a green sweep on macOS predicts the Linux-only CI gate (the host's mono
 * fallback once rounded a mixed sans+mono line box 1px taller there).
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
const PINNED_CONTROL_PX = PINNED_FONT_METRICS.ascent + PINNED_FONT_METRICS.descent;
const DIVERGENT_CONTROL_PX = DIVERGENT_FONT_METRICS.ascent + DIVERGENT_FONT_METRICS.descent;
/** The advance-width control: this string at 100px must measure the faces' shared design advances. */
const ADVANCE_CONTROL_TEXT = "Illustrative Mix 0123456789";
/** Arial's design advances for the string (Liberation Sans carries the same by design). */
const ADVANCE_CONTROL_SANS_PX = 1217.39;
/** Courier New and Liberation Mono advance every glyph 1229/2048 em (~0.6); the tolerance absorbs the remainder. */
const ADVANCE_CONTROL_MONO_PX = ADVANCE_CONTROL_TEXT.length * 60;
/** Advances are design-identical; the slack only absorbs rasterizer rounding. */
const ADVANCE_TOLERANCE_PX = 1;

function fontFace(family: string, sources: string, metrics: { ascent: number; descent: number }): string {
	return (
		`@font-face { font-family: ${family}; src: ${sources}; ascent-override: ${metrics.ascent}%; ` +
		`descent-override: ${metrics.descent}%; line-gap-override: 0%; }`
	);
}

function measurementFontCss(): string {
	return [
		fontFace("geometry-pinned-sans", PINNED_SANS_SOURCES, PINNED_FONT_METRICS),
		fontFace("geometry-pinned-mono", PINNED_MONO_SOURCES, PINNED_FONT_METRICS),
		fontFace("geometry-divergent-sans", PINNED_SANS_SOURCES, DIVERGENT_FONT_METRICS),
		fontFace("geometry-divergent-mono", PINNED_MONO_SOURCES, DIVERGENT_FONT_METRICS),
	].join("\n");
}

/**
 * Repoints the two font tokens at the pinned faces. The dashboard reads fonts
 * only through these tokens (plus inherit), so the swap covers every rule;
 * under --no-theme there is no token set to rewrite, so the pin becomes the
 * whole set.
 */
function pinFontTokens(tokensCss: string): string {
	if (tokensCss === "") {
		return `:root { --vscode-font-family: geometry-pinned-sans; --vscode-editor-font-family: geometry-pinned-mono; }`;
	}
	const pinned = tokensCss
		.replace(/--vscode-font-family:[^;]*;/, "--vscode-font-family: geometry-pinned-sans;")
		.replace(/--vscode-editor-font-family:[^;]*;/, "--vscode-editor-font-family: geometry-pinned-mono;");
	if (!pinned.includes("geometry-pinned-sans") || !pinned.includes("geometry-pinned-mono")) {
		throw new Error("The theme's token set lost its font tokens; the measurement font pin has nothing to rewrite");
	}
	return pinned;
}

/**
 * The flags decide the appearance VALUES, not the fixture: the webview restamps
 * the root element from every state push, so a fixture's own theme and accent
 * would overwrite the shell's stamp and render every --app-theme and --accent
 * as the default. The two SCOPES ride through instead, because nothing stamps
 * them and they are what draws a row's modified marker and offers its Reset.
 */
function withAppearance(messages: readonly unknown[], theme: AppTheme, accent: Accent): readonly unknown[] {
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
function buildPageHtml(
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

/**
 * Reports the page's horizontal overflow, or null when there is none.
 *
 * The page-level number is the whole claim: a document whose scrollWidth beats
 * its clientWidth scrolls sideways. The names under it are a diagnostic, built
 * from two questions that fail in opposite directions - boxes reaching past the
 * edge miss an unbreakable text run inside a block that stays in bounds, and
 * boxes overflowing THEMSELVES catch that plus the min-width ancestor the
 * deepest-offender filter drops. Anything inside a scroller is skipped in both:
 * a deliberate overflow-x contributes nothing to the document's own scroll.
 */
const OVERFLOW_PROBE = `(() => {
	const root = document.documentElement;
	const overflow = root.scrollWidth - root.clientWidth;
	if (overflow <= 0) {
		return null;
	}
	const scrolls = (node) => getComputedStyle(node).overflowX !== "visible";
	const inScroller = (node) => {
		for (let parent = node.parentElement; parent !== null && parent !== root; parent = parent.parentElement) {
			if (scrolls(parent)) {
				return true;
			}
		}
		return false;
	};
	const limit = root.clientWidth + 0.5;
	const past = [];
	const spilling = [];
	for (const node of document.querySelectorAll("body *")) {
		if (inScroller(node)) {
			continue;
		}
		const rect = node.getBoundingClientRect();
		if (rect.width > 0 && rect.right > limit) {
			past.push(node);
		}
		if (!scrolls(node) && node.scrollWidth - node.clientWidth > 0.5) {
			spilling.push(node);
		}
	}
	const name = (node, why) => {
		const classes = typeof node.className === "string" ? node.className.trim().split(/\\s+/).slice(0, 2) : [];
		const tag = node.tagName.toLowerCase() + (classes.length > 0 ? "." + classes.join(".") : "");
		return why === "past"
			? tag + " reaches to " + Math.round(node.getBoundingClientRect().right)
			: tag + " holds " + Math.round(node.scrollWidth - node.clientWidth) + "px it cannot show";
	};
	const deepest = past.filter((node) => !past.some((other) => other !== node && node.contains(other)));
	const culprits = [
		...deepest.slice(0, 4).map((node) => name(node, "past")),
		...spilling.slice(0, 4).map((node) => name(node, "spilling")),
	];
	return JSON.stringify({ overflow, clientWidth: root.clientWidth, culprits });
})()`;

/** Throws when the page scrolls sideways at the width it is currently set to. */
async function assertNoHorizontalOverflow(cdp: CdpConnection, width: number): Promise<void> {
	const found = (await evaluate(cdp, OVERFLOW_PROBE)) as string | null;
	if (found === null) {
		return;
	}
	const { overflow, clientWidth, culprits } = JSON.parse(found) as {
		overflow: number;
		clientWidth: number;
		culprits: readonly string[];
	};
	throw new Error(
		`The page scrolls sideways at ${width}px: ${overflow}px past a ${clientWidth}px viewport.\n  ` +
			culprits.join("\n  ")
	);
}

/** Applies a viewport width and lets two frames settle under it. */
async function setWidth(cdp: CdpConnection, width: number, height: number, dpr: number): Promise<void> {
	await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
	await evaluate(cdp, "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))", true);
}

/**
 * The pane's width as its container queries see it: the CONTENT box.
 * `container-type: inline-size` asks about the content box and the pane holds
 * 24px of padding on each side, so a border-box measurement would aim every
 * sweep 48px away from the breakpoint it meant to test.
 */
async function measurePane(cdp: CdpConnection): Promise<number> {
	const measured = await evaluate(
		cdp,
		`(() => {
			const pane = document.querySelector(".pane");
			if (pane === null) {
				return 0;
			}
			const style = getComputedStyle(pane);
			return Math.round(pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
		})()`
	);
	return typeof measured === "number" ? measured : 0;
}

/**
 * The window widths that put the PANE at each of the given widths.
 *
 * The breakpoints are container queries on the pane, and the pane is what is
 * left of the window after the rail, the padding, and its own max-width, so
 * setting the window to a pane threshold would test a width no breakpoint cares
 * about. Rather than model any of that, each target is SOLVED: set a width,
 * measure, correct by the difference, repeat. The relation is a slope of one
 * wherever it is not capped, so it converges in a step or two; where it is
 * capped or discontinuous it fails to converge and is reported, not guessed.
 * From both ends, because the rail's collapse takes about 170px of the offset
 * with it, hiding pane widths reachable only from one side.
 */
async function windowWidthsForPanes(
	cdp: CdpConnection,
	panes: readonly number[],
	height: number,
	dpr: number
): Promise<{ readonly pane: number; readonly window: number; readonly landed: boolean }[]> {
	const resolved: { pane: number; window: number; landed: boolean }[] = [];
	for (const pane of panes) {
		const found = new Set<number>();
		for (const start of [NARROW_PROBE_WIDTH, WIDE_PROBE_WIDTH]) {
			let candidate = start;
			for (let attempt = 0; attempt < 5; attempt++) {
				await setWidth(cdp, candidate, height, dpr);
				const measured = await measurePane(cdp);
				if (measured === pane) {
					found.add(candidate);
					break;
				}
				const next = candidate + (pane - measured);
				if (next < 1 || next === candidate) {
					break;
				}
				candidate = next;
			}
		}
		for (const window of found) {
			resolved.push({ pane, window, landed: true });
		}
		if (found.size === 0) {
			resolved.push({ pane, window: 0, landed: false });
		}
	}
	return resolved;
}

/**
 * The in-page WCAG contrast probe behind --contrast: reads the element's
 * computed color and its EFFECTIVE background, compositing translucent
 * backgrounds up the ancestor chain until an opaque one. Colors are normalized
 * through a 1x1 canvas rather than a regex, because the theme derives its tones
 * with color-mix in oklab and a parser that only speaks rgb() would fail on
 * exactly those. Anything the probe cannot honestly composite is an error, not
 * a guess. One stated non-claim: pseudo-element overlays are invisible to every
 * element scan, so the occlusion guarantee covers elements only.
 */
function contrastProbe(selector: string): string {
	return `(() => {
		const node = document.querySelector(${JSON.stringify(selector)});
		if (node === null) {
			return null;
		}
		const rect = node.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			return JSON.stringify({ error: "the element is zero-sized; nothing is painted" });
		}
		// visibility: hidden keeps its geometry, so the size check alone would
		// happily measure text no pixel shows. Computed visibility inherits, so
		// the node's own value covers a hidden ancestor too.
		if (getComputedStyle(node).visibility !== "visible") {
			return JSON.stringify({ error: "the element's computed visibility is not visible; nothing is painted" });
		}
		// The ancestor walk below sees only the element's OWN stacking context, so
		// a scrim or slide-over drawn over it is no ancestor. Hit-test the centre
		// instead: the point must be inside the viewport for hit-testing to see
		// it, and the top hit must be the element or something it contains.
		const probeX = rect.left + rect.width / 2;
		const probeY = rect.top + rect.height / 2;
		if (probeX < 0 || probeY < 0 || probeX >= window.innerWidth || probeY >= window.innerHeight) {
			return JSON.stringify({
				error:
					"the element's centre sits outside the viewport at (" + Math.round(probeX) + ", " + Math.round(probeY) +
					"), where hit-testing cannot see it; scroll it on screen or raise --height",
			});
		}
		const hit = document.elementFromPoint(probeX, probeY);
		if (hit !== node && (hit === null || !node.contains(hit))) {
			const describe = (candidate) => {
				if (candidate === null) { return "nothing"; }
				const classes = typeof candidate.className === "string" ? candidate.className.trim().split(/\\s+/) : [];
				return candidate.tagName.toLowerCase() + (classes[0] !== undefined && classes[0] !== "" ? "." + classes.slice(0, 2).join(".") : "");
			};
			return JSON.stringify({
				error:
					"the element is not the top hit at its own centre - " + describe(hit) +
					" covers it, and a ratio measured through an overlay would certify a contrast nobody sees",
			});
		}
		// Hit-testing is blind to pointer-events: none, and such an overlay can
		// still paint over the element. Over-reject on purpose rather than decide
		// whether it PAINTS: any such element overlapping the probe point that is
		// neither ancestor nor content fails, since an unprovable pixel is worth
		// less than no ratio. visibility: hidden and opacity: 0 are the only
		// exclusions, being proofs of not painting rather than guesses.
		for (const veil of document.querySelectorAll("*")) {
			const veilStyle = getComputedStyle(veil);
			if (veilStyle.pointerEvents !== "none") { continue; }
			if (veil === node || node.contains(veil) || veil.contains(node)) { continue; }
			if (veilStyle.visibility !== "visible" || Number(veilStyle.opacity) === 0) { continue; }
			const box = veil.getBoundingClientRect();
			if (probeX < box.left || probeX > box.right || probeY < box.top || probeY > box.bottom) { continue; }
			const classes = typeof veil.className === "string" ? veil.className.trim().split(/\\s+/) : [];
			return JSON.stringify({
				error:
					"a pointer-events-none element (" + veil.tagName.toLowerCase() +
					(classes[0] !== undefined && classes[0] !== "" ? "." + classes.slice(0, 2).join(".") : "") +
					") overlaps the probe point, where hit-testing cannot see it; the probe cannot prove whose pixel it measures",
			});
		}
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		const parse = (text) => {
			// An invalid color leaves fillStyle at its previous value, so parse
			// against two sentinels: only a real color lands on the same
			// serialization from both.
			context.fillStyle = "#000000";
			context.fillStyle = text;
			const fromBlack = context.fillStyle;
			context.fillStyle = "#ffffff";
			context.fillStyle = text;
			if (context.fillStyle !== fromBlack) {
				return null;
			}
			context.clearRect(0, 0, 1, 1);
			context.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
			return { r, g, b, a: a / 255 };
		};
		const layers = [];
		// Backgrounds are collected only until an opaque one, but the opacity
		// refusal runs on EVERY ancestor up to the root: opacity fades the whole
		// subtree, so a translucent ancestor above the opaque stop still changes
		// what the pixel shows.
		let opaqueFound = false;
		for (let element = node; element !== null; element = element.parentElement) {
			const style = getComputedStyle(element);
			if (Number(style.opacity) < 1) {
				return JSON.stringify({ error: element.tagName + " has opacity below 1; the probe cannot composite it" });
			}
			if (opaqueFound) {
				continue;
			}
			if (style.backgroundImage !== "none") {
				return JSON.stringify({ error: element.tagName + " paints a background-image; the probe cannot composite it" });
			}
			const background = parse(style.backgroundColor);
			if (background === null) {
				return JSON.stringify({ error: "unparseable background-color on " + element.tagName + ": " + style.backgroundColor });
			}
			if (background.a > 0) {
				layers.push(background);
			}
			if (background.a >= 1) {
				opaqueFound = true;
			}
		}
		// A stack still translucent at the root composites over the canvas default.
		if (layers.length === 0 || layers[layers.length - 1].a < 1) {
			layers.push({ r: 255, g: 255, b: 255, a: 1 });
		}
		const over = (top, bottom) => ({
			r: top.r * top.a + bottom.r * (1 - top.a),
			g: top.g * top.a + bottom.g * (1 - top.a),
			b: top.b * top.a + bottom.b * (1 - top.a),
			a: 1,
		});
		let background = layers[layers.length - 1];
		for (let i = layers.length - 2; i >= 0; i--) {
			background = over(layers[i], background);
		}
		const color = parse(getComputedStyle(node).color);
		if (color === null) {
			return JSON.stringify({ error: "unparseable color: " + getComputedStyle(node).color });
		}
		const foreground = color.a >= 1 ? { ...color } : over(color, background);
		const luminance = (paint) => {
			const channel = (value) => {
				const scaled = value / 255;
				return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * channel(paint.r) + 0.7152 * channel(paint.g) + 0.0722 * channel(paint.b);
		};
		const lighter = Math.max(luminance(foreground), luminance(background));
		const darker = Math.min(luminance(foreground), luminance(background));
		const show = (paint) => "rgb(" + Math.round(paint.r) + ", " + Math.round(paint.g) + ", " + Math.round(paint.b) + ")";
		return JSON.stringify({
			ratio: (lighter + 0.05) / (darker + 0.05),
			foreground: show(foreground),
			background: show(background),
		});
	})()`;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			fixture: { type: "string" },
			out: { type: "string" },
			width: { type: "string" },
			height: { type: "string" },
			"html-out": { type: "string" },
			"clip-viewport": { type: "boolean", default: false },
			hover: { type: "string" },
			focus: { type: "string" },
			contrast: { type: "string" },
			"contrast-large": { type: "boolean", default: false },
			dpr: { type: "string" },
			"no-theme": { type: "boolean", default: false },
			theme: { type: "string" },
			accent: { type: "string" },
			"app-theme": { type: "string" },
			widths: { type: "string" },
			"pane-widths": { type: "string" },
		},
	});
	const measuring = values.widths !== undefined || values["pane-widths"] !== undefined;
	if (values.fixture === undefined || (values.out === undefined && !measuring)) {
		usage();
	}
	const fixture = await loadFixture(values.fixture);
	const width = values.width !== undefined ? Number(values.width) : (fixture.viewport?.width ?? 1300);
	const height = values.height !== undefined ? Number(values.height) : (fixture.viewport?.height ?? 950);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error(`Viewport must be positive integers; got ${width}x${height}`);
	}
	// Sub-2px strokes snap differently per display density, so reviewing them
	// needs the same page at 1x and 2x.
	const dpr = values.dpr === undefined ? 1 : Number(values.dpr);
	if (!Number.isFinite(dpr) || dpr <= 0) {
		throw new Error(`--dpr takes a positive number; got ${values.dpr}`);
	}
	if (values["contrast-large"] === true && values.contrast === undefined) {
		throw new Error("--contrast-large only adjusts the --contrast threshold; pass --contrast <selector> too");
	}
	// --widths makes --out optional: measuring every fixture at every breakpoint
	// boundary should not also cost a full-page screenshot each.
	const positiveIntegers = (list: string | undefined, flag: string): number[] =>
		(list ?? "")
			.split(",")
			.map((piece) => piece.trim())
			.filter((piece) => piece.length > 0)
			.map((piece) => {
				const parsed = Number(piece);
				if (!Number.isInteger(parsed) || parsed <= 0) {
					throw new Error(`${flag} takes positive integers; got ${piece}`);
				}
				return parsed;
			});
	const sweepWidths = positiveIntegers(values.widths, "--widths");
	const paneWidths = positiveIntegers(values["pane-widths"], "--pane-widths");
	const outPath = values.out === undefined ? undefined : path.resolve(values.out);
	// The state probes run against the captured page, after the width sweep has
	// restored the fixture's own width; a measurement-only run returns before
	// that point, so accepting a probe there would exit 0 having never run it.
	const probes = (["hover", "focus", "contrast"] as const).filter((flag) => values[flag] !== undefined);
	if (outPath === undefined && probes.length > 0) {
		throw new Error(
			`--${probes.join(", --")} run(s) against the captured state; a measurement-only run (no --out) would` +
				" silently skip the probe. Pass --out as well."
		);
	}

	const chromeBin = findChrome();
	console.log(`chrome: ${chromeBin}`);
	const { bundlePath, stylesheetPath } = await ensureBundle();
	const isHostTheme = (value: string): value is HostTheme => (HOST_THEMES as readonly string[]).includes(value);
	if (values.theme !== undefined && !isHostTheme(values.theme)) {
		throw new Error(`--theme must be one of ${HOST_THEMES.join(", ")}; got ${values.theme}`);
	}
	const hostTheme: HostTheme = values.theme ?? fixture.hostTheme ?? "dark";
	const isAccent = (value: string): value is Accent => (UI_ACCENTS as readonly string[]).includes(value);
	if (values.accent !== undefined && !isAccent(values.accent)) {
		throw new Error(`--accent must be one of ${UI_ACCENTS.join(", ")}; got ${values.accent}`);
	}
	const accent: Accent = values.accent ?? "blue";
	// --theme names the HOST theme being emulated; --app-theme names the reader's
	// own ui.theme setting. The default stays "auto" because that is what almost
	// everyone runs, so it should not be reachable only by a flag.
	const isAppTheme = (value: string): value is AppTheme => (UI_THEMES as readonly string[]).includes(value);
	if (values["app-theme"] !== undefined && !isAppTheme(values["app-theme"])) {
		throw new Error(`--app-theme must be one of ${UI_THEMES.join(", ")}; got ${values["app-theme"]}`);
	}
	const forcedTheme: AppTheme = values["app-theme"] ?? "auto";
	const tokensCss =
		values["no-theme"] === true
			? ""
			: {
					dark: themeCss,
					light: lightCss,
					"high-contrast": highContrastCss,
					"high-contrast-light": highContrastLightCss,
					"forced-colors": highContrastCss,
				}[hostTheme]();
	if (hostTheme === "dark" || hostTheme === "light") {
		assertThemeCoversStylesheet(await fs.readFile(stylesheetPath, "utf8"), tokensCss, hostTheme);
	}
	// Any measurement run measures the pinned faces, --out beside it or not: a
	// PNG rendered while measuring photographs the pinned stack on purpose, so
	// a sweep failure can be reproduced with the same fonts it measured.
	const pinFonts = measuring;
	const html = buildPageHtml(
		withAppearance(fixture.messages, forcedTheme, accent),
		fixture.respond ?? {},
		hostTheme,
		forcedTheme,
		accent,
		pinFonts ? pinFontTokens(tokensCss) : tokensCss
	);
	if (values["html-out"] !== undefined) {
		await fs.writeFile(path.resolve(values["html-out"]), html);
		console.log(`wrote page HTML to ${path.resolve(values["html-out"])}`);
	}
	const harnessCss = pinFonts ? `${DETERMINISM_CSS}\n${measurementFontCss()}` : DETERMINISM_CSS;

	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "render-dashboard-"));
	let chrome: ChildProcess | undefined;
	let cdp: CdpConnection | undefined;
	// One memoized cleanup for every way out, awaited by the finally below and by
	// the signal path. A detached Chrome left the terminal's process group, so
	// terminal-generated signals now end this process alone; the handlers forward
	// the termination, stay installed until the cleanup has finished so a signal
	// cannot land in an unguarded window, and share the one promise so a repeated
	// signal joins the cleanup already running instead of cutting it short.
	let cleanedUp: Promise<void> | undefined;
	const cleanup = (): Promise<void> => {
		cleanedUp ??= (async () => {
			if (chrome !== undefined) {
				await killChromeTree(chrome);
			}
			await fs.rm(tmpRoot, { recursive: true, force: true });
		})();
		return cleanedUp;
	};
	let terminating = false;
	const onTermination = (): void => {
		terminating = true;
		void cleanup().finally(() => process.exit(1));
	};
	// Every terminal-generated termination, not just Ctrl-C: SIGHUP (a closed
	// window, a dropped ssh session) and SIGQUIT would otherwise kill this
	// process by default action and orphan a detached Chrome.
	const TERMINATION_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
	for (const signal of TERMINATION_SIGNALS) {
		process.on(signal, onTermination);
	}
	const pageDir = path.join(tmpRoot, "page");
	await fs.mkdir(pageDir);
	const indexHtml = path.join(pageDir, "index.html");
	await fs.copyFile(bundlePath, path.join(pageDir, "dashboard.js"));
	await fs.copyFile(stylesheetPath, path.join(pageDir, DASHBOARD_STYLESHEET_FILENAME));
	await fs.writeFile(path.join(pageDir, "harness.css"), harnessCss);
	await fs.writeFile(indexHtml, html);
	const pageUrl = pathToFileURL(indexHtml).href;

	// TZ and --lang pin the locale-dependent date strings; CHROME_EXTRA_FLAGS
	// carries environment-specific launch flags (a CI runner typically passes
	// --no-sandbox, since its image restricts the unprivileged user namespaces
	// the Chrome sandbox needs).
	const extraFlags = (process.env.CHROME_EXTRA_FLAGS ?? "").split(" ").filter((flag) => flag.length > 0);
	const launchFlags = [
		"--headless=new",
		"--remote-debugging-port=0",
		"--no-first-run",
		"--hide-scrollbars",
		"--lang=en-US",
		"--force-color-profile=srgb",
		`--window-size=${width},${height}`,
		...extraFlags,
	];
	try {
		const launched = await launchChrome(
			chromeBin,
			tmpRoot,
			launchFlags,
			pageUrl,
			(spawned) => {
				chrome = spawned;
			},
			() => terminating
		);
		cdp = await CdpConnection.connect(await findPageTargetUrl(launched.port, pageUrl, READY_TIMEOUT_MS));
		// Emulated for every theme, dark included: skipping it left dark renders
		// on whatever Chrome's host preferred, so the one theme that never
		// declared its scheme was the default one.
		const light = LIGHT_HOST_THEMES.has(hostTheme);
		await cdp.send("Emulation.setEmulatedMedia", {
			features: [
				...(hostTheme === "forced-colors" ? [{ name: "forced-colors", value: "active" }] : []),
				{
					name: "prefers-contrast",
					value: hostTheme === "dark" || hostTheme === "light" ? "no-preference" : "more",
				},
				{ name: "prefers-color-scheme", value: light ? "light" : "dark" },
			],
		});

		const readyDeadline = Date.now() + READY_TIMEOUT_MS;
		while ((await evaluate(cdp, "window.__ready === true")) !== true) {
			if (Date.now() > readyDeadline) {
				throw new Error("The page never posted ready (window.__ready); rerun with --html-out to inspect the page");
			}
			await delay(100);
		}
		await delay(fixture.settleMs ?? 300);

		// The pin is proven engaged BEFORE the fixture's steps (a step may end the run by throwing - the geometry
		// sweep's expected-drift verdicts do - which must not skip the proof), on both axes: line-box height against
		// the overrides, advance width against the shared design advances CSS cannot override (divergent faces too,
		// or the metric probe's only-vertical-metrics-change premise is broken).
		if (pinFonts) {
			const controls = JSON.parse(
				(await evaluate(
					cdp,
					`(() => {
						const box = document.createElement("div");
						box.style.cssText =
							"position:absolute;visibility:hidden;font-size:100px;line-height:normal;white-space:pre;width:max-content;";
						box.textContent = ${JSON.stringify(ADVANCE_CONTROL_TEXT)};
						document.body.appendChild(box);
						const measure = (family) => {
							box.style.fontFamily = family;
							const rect = box.getBoundingClientRect();
							return { height: rect.height, width: rect.width };
						};
						const faces = {
							sans: measure("geometry-pinned-sans"),
							mono: measure("geometry-pinned-mono"),
							divergentSans: measure("geometry-divergent-sans"),
							divergentMono: measure("geometry-divergent-mono"),
						};
						box.remove();
						return JSON.stringify(faces);
					})()`
				)) as string
			) as Record<string, { height: number; width: number }>;
			const expectations: readonly (readonly [string, number, number])[] = [
				["sans", PINNED_CONTROL_PX, ADVANCE_CONTROL_SANS_PX],
				["mono", PINNED_CONTROL_PX, ADVANCE_CONTROL_MONO_PX],
				["divergentSans", DIVERGENT_CONTROL_PX, ADVANCE_CONTROL_SANS_PX],
				["divergentMono", DIVERGENT_CONTROL_PX, ADVANCE_CONTROL_MONO_PX],
			];
			const wrong = expectations.flatMap(([face, height, width]) => {
				const measured = controls[face] ?? { height: 0, width: 0 };
				return [
					...(Math.abs(measured.height - height) > 0.5
						? [`${face} line box measured ${measured.height}px, expected ${height}px`]
						: []),
					...(Math.abs(measured.width - width) > ADVANCE_TOLERANCE_PX
						? [`${face} advance width measured ${measured.width}px, expected ${width}px`]
						: []),
				];
			});
			if (wrong.length > 0) {
				throw new Error(
					"The measurement font pin did not engage - no advance-identical local() source resolved; install " +
						`Arial/Courier New or their metric twins (fonts-liberation on bare Linux): ${wrong.join("; ")}`
				);
			}
			console.log(`fonts: pinned for measurement (normal line box ${PINNED_CONTROL_PX}px at 100px font size)`);
		}

		for (const step of fixture.steps ?? []) {
			await evaluate(cdp, step, true);
			await delay(200);
		}

		// The page runs under the shell's real CSP; a violation means some code
		// needs what the webview never grants, so the render fails loudly instead
		// of capturing a page that only works with the policy off.
		const violations = (await evaluate(cdp, "window.__cspViolations")) as readonly string[];
		if (violations.length > 0) {
			throw new Error(`Content-Security-Policy violations:\n  ${violations.join("\n  ")}`);
		}
		// And the policy must not have cost the page its stylesheets: the Tailwind
		// theme block defines --radius as a literal (--primary and friends can
		// compute to guaranteed-invalid where a host token is deliberately null)
		// and the dashboard stylesheet zeroes the body margin, so both gone means
		// a css load was blocked.
		const stylesApplied = (await evaluate(
			cdp,
			`getComputedStyle(document.documentElement).getPropertyValue("--radius") !== "" &&
			 getComputedStyle(document.body).marginTop === "0px"`
		)) as boolean;
		if (!stylesApplied) {
			throw new Error("The dashboard stylesheet did not apply (missing --radius or body margin reset)");
		}

		const h1 = await evaluate(cdp, 'document.querySelector("main h1")?.textContent ?? null');
		console.log(`main h1: ${JSON.stringify(h1)}`);
		if (h1 === null) {
			console.warn("warning: no <main> h1 found; the page is likely still on the loading skeleton");
		}

		// Every render is also an overflow assertion. A page that scrolls sideways
		// is broken outright rather than a matter of taste, it is invisible in a
		// full-page capture (which photographs the overflow as though it were the
		// page), and it has shipped twice. Through an explicit width override
		// rather than whatever --window-size left: a platform with a minimum
		// window width gives back a wider viewport than was asked for, so the
		// number in a failure would not be the number under test.
		await setWidth(cdp, width, height, dpr);
		await assertNoHorizontalOverflow(cdp, width);
		const sweeping = fixture.measuredAtOwnWidth !== true;
		if (!sweeping && (sweepWidths.length > 0 || paneWidths.length > 0)) {
			console.log("skipped the width sweep: this fixture's state was measured at its own width");
		}
		const aimed = sweeping && paneWidths.length > 0 ? await windowWidthsForPanes(cdp, paneWidths, height, dpr) : [];
		const failures: string[] = [
			...aimed
				.filter((entry) => !entry.landed)
				.map((entry) => `No viewport width puts the pane at ${entry.pane}px, so that breakpoint went untested`),
		];
		const sweep = [
			...(sweeping ? sweepWidths : []).map((sweepWidth) => ({
				window: sweepWidth,
				pane: undefined as number | undefined,
			})),
			...aimed.filter((entry) => entry.landed).map((entry) => ({ window: entry.window, pane: entry.pane })),
		];
		for (const at of sweep) {
			await setWidth(cdp, at.window, height, dpr);
			try {
				await assertNoHorizontalOverflow(cdp, at.window);
			} catch (error) {
				// Collected rather than thrown: one report naming every width
				// that fails beats a bisect through the list one run at a time.
				const where = at.pane === undefined ? "" : ` (aimed at a ${at.pane}px pane)`;
				failures.push((error instanceof Error ? error.message : String(error)) + where);
			}
		}
		if (sweep.length > 0) {
			await setWidth(cdp, width, height, dpr);
			console.log(`swept ${sweep.length} width(s): ${failures.length === 0 ? "no overflow" : "SEE BELOW"}`);
		}
		if (failures.length > 0) {
			throw new Error(failures.join("\n"));
		}
		if (outPath === undefined) {
			return;
		}

		const captureBeyondViewport = values["clip-viewport"] !== true && fixture.clipViewport !== true;
		await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
		if (captureBeyondViewport) {
			// Pin the scroll offset, then let two frames settle. A full-page
			// capture photographs the whole document through the fixture's small
			// viewport, and a position: sticky element paints where the CURRENT
			// offset puts it - an offset layout is still settling around, so the
			// same bytes photograph differently run to run. At offset 0 a sticky
			// element is unstuck and coincides with its flow position, which no
			// later relayout can move. Only the full-page path wants this:
			// --clip-viewport exists to photograph what the fixture scrolled to.
			await evaluate(cdp, "window.scrollTo(0, 0)");
			await evaluate(cdp, "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))", true);
			// The pin only reaches the document scroller. An inner one left
			// scrolled (a windowed table, a slide-over) would keep its own sticky
			// children racing, so fail loudly rather than photograph a surprise.
			const stray = (await evaluate(
				cdp,
				`(() => {
					if (window.scrollY !== 0) { return "document at " + window.scrollY; }
					for (const node of document.querySelectorAll("*")) {
						if (node.scrollTop > 0) { return node.tagName + "." + node.className + " at " + node.scrollTop; }
					}
					return null;
				})()`
			)) as string | null;
			if (stray !== null) {
				throw new Error(`Scroll offset survived the pre-capture pin (${stray}); the render would not be reproducible`);
			}
		}
		// Hover after the scroll pin, because it is the one state a later scroll
		// destroys: :hover answers to the real input pipeline alone, tracks
		// VIEWPORT coordinates, and Chrome re-runs hit-testing after a scroll.
		// Dispatching before the pin produced a PNG byte-identical to the
		// unhovered one while the page still reported the element hovered.
		if (values.hover !== undefined) {
			const target = (await evaluate(
				cdp,
				`(() => {
					const node = document.querySelector(${JSON.stringify(values.hover)});
					if (!node) { return null; }
					const rect = node.getBoundingClientRect();
					return {
						x: Math.round(rect.left + rect.width / 2),
						y: Math.round(rect.top + rect.height / 2),
						width: Math.round(rect.width),
						height: Math.round(rect.height),
						viewport: { width: window.innerWidth, height: window.innerHeight },
					};
				})()`
			)) as {
				readonly x: number;
				readonly y: number;
				readonly width: number;
				readonly height: number;
				readonly viewport: { readonly width: number; readonly height: number };
			} | null;
			if (target === null) {
				throw new Error(`--hover matched no element: ${values.hover}`);
			}
			// A collapsed or display:none target hovers the document at (0, 0)
			// and reports success, which is the same lie in a smaller costume.
			if (target.width === 0 || target.height === 0) {
				throw new Error(`--hover matched a zero-sized element (${values.hover}); nothing would be hovered`);
			}
			// A full-page capture photographs the whole document but the pointer
			// only reaches the viewport, so an element below the fold cannot be
			// hovered at all. Say so rather than write an unhovered PNG.
			const offscreen =
				target.x < 0 || target.y < 0 || target.x > target.viewport.width || target.y > target.viewport.height;
			if (offscreen) {
				throw new Error(
					`--hover target ${values.hover} sits outside the viewport at capture time (${target.x}, ${target.y});` +
						" a pointer cannot reach it. Use --clip-viewport, or a taller --height."
				);
			}
			await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, buttons: 0 });
			await delay(150);
			// Steps run before this, so the h1 channel can only report the resting
			// state - which would leave the hovered colours visible in the PNG and
			// measurable nowhere. Confirm from the page that :hover matched rather
			// than trusting that the coordinates were good.
			const hovered = await evaluate(
				cdp,
				`(() => {
					const node = document.querySelector(${JSON.stringify(values.hover)});
					const style = getComputedStyle(node);
					return JSON.stringify({
						matches: node.matches(":hover"),
						color: style.color,
						background: style.backgroundColor,
						borderColor: style.borderTopColor,
					});
				})()`
			);
			console.log(`hovered ${values.hover}: ${hovered}`);
			if (typeof hovered === "string" && hovered.includes('"matches":false')) {
				throw new Error(`--hover dispatched at (${target.x}, ${target.y}) but ${values.hover} never matched :hover`);
			}
		}

		// Focus after hover, because :focus-visible is a claim about input
		// modality: Chrome grants a programmatic focus() the ring only while it
		// believes the last interaction was keyboard, and --hover's mouse move
		// flips that belief. Hover survives this ordering, since focus does not
		// move the pointer.
		if (values.focus !== undefined) {
			const focusSelector = JSON.stringify(values.focus);
			const target = (await evaluate(
				cdp,
				`(() => {
					const node = document.querySelector(${focusSelector});
					if (!node) { return null; }
					const rect = node.getBoundingClientRect();
					return {
						x: Math.round(rect.left + rect.width / 2),
						y: Math.round(rect.top + rect.height / 2),
						width: Math.round(rect.width),
						height: Math.round(rect.height),
						viewport: { width: window.innerWidth, height: window.innerHeight },
					};
				})()`
			)) as {
				readonly x: number;
				readonly y: number;
				readonly width: number;
				readonly height: number;
				readonly viewport: { readonly width: number; readonly height: number };
			} | null;
			if (target === null) {
				throw new Error(`--focus matched no element: ${values.focus}`);
			}
			if (target.width === 0 || target.height === 0) {
				throw new Error(`--focus matched a zero-sized element (${values.focus}); no ring could be photographed`);
			}
			const offscreen =
				target.x < 0 || target.y < 0 || target.x > target.viewport.width || target.y > target.viewport.height;
			if (offscreen) {
				throw new Error(
					`--focus target ${values.focus} sits outside the viewport at capture time (${target.x}, ${target.y});` +
						" its ring would not be in the shot. Use --clip-viewport, or a taller --height."
				);
			}
			const attempt = `(() => {
				const node = document.querySelector(${focusSelector});
				node.focus({ preventScroll: true });
				const style = getComputedStyle(node);
				return JSON.stringify({
					focused: document.activeElement === node,
					ring: node.matches(":focus-visible"),
					outline: style.outlineWidth + " " + style.outlineStyle + " " + style.outlineColor,
					boxShadow: style.boxShadow,
				});
			})()`;
			interface FocusReport {
				readonly focused: boolean;
				readonly ring: boolean;
				readonly outline: string;
				readonly boxShadow: string;
			}
			let report = JSON.parse((await evaluate(cdp, attempt)) as string) as FocusReport;
			if (!report.ring) {
				// A real Tab through the input pipeline restores keyboard modality,
				// and the refocus then earns the ring. Tab moves focus first and the
				// browser may scroll its landing into view - the document OR any
				// inner scroller - so every scroll position is snapshotted, restored
				// and VERIFIED: a capture whose scroll drifted photographs a page
				// the viewport validation above never saw.
				await evaluate(
					cdp,
					`(() => {
						window.__focusScrollSnapshot = { win: [window.scrollX, window.scrollY], nodes: [] };
						for (const node of document.querySelectorAll("*")) {
							if (node.scrollTop !== 0 || node.scrollLeft !== 0) {
								window.__focusScrollSnapshot.nodes.push([node, node.scrollTop, node.scrollLeft]);
							}
						}
					})()`
				);
				await cdp.send("Input.dispatchKeyEvent", {
					type: "keyDown",
					key: "Tab",
					code: "Tab",
					windowsVirtualKeyCode: 9,
				});
				await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
				report = JSON.parse((await evaluate(cdp, attempt)) as string) as FocusReport;
				const drifted = (await evaluate(
					cdp,
					`(() => {
						const snapshot = window.__focusScrollSnapshot;
						const want = new Map(snapshot.nodes.map((entry) => [entry[0], entry]));
						window.scrollTo(snapshot.win[0], snapshot.win[1]);
						const stuck = [];
						for (const node of document.querySelectorAll("*")) {
							const [, top, left] = want.get(node) ?? [node, 0, 0];
							if (node.scrollTop !== top) { node.scrollTop = top; }
							if (node.scrollLeft !== left) { node.scrollLeft = left; }
							if (node.scrollTop !== top || node.scrollLeft !== left) {
								stuck.push(node.tagName + "." + node.className + " at " + node.scrollTop + "," + node.scrollLeft);
							}
						}
						if (window.scrollX !== snapshot.win[0] || window.scrollY !== snapshot.win[1]) {
							stuck.push("window at " + window.scrollX + "," + window.scrollY);
						}
						return JSON.stringify(stuck);
					})()`
				)) as string;
				const stuck = JSON.parse(drifted) as readonly string[];
				if (stuck.length > 0) {
					throw new Error(
						`--focus's Tab fallback scrolled the page and the restore did not take (${stuck.join("; ")});` +
							" the capture would not be reproducible"
					);
				}
			}
			console.log(`focused ${values.focus}: ${JSON.stringify(report)}`);
			if (!report.focused) {
				throw new Error(`--focus could not move focus to ${values.focus}; it does not appear to be focusable`);
			}
			// A programmatic focus() that never earned :focus-visible paints NO
			// ring, and a reviewer must never photograph a missing focus ring that
			// is actually a harness artifact.
			if (!report.ring) {
				throw new Error(
					`--focus put focus on ${values.focus} but it never matched :focus-visible, even after the Tab fallback;` +
						" the shot would show no focus ring, so failing instead of writing it"
				);
			}
		}

		// The contrast probe reads the FINAL state, hover and focus included, so
		// a hover fill or a focused control can be measured as it will be shot.
		if (values.contrast !== undefined) {
			const threshold = values["contrast-large"] === true ? 3 : 4.5;
			const raw = (await evaluate(cdp, contrastProbe(values.contrast))) as string | null;
			if (raw === null) {
				throw new Error(`--contrast matched no element: ${values.contrast}`);
			}
			const contrast = JSON.parse(raw) as {
				readonly error?: string;
				readonly ratio?: number;
				readonly foreground?: string;
				readonly background?: string;
			};
			if (contrast.error !== undefined || contrast.ratio === undefined) {
				throw new Error(`--contrast ${values.contrast}: ${contrast.error ?? "the probe returned no ratio"}`);
			}
			console.log(
				`contrast ${values.contrast}: ${contrast.ratio.toFixed(2)}:1` +
					` (${contrast.foreground} on ${contrast.background}; needs >= ${threshold}:1)`
			);
			if (contrast.ratio < threshold) {
				throw new Error(
					`--contrast ${values.contrast} measured ${contrast.ratio.toFixed(2)}:1, below the WCAG ${threshold}:1 floor` +
						` (${contrast.foreground} on ${contrast.background})`
				);
			}
		}

		const shot = (await cdp.send("Page.captureScreenshot", {
			format: "png",
			captureBeyondViewport,
		})) as { data?: string };
		if (typeof shot.data !== "string" || shot.data.length === 0) {
			throw new Error("Page.captureScreenshot returned no data");
		}
		await fs.writeFile(outPath, Buffer.from(shot.data, "base64"));
		const size = (await fs.stat(outPath)).size;
		if (size <= MIN_PNG_BYTES) {
			throw new Error(
				`Screenshot ${outPath} is only ${size} bytes (<= ${MIN_PNG_BYTES}); refusing to call that a render`
			);
		}
		console.log(`wrote ${outPath} (${size} bytes)`);
	} finally {
		cdp?.close();
		await cleanup();
		// Only after the cleanup: removed any earlier, a signal in the gap
		// would end the process with Chrome still running.
		for (const signal of TERMINATION_SIGNALS) {
			process.removeListener(signal, onTermination);
		}
	}
}

main()
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	// Explicit exit: an undici/Bun WebSocket that failed mid-close must not keep the process alive.
	.finally(() => process.exit(process.exitCode ?? 0));
