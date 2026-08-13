/**
 * Dev-only visual render harness: screenshots the dashboard webview in system
 * Chrome headless, without launching VS Code. It builds a standalone page from
 * buildDashboardHtml plus the real dist bundle, stubs acquireVsCodeApi so the
 * page's "ready" post replays a fixture's ExtensionToWebviewMessage list, then
 * drives Chrome over the DevTools protocol to run optional steps and capture
 * a PNG.
 *
 * Usage:
 *   bun scripts/dev/render-dashboard.ts --fixture scripts/dev/renderFixtures/example.ts --out /tmp/shot.png
 *     [--width 1300] [--height 950] [--theme dark|light|high-contrast|forced-colors]
 *     [--clip-viewport] [--html-out /tmp/page.html] [--no-theme]
 *
 * --theme overrides the fixture's own hostTheme, so any fixture can be shot in
 * light and dark without a second fixture file; the dashboard has to read well
 * in both.
 *
 * CHROME_BIN overrides Chrome discovery. Exit code 0 only when the PNG was
 * written and is larger than 10 KB.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDashboardHtml } from "../../src/extension/dashboard/html.ts";
import {
	DASHBOARD_BUNDLE_FILENAME,
	DASHBOARD_STYLESHEET_FILENAME,
	WEBVIEW_DIST_SEGMENTS,
} from "../../src/shared/webviewPaths.ts";
import { RENDER_EPOCH_MS } from "./renderClock.ts";

/** What a fixture module default-exports; `messages` are ExtensionToWebviewMessage objects. */
export interface RenderFixture {
	/** Delivered to the page as window "message" events once it posts its ready request. */
	readonly messages: readonly unknown[];
	/** JS expressions evaluated in the page after the messages settle (awaited when they return promises). */
	readonly steps?: readonly string[];
	readonly viewport?: { readonly width: number; readonly height: number };
	/** How long to wait after the ready handshake before steps and capture; default 300. */
	readonly settleMs?: number;
	/**
	 * The host theme the page emulates: the token set in harness.css plus the
	 * body class VS Code stamps. "light" and "dark" are the two ordinary
	 * themes and the dashboard must read well in both; "high-contrast" renders
	 * the HC token set with prefers-contrast raised, so the theme.css contrast
	 * overrides show their own colors; "forced-colors" adds forced-colors:
	 * active on top, the way an OS high-contrast mode overrides author colors.
	 * Default "dark".
	 */
	readonly hostTheme?: "dark" | "light" | "high-contrast" | "forced-colors";
	/**
	 * Canned answers for posted requests: when the page posts a request whose
	 * `method` matches a key, the stub dispatches the mapped envelope template
	 * with the request's `id` and `method` filled in (the correlation the real
	 * extension performs). A read's template is `{ kind: "response", payload }`;
	 * an intent outcome's is `{ kind: "ack" | "fail", ... }`. One template per
	 * method.
	 */
	readonly respond?: Readonly<Record<string, unknown>>;
}

const REPO_ROOT = path.resolve(__dirname, "../..");
const READY_TIMEOUT_MS = 15000;
const MIN_PNG_BYTES = 10 * 1024;

function usage(): never {
	console.error(
		"usage: bun scripts/dev/render-dashboard.ts --fixture <fixture.ts> --out <shot.png>" +
			" [--width N] [--height N] [--theme dark|light|high-contrast|forced-colors]" +
			" [--accent blue|violet|teal|amber]" +
			" [--clip-viewport] [--html-out <page.html>] [--no-theme]"
	);
	process.exit(1);
}

