/// <reference types="bun" />
/**
 * The two rolldown bundles (the extension host and the dashboard webview) and the Tailwind leg of the stylesheet. The
 * source reads build-time constants as bare identifiers, which oxc's define substitutes as JS expression strings:
 * __LITELLM_REPOSITORY_URL__ is package.json's repository.url, which src/shared/util/links.ts derives every GitHub link
 * from, and the test runners set the same global from the same field (src/test/util/buildDefines.ts). A bundle built
 * without the define leaves the identifier bare, a ReferenceError at module load rather than a stale link.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { BuildOptions, Plugin } from "rolldown";
import { build, watch } from "rolldown";
import {
	DASHBOARD_BUNDLE_FILENAME,
	DASHBOARD_STYLESHEET_FILENAME,
	WEBVIEW_DIST_SEGMENTS,
} from "../../src/shared/webviewPaths.ts";
import { tailwindCliBin } from "../../src/test/bun/webview/dashboard/styles/tailwindCliBin.ts";
import { assertLayersOrdered } from "./cascadeLayers.ts";

/** --watch rebuilds on change and prints the begin/end markers .vscode/tasks.json's problem matcher reads. */
const watchMode = process.argv.includes("--watch");

/** --production minifies, hides the source maps, and ships React's production build. */
const production = process.argv.includes("--production");

/** Read for repository.url: the root tsconfig cannot import the manifest from src/shared, so the bundle injects it. */
const manifest = JSON.parse(await fs.readFile("package.json", "utf8")) as { repository?: { url?: unknown } };

if (typeof manifest.repository?.url !== "string") {
	throw new Error("package.json repository.url must be a string: the GitHub links are built from it");
}

/** The identifier src/shared/util/links.ts reads, as the JSON expression oxc substitutes for it. */
const buildDefines = { __LITELLM_REPOSITORY_URL__: JSON.stringify(manifest.repository.url) };

/**
 * Flattens Bun's AggregateError of BuildMessages into the [KIND]-tagged,
 * [ file:line:column ]-located shape the watch ERROR handler surfaces, so CSS
 * syntax errors stay navigable in the Problems panel; rolldown would otherwise
 * collapse the aggregate to its bare "Bundle failed" message.
 */
function cssErrorMessage(error: unknown): string {
	if (!(error instanceof AggregateError)) {
		return error instanceof Error ? error.message : String(error);
	}
	const lines: string[] = [];
	for (const item of error.errors) {
		lines.push(`[CSS_ERROR] ${item instanceof Error ? item.message : String(item)}`);
		const position = (item as { position?: { file?: string; line?: number; column?: number } | null }).position;
		if (position?.file !== undefined && position.line !== undefined && position.column !== undefined) {
			lines.push(`[ ${position.file}:${position.line}:${position.column} ]`);
		}
	}
	return lines.length > 0 ? lines.join("\n") : String(error);
}

/** Package stylesheets compiled into dashboard.css (Tailwind's layer files), so the third-party notices see them. */
const cssModuleIds = new Set<string>();

/**
 * Compiles a Tailwind entry through the Tailwind CLI: its at-rules (@theme,
 * @source, the tailwindcss imports) are compiler directives Bun's plain CSS
 * bundler cannot evaluate. Reruns on every rebuild, so watch mode picks up
 * class-scan changes from any source edit.
 */
