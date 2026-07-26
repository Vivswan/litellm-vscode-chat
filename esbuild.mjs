import fs from "node:fs/promises";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** Prints the begin/end markers the inline problem matcher in .vscode/tasks.json watches for. */
const watchProblemMatcherPlugin = {
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

const options = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "dist/extension.js",
	external: ["vscode"],
	platform: "node",
	target: "node20",
	format: "cjs",
	minify: production,
	sourcemap: production ? "external" : "linked",
	metafile: production,
	logLevel: watch ? "silent" : "info",
	plugins: watch ? [watchProblemMatcherPlugin] : [],
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	const result = await esbuild.build(options);
	if (production) {
		await fs.mkdir("out", { recursive: true });
		await fs.writeFile("out/esbuild-meta.json", JSON.stringify(result.metafile));
	}
}
