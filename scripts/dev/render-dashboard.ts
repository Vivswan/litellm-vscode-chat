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
import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { UI_ACCENTS, UI_THEMES } from "../../src/shared/config/settingSpec.ts";
import {
	DASHBOARD_BUNDLE_FILENAME,
	DASHBOARD_STYLESHEET_FILENAME,
	WEBVIEW_DIST_SEGMENTS,
} from "../../src/shared/webviewPaths.ts";
import { OWN_WIDTH_ONLY_MARKER } from "./overflowMarkers.ts";
import {
	CdpConnection,
	evaluate,
	findChrome,
	findPageTargetUrl,
	killChromeTree,
	launchChrome,
	READY_TIMEOUT_MS,
	setWidth,
} from "./render/chrome.ts";
import type { HostTheme } from "./render/hostThemes.ts";
import {
	assertPinCoversStylesheet,
	assertThemeCoversStylesheet,
	HOST_THEMES,
	highContrastCss,
	highContrastLightCss,
	LIGHT_HOST_THEMES,
	lightCss,
	pinFontTokens,
	themeCss,
} from "./render/hostThemes.ts";
import type { Accent, AppTheme } from "./render/page.ts";
import {
	ADVANCE_CONTROL_MONO_PX,
	ADVANCE_CONTROL_SANS_PX,
	ADVANCE_CONTROL_TEXT,
	ADVANCE_TOLERANCE_PX,
	buildPageHtml,
	DETERMINISM_CSS,
	DIVERGENT_CONTROL_PX,
	measurementFontCss,
	PINNED_CONTROL_PX,
	VSCODE_DEFAULT_CSS,
	withAppearance,
} from "./render/page.ts";
import {
	assertBelowFloorSideways,
	assertNoHorizontalOverflow,
	contrastProbe,
	windowWidthsForPanes,
} from "./render/probes.ts";

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
	/**
	 * Launch Chrome without --hide-scrollbars, as the --show-scrollbars flag
	 * does: the webview's classic scrollbars take space and paint bands the
	 * default render can never show. Fixture-level so a scrollbar-state guard
	 * keeps its bars when the sweeps run it without flags.
	 */
	readonly showScrollbars?: boolean;
	/**
	 * The fixture's width sits under the shell's min-width floor, where the page
	 * scrolls sideways BY DESIGN. The harness inverts its overflow assertion:
	 * the sideways scroll must be PRESENT (it is the state such a fixture exists
	 * to photograph), and the width must really be under the floor.
	 */
	readonly belowFloor?: boolean;
}

const REPO_ROOT = path.resolve(__dirname, "../..");

const MIN_PNG_BYTES = 10 * 1024;

function usage(): never {
	console.error(
		"usage: bun scripts/dev/render-dashboard.ts --fixture <fixture.ts> (--out <shot.png> | --widths N,N)" +
			" [--pane-widths N,N] [--width N] [--height N] [--theme <host theme>] [--dpr N]" +
			" [--accent blue|violet|teal|amber] [--app-theme auto|light|dark]" +
			" [--hover <css selector>] [--focus <css selector>] [--contrast <css selector>] [--contrast-large]" +
			" [--clip-viewport] [--show-scrollbars] [--html-out <page.html>] [--no-theme]"
	);
	process.exit(1);
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

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			fixture: { type: "string" },
			out: { type: "string" },
			width: { type: "string" },
			height: { type: "string" },
			"html-out": { type: "string" },
			"clip-viewport": { type: "boolean", default: false },
			"show-scrollbars": { type: "boolean", default: false },
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
	if (pinFonts) {
		assertPinCoversStylesheet(await fs.readFile(stylesheetPath, "utf8"));
	}
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
	await fs.writeFile(path.join(pageDir, "vscode-default.css"), VSCODE_DEFAULT_CSS);
	await fs.writeFile(indexHtml, html);
	const pageUrl = pathToFileURL(indexHtml).href;

	// TZ and --lang pin the locale-dependent date strings; CHROME_EXTRA_FLAGS
	// carries environment-specific launch flags (a CI runner typically passes
	// --no-sandbox, since its image restricts the unprivileged user namespaces
	// the Chrome sandbox needs).
	const extraFlags = (process.env.CHROME_EXTRA_FLAGS ?? "").split(" ").filter((flag) => flag.length > 0);
	// Hidden by default so measurements and shots stay platform-independent;
	// --show-scrollbars (or the fixture's showScrollbars) keeps the bars for the
	// states only a classic scrollbar can produce, e.g. the band under the rail
	// when a sub-floor page scrolls sideways.
	const showScrollbars = values["show-scrollbars"] === true || fixture.showScrollbars === true;
	const launchFlags = [
		"--headless=new",
		"--remote-debugging-port=0",
		"--no-first-run",
		...(showScrollbars ? [] : ["--hide-scrollbars"]),
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
		// or the metric probe's only-vertical-metrics-change premise is broken). The two utility legs measure through
		// the stylesheet's real font-sans/font-mono classes, so a Tailwind font token that lost the pin fails here
		// instead of silently measuring the platform's own mono.
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
						const measureClass = (utility) => {
							box.style.fontFamily = "";
							box.className = utility;
							const rect = box.getBoundingClientRect();
							box.className = "";
							return { height: rect.height, width: rect.width };
						};
						const faces = {
							sans: measure("geometry-pinned-sans"),
							mono: measure("geometry-pinned-mono"),
							divergentSans: measure("geometry-divergent-sans"),
							divergentMono: measure("geometry-divergent-mono"),
							utilitySans: measureClass("font-sans"),
							utilityMono: measureClass("font-mono"),
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
				["utilitySans", PINNED_CONTROL_PX, ADVANCE_CONTROL_SANS_PX],
				["utilityMono", PINNED_CONTROL_PX, ADVANCE_CONTROL_MONO_PX],
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
						"Arial/Courier New or their metric twins (fonts-liberation on bare Linux). A utility face failing " +
						`alone means the Tailwind font tokens lost the pin instead: ${wrong.join("; ")}`
				);
			}
			console.log(`fonts: pinned for measurement (normal line box ${PINNED_CONTROL_PX}px at 100px font size)`);
		}

		// The fixture's width is applied BEFORE its steps, not only before the
		// capture: --window-size is a request a platform may refuse (macOS clamps
		// windows to ~500px wide), so without the override a narrow fixture's
		// steps run at whatever width the platform allowed and only the capture
		// sees the declared one - a step that arms, measures, or asserts against
		// the fixture's own state would be doing it at a width the fixture never
		// named.
		await setWidth(cdp, width, height, dpr);
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
		if (fixture.belowFloor === true) {
			await assertBelowFloorSideways(cdp, width);
		} else {
			await assertNoHorizontalOverflow(cdp, width);
		}
		const sweeping = fixture.measuredAtOwnWidth !== true;
		if (!sweeping && (sweepWidths.length > 0 || paneWidths.length > 0)) {
			console.log(
				`${OWN_WIDTH_ONLY_MARKER} skipped the width sweep: this fixture's state was measured at its own width`
			);
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
