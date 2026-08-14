/**
 * The dashboard's two stylesheets, compiled the way the bundle script compiles
 * them, plus the block extraction the forced-colors pins share.
 *
 * A CSS assertion that reads source text passes a commented-out declaration and
 * a rule the compiler dropped, which is the whole failure these helpers exist to
 * prevent: what ships is the compiled sheet, so that is what a pin reads.
 */
import path from "node:path";

const stylesDir = path.resolve(import.meta.dir, "../../../../../webview/dashboard/styles");
export const themeEntry = path.join(stylesDir, "theme.css");
export const dashboardEntry = path.join(stylesDir, "dashboard.css");

/** The Tailwind entry, through the same CLI `scripts/dev/bundle.mts` invokes. */
export async function compileTheme(): Promise<string> {
	const proc = Bun.spawn({
		cmd: [process.execPath, "x", "@tailwindcss/cli", "--input", themeEntry],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, errors, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`Tailwind failed for ${themeEntry}\n${errors}`);
	}
	return output;
}

/** The plain stylesheet, through Bun's CSS bundler, as the bundle script does. */
export async function compileDashboard(): Promise<string> {
	const bundled = await Bun.build({ entrypoints: [dashboardEntry] });
	const stylesheets = bundled.outputs.filter((output) => output.path.endsWith(".css"));
	if (stylesheets.length === 0) {
		throw new Error(`Bun emitted no stylesheet for ${dashboardEntry}`);
	}
	return (await Promise.all(stylesheets.map((output) => output.text()))).join("");
}

/** One compiled `@media (forced-colors: active)` block and where it sits. */
export interface ForcedColorsBlock {
	readonly text: string;
	/**
	 * The at-rule preludes wrapping this block, outermost first. Where a rule
	 * sits decides what it can beat and when it applies at all: a layered copy
	 * of a rule written to overrule a utility loses to that utility, and a block
	 * nested in a width query stops existing at every other width.
	 */
	readonly context: readonly string[];
	/** Outside every layer, which is what it takes to beat a utility. */
	readonly unlayered: boolean;
	/** Inside no width, container, or feature query, so it applies everywhere. */
	readonly unconditional: boolean;
}

const FORCED_COLORS = "@media (forced-colors: active)";

/**
 * Every forced-colors block in a compiled sheet, with the at-rules around it.
 *
 * A brace walk rather than a parser: the alternative is a CSS parser dependency
 * for four assertions. String literals are stepped over rather than assumed
 * away, since a `content: "{"` would otherwise unbalance the stack and take
 * every later block's address with it.
 */
export function forcedColorsBlocks(css: string): readonly ForcedColorsBlock[] {
	const blocks: ForcedColorsBlock[] = [];
	const open: { readonly prelude: string; readonly at: number; readonly context: readonly string[] }[] = [];
	let preludeStart = 0;
	for (let i = 0; i < css.length; i++) {
		const char = css[i];
		if (char === '"' || char === "'") {
			for (i++; i < css.length && css[i] !== char; i++) {
				if (css[i] === "\\") {
					i++;
				}
			}
			continue;
		}
		if (char === "{") {
			// Comments out of the prelude: the bundler puts a file banner ahead of
			// the at-rule it opens, and a prelude carrying one answers to no
			// pattern - which would report a block nested in a width query as
			// applying everywhere.
			const prelude = css
				.slice(preludeStart, i)
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.trim();
			open.push({ prelude, at: preludeStart, context: open.map((entry) => entry.prelude) });
			preludeStart = i + 1;
		} else if (char === "}") {
			const closed = open.pop();
			preludeStart = i + 1;
			if (closed?.prelude !== FORCED_COLORS) {
				continue;
			}
			blocks.push({
				text: css.slice(closed.at, i + 1).trim(),
				context: closed.context,
				unlayered: closed.context.length === 0,
				unconditional: !closed.context.some((prelude) => /^@(?:media|container|supports)\b/.test(prelude)),
			});
		} else if (char === ";") {
			preludeStart = i + 1;
		}
	}
	return blocks;
}