/**
 * The VS Code Dark Modern theme tokens the dashboard stylesheet reads,
 * approximated so a plain Chrome page renders like the webview instead of
 * black-on-white. Presentation aid only; --no-theme disables it.
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
		--vscode-panelTitle-activeForeground: #e7e7e7;
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
		--vscode-button-secondaryBackground: #313131;
		--vscode-button-secondaryForeground: #cccccc;
		--vscode-button-secondaryHoverBackground: #3c3c3c;
		--vscode-editorHoverWidget-background: #202020;
		--vscode-editorHoverWidget-foreground: #cccccc;
		--vscode-editorHoverWidget-border: #454545;
		--vscode-notifications-background: #1f1f1f;
		--vscode-notifications-foreground: #cccccc;
		--vscode-notifications-border: #313131;
		--vscode-charts-red: #f14c4c;
		--vscode-disabledForeground: #cccccc80;
		--vscode-editorWidget-border: #454545;
		--vscode-editorWidget-foreground: #cccccc;
		--vscode-list-hoverForeground: #cccccc;
		--vscode-panel-border: #2b2b2b;
		--vscode-progressBar-background: #0078d4;
		--vscode-statusBarItem-errorBackground: #c72e0f;
		--vscode-statusBarItem-errorForeground: #ffffff;
		--vscode-textBlockQuote-background: #2b2b2b;
		--vscode-dropdown-background: #313131;
		--vscode-dropdown-foreground: #cccccc;
		--vscode-dropdown-border: #3c3c3c;
		--vscode-settings-modifiedItemIndicator: #bb800966;
	}
	body { background: var(--vscode-editor-background); }
	`;
}

/**
 * The VS Code Light Modern theme tokens, approximated the same way, over the
 * same key set as the dark tokens above - a token one theme defines and the
 * other omits would show up as a design difference when it is really a gap in
 * this file.
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
		--vscode-testing-iconPassed: #388a34;
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
		--vscode-inputValidation-errorBorder: #e51400;
		--vscode-inputValidation-warningBackground: #f6f5d2;
		--vscode-inputValidation-warningBorder: #bf8803;
		--vscode-button-background: #005fb8;
		--vscode-button-foreground: #ffffff;
		--vscode-button-border: #0000001a;
		--vscode-button-hoverBackground: #0258a8;
		--vscode-button-secondaryBackground: #e5e5e5;
		--vscode-button-secondaryForeground: #3b3b3b;
		--vscode-button-secondaryHoverBackground: #cccccc;
		--vscode-editorHoverWidget-background: #f8f8f8;
		--vscode-editorHoverWidget-foreground: #3b3b3b;
		--vscode-editorHoverWidget-border: #c8c8c8;
		--vscode-notifications-background: #ffffff;
		--vscode-notifications-foreground: #3b3b3b;
		--vscode-notifications-border: #e5e5e5;
		--vscode-charts-red: #e51400;
		--vscode-disabledForeground: #61616180;
		--vscode-editorWidget-border: #c8c8c8;
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
	body { background: var(--vscode-editor-background); }
	`;
}

/**
 * The VS Code Dark High Contrast theme tokens, approximated the same way.
 * Deliberately sparse where the real theme is: button fills, secondary
 * backgrounds, and list hover colors are null in HC, so the stylesheet's
 * fallback chains and the theme.css contrast overrides are what render.
 */
function highContrastCss(): string {
	return `
	:root {
		--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, sans-serif;
		--vscode-font-size: 13px;
		--vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
		--vscode-foreground: #ffffff;
		--vscode-descriptionForeground: #ffffffb3;
		--vscode-editor-background: #000000;
		--vscode-panel-background: #000000;
		--vscode-editorWidget-background: #0c141f;
		--vscode-widget-border: #6fc3df;
		--vscode-contrastBorder: #6fc3df;
		--vscode-contrastActiveBorder: #f38518;
		--vscode-focusBorder: #f38518;
		--vscode-errorForeground: #f48771;
		--vscode-editorWarning-foreground: #ffd700;
		--vscode-testing-iconPassed: #89d185;
		--vscode-textLink-foreground: #3794ff;
		--vscode-textLink-activeForeground: #3794ff;
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
	body { background: var(--vscode-editor-background); }
	`;
}

/**
 * Every --vscode-* token the stylesheet reads must be defined by the ORDINARY
 * themes. VS Code hands the real webview a full token set, so a token this
 * file omits does not fall back the way it would in the host - it falls back
 * to whatever literal the stylesheet carries, and those literals were written
 * against dark. Invisible in a dark render, actively misleading in a light
 * one, which is the review this harness exists to serve.
 *
 * High contrast is exempt on purpose, not by oversight: the real HC themes
 * leave button fills, secondary backgrounds and hover colors genuinely null,
 * so its sparseness IS the fidelity - the fallback chains and theme.css's
 * contrast overrides are what an HC render is meant to exercise. Holding it to
 * this invariant would make those renders less faithful, not more.
 *
 * Contrast-only tokens are exempt everywhere for the mirror reason: the
 * ordinary themes do not define them and the stylesheet reads them behind a
 * fallback for exactly that.
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

/** JSON hardened for an inline script body, like html.ts's inlineScriptJson (which is module-private). */
function inlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/**
 * The acquireVsCodeApi stub: the page's {type:"ready"} post replays the
 * fixture's messages as window "message" events (the app registers its
 * listener before posting ready, so synchronous dispatch is safe) and flips
 * window.__ready for the harness's poll. Every post lands in window.__posted
 * so steps can inspect what the page sent.
 *
 * The script also freezes the page's clock to RENDER_EPOCH_MS before the
 * bundle loads: relative-time labels and locale date strings otherwise shift
 * with the wall clock, which breaks pixel comparison between renders.
 *
 * The page keeps the shell's real Content-Security-Policy, so this script
 * carries the shell's nonce and doubles as the CSP violation collector: any
 * violation (an injected style tag, say) lands in window.__cspViolations and
 * fails the render - a component that only works without the policy must
 * fail here, not in the webview.
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
				for (const data of window.__fixtureMessages) {
					window.dispatchEvent(new MessageEvent("message", { data }));
				}
				window.__ready = true;
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

/** Chrome writes "<port>\n<browser ws path>" here once the DevTools server is up. */
async function waitForDevtoolsPort(userDataDir: string, timeoutMs: number): Promise<number> {
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
		await delay(100);
	}
	throw new Error(`Chrome did not write ${portFile} within ${timeoutMs}ms`);
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