async function tailwindCss(id: string, entrySource: string): Promise<string> {
	let sawPackageImport = false;
	for (const [, specifier] of entrySource.matchAll(/@import\s+["']([^"']+)["']/g)) {
		if (specifier !== undefined && !specifier.startsWith(".") && !specifier.includes("://")) {
			cssModuleIds.add(Bun.resolveSync(specifier, path.dirname(id)));
			sawPackageImport = true;
		}
	}
	if (!sawPackageImport) {
		// The notices pipeline credits the packages compiled into the emitted
		// css through this scan; a Tailwind entry that suddenly yields none
		// means the scan broke, not that the entry stopped shipping Tailwind.
		throw new Error(`[CSS_ERROR] No package imports found in Tailwind entry ${id}; the notices scan cannot credit it`);
	}
	// The installed CLI, invoked by path through the shared resolver: `bun x
	// @tailwindcss/cli` re-resolved the package against the npm registry on every
	// run, making each CI bundle hostage to a registry blip.
	const proc = Bun.spawn({
		cmd: [process.execPath, tailwindCliBin(), "--input", id, ...(production ? ["--minify"] : [])],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [source, errors, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`[CSS_ERROR] Tailwind failed for ${id}\n${errors}`);
	}
	return source;
}

/** Bundles one plain stylesheet through Bun's CSS bundler. */
async function plainCss(id: string): Promise<string> {
	let bundled: Awaited<ReturnType<typeof Bun.build>>;
	try {
		bundled = await Bun.build({ entrypoints: [id], minify: production });
	} catch (error) {
		throw new Error(cssErrorMessage(error));
	}
	const stylesheets = bundled.outputs.filter((output) => output.path.endsWith(".css"));
	return (await Promise.all(stylesheets.map((output) => output.text()))).join("");
}

async function bundleCssFile(id: string): Promise<string> {
	const source = await fs.readFile(id, "utf8");
	return /@import\s+["']tailwindcss/.test(source) ? tailwindCss(id, source) : plainCss(id);
}

/**
 * Rolldown removed its native CSS bundling (rolldown/rolldown#4271), so the
 * webview's stylesheet imports resolve to empty modules here and the collected
 * files are compiled per file into the sibling stylesheet asset, in import
 * order. Bun emits no sourcemap for CSS, so the stylesheet ships without one.
 */
function stylesheetPlugin(): Plugin {
	const cssFiles: string[] = [];
	return {
		name: "emit-stylesheet",
		load(id) {
			if (!id.endsWith(".css")) {
				return null;
			}
			if (!cssFiles.includes(id)) {
				cssFiles.push(id);
			}
			// Watch mode does not track plugin-loaded modules on its own.
			this.addWatchFile(id);
			return { code: "", moduleType: "js" };
		},
		async generateBundle() {
			// Emit in entry-DFS import order, not load-callback or getModuleIds
			// order (neither follows the source): the cascade must match what the
			// imports declare, and a css import removed during watch mode is absent
			// from the graph walk so the emitted stylesheet loses it too.
			const collected = new Set(cssFiles);
			const order: string[] = [];
			const seen = new Set<string>();
			const visit = (id: string): void => {
				if (seen.has(id)) {
					return;
				}
				seen.add(id);
				if (collected.has(id)) {
					order.push(id);
				}
				const info = this.getModuleInfo(id);
				for (const imported of info?.importedIds ?? []) {
					visit(imported);
				}
				for (const imported of info?.dynamicallyImportedIds ?? []) {
					visit(imported);
				}
			};
			for (const id of this.getModuleIds()) {
				if (this.getModuleInfo(id)?.isEntry) {
					visit(id);
				}
			}
			const sheets = await Promise.all(
				order.map(async (id) => ({ id: path.relative(process.cwd(), id), css: await bundleCssFile(id) }))
			);
			assertLayersOrdered(sheets);
			this.emitFile({
				type: "asset",
				fileName: DASHBOARD_STYLESHEET_FILENAME,
				source: sheets.map((sheet) => sheet.css).join(""),
			});
		},
	};
}

/** The extension host bundle; a dir output, since rolldown refuses output.file over a graph with dynamic imports. */
const extensionOptions: BuildOptions = {
	input: "src/extension.ts",
	platform: "node",
	external: ["vscode"],
	tsconfig: false,
	transform: { target: "es2022", define: buildDefines },
	output: {
		dir: "dist",
		entryFileNames: "extension.js",
		// The gpt-tokenizer encodings are dynamic imports so their multi-megabyte rank data lands here, not in the entry.
		chunkFileNames: "chunks/[name].js",
		format: "cjs",
		minify: production,
		sourcemap: production ? "hidden" : true,
	},
};

/** The dashboard webview bundle: browser code, React through the automatic JSX runtime, everything inlined. */
const webviewOptions: BuildOptions = {
	input: "src/webview/dashboard/index.tsx",
	platform: "browser",
	plugins: [stylesheetPlugin()],
	// This script is the bundle's single configuration authority: tsconfig
	// discovery stays off so the explicit jsx/target pins below cannot
	// conflict with (or silently follow) a tsconfig.
	tsconfig: false,
	transform: {
		target: "es2022",
		jsx: { runtime: "automatic", importSource: "react" },
		define: {
			...buildDefines,
			// Rolldown never defines NODE_ENV on its own; without this every build would ship React's development build.
			"process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
		},
	},
	output: {
		dir: WEBVIEW_DIST_SEGMENTS.join("/"),
		entryFileNames: DASHBOARD_BUNDLE_FILENAME,
		format: "iife",
		minify: production,
		sourcemap: production ? "hidden" : true,
	},
};

/** Both bundles, built or watched together so one pass reports both. */
const builds = [extensionOptions, webviewOptions];

if (watchMode) {
	const watcher = watch(builds);
	// Print the begin/end markers and the error shape the inline problem matcher
	// in .vscode/tasks.json watches for. The end marker must follow a failed pass
	// too - the F5 preLaunchTask waits on it - so the ERROR branch prints it and
	// a following END is deduplicated.
	let errored = false;
	watcher.on("event", (event) => {
		switch (event.code) {
			case "START":
				errored = false;
				console.log("[watch] build started");
				break;
			case "BUNDLE_END":
				void event.result.close();
				break;
			case "ERROR": {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes
				const message = event.error.message.replace(/\u001b\[[0-9;]*m/g, "");
				// The first [KIND]-tagged diagnostic line (rolldown's own, or a
				// wrapped [CSS_ERROR] from the stylesheet plugin) reads better
				// in the Problems panel than the aggregate "Build failed" header.
				const diagnostic = message.split("\n").find((line) => /^(?:Error: )?\[[A-Z_]+\]/.test(line));
				console.error(`✘ [ERROR] ${diagnostic ?? message.split("\n", 1)[0]}`);
				// Rolldown renders locations inside its code frame; surface the
				// first one on the matcher's own `file:line:column:` line so the
				// Problems panel can navigate to it.
				const location = message.match(/\[ ?([^[\]\n]+):(\d+):(\d+) ?\]/);
				if (location) {
					console.error(`    ${location[1].trim()}:${location[2]}:${location[3]}:`);
				}
				console.error(message);
				errored = true;
				console.log("[watch] build finished");
				void event.result.close();
				break;
			}
			case "END":
				if (!errored) {
					console.log("[watch] build finished");
				}
				break;
		}
	});
} else {
	const results = await Promise.all(builds.map((options) => build(options)));
	if (production) {
		// One merged module list: the third-party notices generator reads every
		// package bundled into anything the extension ships, webview and
		// compiled stylesheets included.
		const moduleIds = new Set<string>(cssModuleIds);
		for (const result of results) {
			for (const chunk of result.output) {
				if (chunk.type === "chunk") {
					for (const id of chunk.moduleIds) {
						moduleIds.add(id);
					}
				}
			}
		}
		await fs.mkdir("out", { recursive: true });
		await fs.writeFile("out/bundle-meta.json", JSON.stringify({ moduleIds: [...moduleIds].sort() }));
	}
}
