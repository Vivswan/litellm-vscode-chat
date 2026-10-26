/**
 * The dashboard's two stylesheets, compiled the way the bundle script compiles them, plus the block extraction the
 * forced-colors pins share. A CSS assertion reading SOURCE text passes a commented-out declaration and a rule the
 * compiler dropped; what ships is the compiled sheet, so that is what a pin reads.
 */
import path from "node:path";
import { REPO_ROOT } from "../../../../util/repoRoot";
import { blocks } from "./cssBlocks";
import { tailwindCliBin } from "./tailwindCliBin";

const stylesDir = path.join(REPO_ROOT, "src/webview/dashboard/styles");
export const themeEntry = path.join(stylesDir, "theme.css");
export const dashboardEntry = path.join(stylesDir, "dashboard.css");

/** The Tailwind entry, through the same CLI `scripts/dev/bundle.mts` invokes. */
export async function compileTheme(): Promise<string> {
	const proc = Bun.spawn({
		cmd: [process.execPath, tailwindCliBin(), "--input", themeEntry],
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

/**
 * One `@media (forced-colors: active)` block of a compiled sheet. `context` decides what the block can beat and when
 * it applies: a layered copy of a rule written to overrule a utility loses to that utility, and a block nested in a
 * width query stops existing at every other width.
 */
export interface ForcedColorsBlock {
	/** The text holds the whole block as printed, prelude and braces included. */
	readonly text: string;

	/** The at-rule preludes wrapping this block, outermost first. */
	readonly context: readonly string[];

	/** Outside every layer, which is what it takes to beat a utility. */
	readonly unlayered: boolean;

	/** Inside no width, container, or feature query, so it applies everywhere. */
	readonly unconditional: boolean;
}

/**
 * One rule found by its selector. Two rules for one selector at equal specificity are settled by `start` alone, since
 * the dashboard sheet is one flat layer, so an order assertion needs the offset.
 */
export interface StyleRule {
	/** The rule's whole selector list, as the printer wrote it. */
	readonly selectorList: string;

	/** The rule's declarations, braces excluded, as the printer wrote them. */
	readonly declarations: string;

	/** The at-rule preludes wrapping this rule, outermost first. */
	readonly context: readonly string[];

	/** Outside every layer, which is what it takes to beat a utility. */
	readonly unlayered: boolean;

	/** Inside no width, container, or feature query, so it applies everywhere. */
	readonly unconditional: boolean;

	/** Where the rule's prelude starts in the compiled sheet. */
	readonly start: number;
}

export const FORCED_COLORS_QUERY = "@media (forced-colors: active)";

const isUnlayered = (context: readonly string[]): boolean => !context.some((prelude) => prelude.startsWith("@layer"));

const isUnconditional = (context: readonly string[]): boolean =>
	!context.some((prelude) => /^@(?:media|container|supports)\b/.test(prelude));

export function forcedColorsBlocks(css: string): readonly ForcedColorsBlock[] {
	return blocks(css)
		.filter((block) => block.prelude === FORCED_COLORS_QUERY)
		.map((block) => ({
			text: block.text,
			context: block.context,
			// Asked separately on purpose: what a rule can BEAT is a layer question, WHEN it applies is a query one,
			// and one field answering both reads as whichever the caller assumed.
			unlayered: isUnlayered(block.context),
			unconditional: isUnconditional(block.context),
		}));
}

/**
 * The list is split rather than substring-searched, so a longer selector ending in this one stays a different rule.
 * The split is naive about a comma inside `:is(a, b)`, which fails CLOSED: no part matches exactly, so the caller
 * finds no rule.
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
			start: block.start,
		}));
}