async function ensureBundle(): Promise<{ bundlePath: string; stylesheetPath: string }> {
	const distDir = path.join(REPO_ROOT, ...WEBVIEW_DIST_SEGMENTS);
	const bundlePath = path.join(distDir, DASHBOARD_BUNDLE_FILENAME);
	const stylesheetPath = path.join(distDir, DASHBOARD_STYLESHEET_FILENAME);
	if (!existsSync(bundlePath) || !existsSync(stylesheetPath)) {
		console.log(`${bundlePath} or ${stylesheetPath} missing; running bun run bundle:dev`);
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
 * The standalone page: the real HTML shell - Content-Security-Policy meta
 * included, with file: as the style source so the policy is enforced exactly
 * as the webview enforces it - plus the harness.css link (theme tokens and
 * determinism styles; inline style tags would violate the policy the page
 * exists to keep) and the acquireVsCodeApi stub inserted before the bundle
 * tag so it exists when the bundle's module scope calls it.
 */
function buildPageHtml(
	messages: readonly unknown[],
	respond: Readonly<Record<string, unknown>>,
	hostTheme: "dark" | "light" | "high-contrast" | "forced-colors",
	forcedTheme: "auto" | "light" | "dark",
	accent: "blue" | "violet" | "teal" | "amber"
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
	// VS Code stamps the theme kind onto the body, and theme.css keys its
	// contrast overrides off that class. The ordinary themes carry their class
	// too: nothing keys off them today, but the page should be what the host
	// would actually hand the webview.
	const bodyClass = {
		dark: "vscode-dark",
		light: "vscode-light",
		"high-contrast": "vscode-high-contrast",
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

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			fixture: { type: "string" },
			out: { type: "string" },
			width: { type: "string" },
			height: { type: "string" },
			"html-out": { type: "string" },
			"clip-viewport": { type: "boolean", default: false },
			"no-theme": { type: "boolean", default: false },
			theme: { type: "string" },
			accent: { type: "string" },
		},
	});
	if (values.fixture === undefined || values.out === undefined) {
		usage();
	}
	const fixture = await loadFixture(values.fixture);
	const width = values.width !== undefined ? Number(values.width) : (fixture.viewport?.width ?? 1300);
	const height = values.height !== undefined ? Number(values.height) : (fixture.viewport?.height ?? 950);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error(`Viewport must be positive integers; got ${width}x${height}`);
	}
	const outPath = path.resolve(values.out);

	const chromeBin = findChrome();
	console.log(`chrome: ${chromeBin}`);
	const { bundlePath, stylesheetPath } = await ensureBundle();
	const themeNames = ["dark", "light", "high-contrast", "forced-colors"] as const;
	type HostTheme = (typeof themeNames)[number];
	const isHostTheme = (value: string): value is HostTheme => (themeNames as readonly string[]).includes(value);
	if (values.theme !== undefined && !isHostTheme(values.theme)) {
		throw new Error(`--theme must be one of ${themeNames.join(", ")}; got ${values.theme}`);
	}
	const hostTheme: HostTheme = values.theme ?? fixture.hostTheme ?? "dark";
	const accentNames = ["blue", "violet", "teal", "amber"] as const;
	type Accent = (typeof accentNames)[number];
	const isAccent = (value: string): value is Accent => (accentNames as readonly string[]).includes(value);
	if (values.accent !== undefined && !isAccent(values.accent)) {
		throw new Error(`--accent must be one of ${accentNames.join(", ")}; got ${values.accent}`);
	}
	const accent: Accent = values.accent ?? "blue";
	// The forced-theme attribute the shell stamps: --theme names the HOST theme
	// the page is emulating, so the ordinary two map onto the reader's own
	// setting and the contrast modes stay on "auto", where the tokens follow
	// the host exactly as high contrast requires.
	const forcedTheme = hostTheme === "light" || hostTheme === "dark" ? hostTheme : "auto";
	const html = buildPageHtml(fixture.messages, fixture.respond ?? {}, hostTheme, forcedTheme, accent);
	if (values["html-out"] !== undefined) {
		await fs.writeFile(path.resolve(values["html-out"]), html);
		console.log(`wrote page HTML to ${path.resolve(values["html-out"])}`);
	}
	const tokensCss = hostTheme === "dark" ? themeCss() : hostTheme === "light" ? lightCss() : highContrastCss();
	if (hostTheme === "dark" || hostTheme === "light") {
		assertThemeCoversStylesheet(await fs.readFile(stylesheetPath, "utf8"), tokensCss, hostTheme);
	}
	const harnessCss = values["no-theme"] === true ? DETERMINISM_CSS : `${tokensCss}\n${DETERMINISM_CSS}`;

	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "render-dashboard-"));
	const pageDir = path.join(tmpRoot, "page");
	const profileDir = path.join(tmpRoot, "profile");
	await fs.mkdir(pageDir);
	await fs.mkdir(profileDir);
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
	const chrome = spawn(
		chromeBin,
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--hide-scrollbars",
			"--lang=en-US",
			"--force-color-profile=srgb",
			`--window-size=${width},${height}`,
			...extraFlags,
			pageUrl,
		],
		{ stdio: "ignore", env: { ...process.env, TZ: "UTC", LANG: "en_US.UTF-8" } }
	);
	let cdp: CdpConnection | undefined;
	try {
		const port = await waitForDevtoolsPort(profileDir, READY_TIMEOUT_MS);
		cdp = await CdpConnection.connect(await findPageTargetUrl(port, pageUrl, READY_TIMEOUT_MS));
		// Emulated for every theme, dark included: skipping it left dark renders
		// on whatever Chrome's host preferred, so the one theme that never
		// declared its scheme was the default one. prefers-contrast rises only
		// for the HC modes, and forced-colors only where an OS high-contrast
		// mode would override author colors.
		const light = hostTheme === "light";
		await cdp.send("Emulation.setEmulatedMedia", {
			features: [
				...(hostTheme === "forced-colors" ? [{ name: "forced-colors", value: "active" }] : []),
				{ name: "prefers-contrast", value: hostTheme === "dark" || light ? "no-preference" : "more" },
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

		for (const step of fixture.steps ?? []) {
			await evaluate(cdp, step, true);
			await delay(200);
		}

		// The page runs under the shell's real CSP; a violation means some
		// code needs what the webview never grants (an injected style tag,
		// say), so the render fails loudly instead of capturing a page that
		// only works with the policy off.
		const violations = (await evaluate(cdp, "window.__cspViolations")) as readonly string[];
		if (violations.length > 0) {
			throw new Error(`Content-Security-Policy violations:\n  ${violations.join("\n  ")}`);
		}
		// And the policy must not have cost the page its stylesheets: the
		// Tailwind theme block defines --radius as a literal (--primary and
		// friends can compute to guaranteed-invalid when a host token is
		// deliberately null, as in high contrast), the legacy stylesheet
		// zeroes the body margin - both gone means a css load was blocked.
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

		const captureBeyondViewport = values["clip-viewport"] !== true;
		await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
		if (captureBeyondViewport) {
			// Pin the scroll offset, then let two frames settle under the final
			// viewport metrics. A full-page capture photographs the whole
			// document through the fixture's small viewport, and a
			// position: sticky element paints where the CURRENT offset puts it -
			// so the tab bar lands wherever a step's scrollIntoView resolved to.
			// That offset is not stable: layout is still settling around it (the
			// models table re-measures row height after paint), so the same bytes
			// photograph differently run to run. At offset 0 a sticky element is
			// unstuck and coincides with its flow position, which no later
			// relayout or viewport expansion can move - a fixpoint rather than a
			// narrower race. Only the full-page path wants this: --clip-viewport
			// exists to photograph exactly what the fixture scrolled to.
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
		if (chrome.exitCode === null) {
			chrome.kill();
			const killDeadline = Date.now() + 2000;
			while (chrome.exitCode === null && Date.now() < killDeadline) {
				await delay(50);
			}
			if (chrome.exitCode === null) {
				chrome.kill("SIGKILL");
			}
		}
		await fs.rm(tmpRoot, { recursive: true, force: true });
	}
}

main()
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	// Explicit exit: an undici/Bun WebSocket that failed mid-close must not keep the process alive.
	.finally(() => process.exit(process.exitCode ?? 0));
