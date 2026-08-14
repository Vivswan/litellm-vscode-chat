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

/** One compiled rule: its own declarations, plus the same placement facts. */
export interface StyleRule {
	/** The rule's whole selector list, as the printer wrote it. */
	readonly selectorList: string;
	readonly declarations: string;
	readonly context: readonly string[];
	readonly unlayered: boolean;
	readonly unconditional: boolean;
}

const FORCED_COLORS = "@media (forced-colors: active)";

/** One brace block of a compiled sheet: what opened it, and what is inside. */
interface Block {
	readonly prelude: string;
	readonly body: string;
	readonly text: string;
	readonly context: readonly string[];
}

/** Outside every cascade layer, which is what it takes to beat a utility. */
const isUnlayered = (context: readonly string[]): boolean => !context.some((prelude) => prelude.startsWith("@layer"));

/** Inside no width, container, or feature query, so it applies everywhere. */
const isUnconditional = (context: readonly string[]): boolean =>
	!context.some((prelude) => /^@(?:media|container|supports)\b/.test(prelude));

/**
 * Every brace block in a compiled sheet, with the at-rules around it.
 *
 * A brace walk rather than a parser: the alternative is a CSS parser dependency
 * for a handful of assertions. Comments and string literals are stepped over
 * rather than assumed away, since a `content: "{"` or a `{` inside a banner
 * would otherwise unbalance the stack and take every later block's address with
 * it.
 */
function blocks(css: string): readonly Block[] {
	const found: Block[] = [];
	const open: {
		readonly prelude: string;
		readonly at: number;
		readonly bodyStart: number;
		readonly context: readonly string[];
	}[] = [];
	let preludeStart = 0;
	for (let i = 0; i < css.length; i++) {
		const char = css[i];
		if (char === "/" && css[i + 1] === "*") {
			const end = css.indexOf("*/", i + 2);
			// An unterminated comment swallows the rest of the sheet, which is
			// what a browser does with one too.
			i = end === -1 ? css.length : end + 1;
			continue;
		}
		if (char === '"' || char === "'") {
			for (i++; i < css.length && css[i] !== char; i++) {
				if (css[i] === "\\") {
					i++;
				}
			}
			continue;
		}
		if (char === "{") {
			// Comments out of the prelude TEXT as well: the bundler puts a file
			// banner ahead of the at-rule it opens, and a prelude carrying one
			// answers to no pattern - which would report a block nested in a width
			// query as applying everywhere.
			const prelude = css
				.slice(preludeStart, i)
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.trim();
			open.push({ prelude, at: preludeStart, bodyStart: i + 1, context: open.map((entry) => entry.prelude) });
			preludeStart = i + 1;
		} else if (char === "}") {
			const closed = open.pop();
			preludeStart = i + 1;
			if (closed === undefined) {
				continue;
			}
			found.push({
				prelude: closed.prelude,
				body: css.slice(closed.bodyStart, i),
				text: css.slice(closed.at, i + 1).trim(),
				context: closed.context,
			});
		} else if (char === ";") {
			preludeStart = i + 1;
		}
	}
	return found;
}

/** Every forced-colors block in a compiled sheet, with the at-rules around it. */
export function forcedColorsBlocks(css: string): readonly ForcedColorsBlock[] {
	return blocks(css)
		.filter((block) => block.prelude === FORCED_COLORS)
		.map((block) => ({
			text: block.text,
			context: block.context,
			// The two questions are asked separately on purpose: what a rule can
			// BEAT is a layer question and WHEN it applies is a query one, and one
			// field answering both reads as whichever the caller assumed.
			unlayered: isUnlayered(block.context),
			unconditional: isUnconditional(block.context),
		}));
}

/**
 * Every rule whose selector list NAMES `selector` exactly, with its own
 * declarations and its placement.
 *
 * The list is split rather than searched, so a longer selector ending in this
 * one is the different rule it is rather than a second copy of it - the trap a
 * substring match falls into, and how a pin ends up passing off a rule it was
 * never written about.
 */
export function rulesFor(css: string, selector: string): readonly StyleRule[] {
	return blocks(css)
		.filter((block) => block.prelude.split(",").some((part) => part.trim() === selector))
		.map((block) => ({
			selectorList: block.prelude,
			declarations: block.body,
			context: block.context,
			unlayered: isUnlayered(block.context),
			unconditional: isUnconditional(block.context),
		}));
}
