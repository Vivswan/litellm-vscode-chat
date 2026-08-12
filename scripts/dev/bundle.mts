/// <reference types="bun" />
import fs from "node:fs/promises";
import type { BuildOptions, Plugin } from "rolldown";
import { build, watch } from "rolldown";
import {
	DASHBOARD_BUNDLE_FILENAME,
	DASHBOARD_STYLESHEET_FILENAME,
	WEBVIEW_DIST_SEGMENTS,
} from "../../src/shared/webviewPaths.ts";

const watchMode = process.argv.includes("--watch");
const production = process.argv.includes("--production");

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

/**
 * Rolldown removed its native CSS bundling (rolldown/rolldown#4271), so the
 * webview's stylesheet imports resolve to empty modules here and the collected
 * files go through Bun's CSS bundler into the sibling stylesheet asset. Bun
 * emits no sourcemap for CSS, so unlike the JS outputs the stylesheet ships
 * without one (no .map ever reaches the VSIX either way).
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
			// Filter to the current graph: a css import removed during watch
			// mode stays in cssFiles (load never reruns for it) but leaves the
			// module graph, and must leave the emitted stylesheet with it.
			const graph = new Set(this.getModuleIds());
			const entrypoints = cssFiles.filter((id) => graph.has(id));
			let bundled: Awaited<ReturnType<typeof Bun.build>>;
			try {
				bundled = await Bun.build({ entrypoints, minify: production });
			} catch (error) {
				throw new Error(cssErrorMessage(error));
			}
			const stylesheets = bundled.outputs.filter((output) => output.path.endsWith(".css"));
			const source = (await Promise.all(stylesheets.map((output) => output.text()))).join("");
			this.emitFile({ type: "asset", fileName: DASHBOARD_STYLESHEET_FILENAME, source });
		},
	};
}

/** The extension host bundle. */
const extensionOptions: BuildOptions = {
	input: "src/extension.ts",
	platform: "node",
	external: ["vscode"],
	tsconfig: false,
	transform: { target: "es2022" },
	output: {
		file: "dist/extension.js",
		format: "cjs",
		minify: production,
		sourcemap: production ? "hidden" : true,
	},
};

/**
 * The dashboard webview bundle: browser code, React via the automatic JSX
 * runtime, everything inlined. Rolldown never defines NODE_ENV on its own, so
 * the define below decides whether React's production or development build is
 * bundled; without it every build would ship the development build.
 */
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
		define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
	},
	output: {
		dir: WEBVIEW_DIST_SEGMENTS.join("/"),
		entryFileNames: DASHBOARD_BUNDLE_FILENAME,
		format: "iife",
		minify: production,
		sourcemap: production ? "hidden" : true,
	},
};

const builds = [extensionOptions, webviewOptions];

if (watchMode) {
	const watcher = watch(builds);
	// Print the begin/end markers and the error shape the inline problem
	// matcher in .vscode/tasks.json watches for. The end marker must follow a
	// failed pass too - the F5 preLaunchTask waits on it - so the ERROR branch
	// prints it and a following END (rolldown 1.2.4 fires one, its docs do not
	// promise it) is deduplicated.
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
				// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes from rolldown's diagnostics
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
		// package bundled into anything the extension ships, webview included.
		const moduleIds = new Set<string>();
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
