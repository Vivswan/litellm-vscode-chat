import fs from "node:fs/promises";
import type { BuildOptions, Metafile, Plugin } from "esbuild";
import esbuild from "esbuild";
import { DASHBOARD_BUNDLE_FILENAME, WEBVIEW_DIST_SEGMENTS } from "../../src/shared/webviewPaths.ts";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** Prints the begin/end markers the inline problem matcher in .vscode/tasks.json watches for. */
const watchProblemMatcherPlugin: Plugin = {
	name: "watch-problem-matcher",
	setup(build) {
		build.onStart(() => {
			console.log("[watch] build started");
		});
		build.onEnd((result) => {
			for (const error of result.errors) {
				console.error(`✘ [ERROR] ${error.text}`);
				if (error.location) {
					// esbuild columns are zero-based; VS Code problem matchers expect one-based.
					console.error(`    ${error.location.file}:${error.location.line}:${error.location.column + 1}:`);
				}
			}
			console.log("[watch] build finished");
		});
	},
};

const shared: BuildOptions = {
	bundle: true,
	minify: production,
	sourcemap: production ? "external" : "linked",
	metafile: production,
	logLevel: watch ? "silent" : "info",
	plugins: watch ? [watchProblemMatcherPlugin] : [],
};

/** The extension host bundle. */
const extensionOptions: BuildOptions = {
	...shared,
	entryPoints: ["src/extension.ts"],
	outfile: "dist/extension.js",
	external: ["vscode"],
	platform: "node",
	target: "node20",
	format: "cjs",
};

/** The dashboard webview bundle: browser code, Preact via the automatic JSX runtime, everything inlined. */
const webviewOptions: BuildOptions = {
	...shared,
	entryPoints: ["src/webview/dashboard/index.tsx"],
	outfile: [...WEBVIEW_DIST_SEGMENTS, DASHBOARD_BUNDLE_FILENAME].join("/"),
	platform: "browser",
	target: "es2022",
	format: "iife",
	jsx: "automatic",
	jsxImportSource: "preact",
};

const builds = [extensionOptions, webviewOptions];

if (watch) {
	const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
	await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
	const results = await Promise.all(builds.map((options) => esbuild.build(options)));
	if (production) {
		// One merged metafile: the third-party notices generator reads every
		// package bundled into anything the extension ships, webview included.
		const merged: Metafile = { inputs: {}, outputs: {} };
		for (const result of results) {
			if (result.metafile) {
				Object.assign(merged.inputs, result.metafile.inputs);
				Object.assign(merged.outputs, result.metafile.outputs);
			}
		}
		await fs.mkdir("out", { recursive: true });
		await fs.writeFile("out/esbuild-meta.json", JSON.stringify(merged));
	}
}
