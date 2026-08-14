import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileDashboard, compileTheme, forcedColorsBlocks } from "./compileStyles";

const webviewDir = path.resolve(import.meta.dir, "../../../../../webview");

/**
 * What forced colours do to one transparent border.
 *
 * `named` means a forced-colors rule states the colour the author meant by
 * transparent, and the selector and declaration are the compiled shape of that
 * rule. `welcome` means the repaint is an improvement and nothing has to be
 * done. `notABorder` means the value never lands on a border: a fully
 * transparent BACKGROUND is left alone by this mode, which is what makes the
 * border case the exception. Each carries its reason.
 */
type Disposition =
	| {
			readonly kind: "named";
			readonly sheet: "theme" | "dashboard";
			/** The compiled selector of the rule that names the colour. */
			readonly selector: string;
			/** Its declaration, which has to be inside that same rule. */
			readonly declaration: string;
			readonly why: string;
	  }
	| { readonly kind: "welcome"; readonly why: string }
	| { readonly kind: "notABorder"; readonly why: string };

interface TransparentBorder {
	/** Path under src/webview/. */
	readonly file: string;
	/** The matched utility or declaration, verbatim. */
	readonly text: string;
	/** How many times that exact text appears in that file. */
	readonly count: number;
	readonly disposition: Disposition;
}

/**
 * Every transparent border the webview can draw, and what an OS forced-colors
 * mode makes of it.
 *
 * The mode repaints a border colour whether or not the author wrote it
 * transparent, while a fully transparent BACKGROUND is left alone - so
 * `transparent` as an OFF state inverts for borders and only for borders: the
 * mark the design withholds is painted, and the row, chip, or ring that was
 * meant to stand out stops being the one that does. That cost four sites before
 * anyone looked, written months apart, which is why this is a list rather than
 * four separate fixes: a new transparent border fails this test until someone
 * says which of the two things it is.
 *
 * Four spellings reach a border, so the scan reads all four: the utility on an
 * element, the inline style object beside it, the declaration in a stylesheet,
 * and a custom property that can resolve fully transparent, which is a border
 * wherever a `border-*` utility names it. A partial alpha (a color-mix into
 * transparent) is not an off state and is only listed where it lands on a
 * border directly.
 */
const TRANSPARENT_BORDERS: readonly TransparentBorder[] = [
	{
		file: "dashboard/settings.tsx",
		text: "border-l-transparent",
		count: 1,
		disposition: {
			kind: "named",
			sheet: "theme",
			selector: ".setting-row:not(.modified)",
			declaration: "border-left-color: Canvas;",
			why: "the gutter marks the modified row; painted on every row it marks nothing",
		},
	},
	{
		file: "dashboard/recordEditors.tsx",
		text: "border-transparent",
		count: 2,
		disposition: {
			kind: "welcome",
			why: "the chips are FILLED at rest and forced colours flatten the fill into the page, so the repainted border is the only thing keeping two chips from reading as one run of words; the invalid and hinted chips still outrank it with their 2px marks",
		},
	},
	{
		file: "dashboard/styles/dashboard.css",
		text: "border-bottom-color: transparent",
		count: 1,
		disposition: {
			kind: "named",
			sheet: "dashboard",
			selector: ".model-row.is-open .model-row-line",
			declaration: "border-bottom-color: Canvas;",
			why: "the open row retracts its divider so the row and its detail read as one block",
		},
	},
	{
		file: "dashboard/usage.tsx",
		text: "border-b-transparent",
		count: 1,
		disposition: {
			kind: "named",
			sheet: "theme",
			selector: String.raw`.forced-colors\:border-b-\[color\:Canvas\]`,
			declaration: "border-bottom-color: Canvas;",
			why: "the open usage line retracts its bottom edge toward its panel, the model rows' retraction on the disclosure it shares",
		},
	},
	{
		file: "dashboard/styles/dashboard.css",
		text: "border-top-color: transparent",
		count: 1,
		disposition: {
			kind: "named",
			sheet: "dashboard",
			selector: ".spinner",
			declaration: "border-top-color: Canvas;",
			why: "the spinner's gap is the animation; a complete ring rotates without appearing to move",
		},
	},
	{
		file: "dashboard/styles/theme.css",
		text: "--control-outline: transparent",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "every button, rail tab, and usage row draws it, and an edge on every control is the mode working; their selected and checked states are marked by other channels",
		},
	},
	{
		file: "dashboard/styles/theme.css",
		text: "--dropdown: var(--vscode-dropdown-border, transparent)",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "the fallback says the host declares no select edge, and the mode draws one on the control anyway",
		},
	},
	{
		file: "dashboard/styles/dashboard.css",
		text: "border: 1px solid var(--vscode-input-border, transparent)",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "same fallback on the JSON textarea: a field that looks like a field",
		},
	},
	{
		file: "dashboard/styles/dashboard.css",
		text: "border-color: color-mix(in srgb, var(--muted-foreground) 22%, transparent)",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "an alpha, not an off state: the beaten badge's hairline is a boundary either way, stated louder",
		},
	},
	{
		file: "dashboard/styles/dashboard.css",
		text: "border: 1px solid color-mix(in srgb, var(--muted-foreground) 40%, transparent)",
		count: 1,
		disposition: { kind: "welcome", why: "the provenance badge's own hairline, same reading" },
	},
	{
		file: "dashboard/styles/theme.css",
		text: "--ghost-hover: transparent",
		count: 1,
		disposition: {
			kind: "notABorder",
			why: "high contrast's ghost hover is a background, and a fully transparent background is what the mode leaves alone",
		},
	},
	{
		file: "dashboard/styles/theme.css",
		text: "--vscode-button-secondaryBackground: #00000000 !important",
		count: 1,
		disposition: {
			kind: "notABorder",
			why: "the forced dark palette restating what Dark Modern publishes for a secondary button's fill; the mode overrules the whole palette anyway",
		},
	},
];

/**
 * Every way a colour in this codebase can come out fully transparent: the
 * keyword, a hex with a zero alpha nibble or byte, and any colour function
 * given a zero alpha, in either the slash form every modern one accepts or
 * rgba()/hsla()'s fourth argument. Spelled once, because a guard that only
 * knows the word `transparent` is a guard the next `#0000` walks past. The
 * slash form is matched function-agnostically, so oklch() and color() are
 * covered before anything here uses them; underscores count as spaces, which
 * is how an arbitrary Tailwind value spells one.
 */
const ZERO_ALPHA = String.raw`0(?:\.0+)?%?`;
/** A function's argument list, allowing one level of nested calls. */
const NESTED_ARGS = String.raw`[^()]*(?:\([^()]*\)[^()]*)*`;
const TRANSPARENT_VALUE = [
	String.raw`\btransparent\b`,
	String.raw`#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)\b`,
	String.raw`\b[a-z][a-z0-9-]*\(${NESTED_ARGS}\/[\s_]*${ZERO_ALPHA}[\s_]*\)`,
	String.raw`\b(?:rgba?|hsla?)\(${NESTED_ARGS},[\s_]*${ZERO_ALPHA}[\s_]*\)`,
].join("|");

/**
 * Utility spellings of a transparent border: the named colour, every side, the
 * arbitrary-value forms with or without the `color:` hint, the arbitrary
 * PROPERTY form that writes the declaration out in full, and a zero opacity
 * modifier in any of its spellings, which makes any colour transparent without
 * naming one.
 */
const UTILITY_PATTERN = new RegExp(
	[
		String.raw`\bborder(?:-[a-z]{1,2})?-(?:transparent\b|\[[^\]]*(?:${TRANSPARENT_VALUE})[^\]]*\]|[a-z][a-z0-9-]*\/(?:${ZERO_ALPHA}\b|\[${ZERO_ALPHA}\]))`,
		String.raw`\[border[a-z-]*:[^\]]*(?:${TRANSPARENT_VALUE})[^\]]*\]`,
		// The inline style object, which no class-name pattern can see.
		String.raw`\bborder[a-z]*(?:color)?:\s*["'\`][^"'\`]*(?:${TRANSPARENT_VALUE})[^"'\`]*["'\`]`,
	].join("|"),
	"gi"
);
/**
 * Border longhands and shorthand. The lookbehind keeps the property name whole,
 * so a custom property that merely ends in "border" is read by the pattern
 * below as the token it is rather than as a declaration it is not.
 */
const DECLARATION_PATTERN = new RegExp(
	String.raw`(?<![a-z-])border[a-z-]*:[^;{}]*(?:${TRANSPARENT_VALUE})[^;{}]*`,
	"gi"
);
/**
 * Custom properties that can resolve fully transparent, which is a border
 * wherever a `border-*` utility names one. A `color-mix` into transparent is a
 * partial alpha rather than an off state, so those are left out below; where
 * one lands on a border directly, the pattern above already has it.
 */
const TOKEN_PATTERN = new RegExp(String.raw`--[a-z0-9-]+:[^;{}]*(?:${TRANSPARENT_VALUE})[^;{}]*`, "gi");

function sourceFiles(dir: string): readonly string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...sourceFiles(full));
		} else if (/\.(?:ts|tsx|css)$/.test(entry.name)) {
			found.push(full);
		}
	}
	return found;
}

/**
 * Every transparent-border site in the webview tree, as `file :: text` counts.
 *
 * CSS comments come out first and the whitespace is collapsed: these
 * stylesheets explain themselves at length, the word "border" is all over that
 * prose, a commented-out declaration draws nothing, and a declaration Biome
 * wrapped at 120 columns is the same site as one that fits on a line.
 * TypeScript comments are left in on purpose - prose there would have to spell
 * a utility name exactly to count, and a guard that fails closed on a stray
 * mention is the right way round.
 */
function scanForTransparentBorders(): Map<string, number> {
	const found = new Map<string, number>();
	for (const file of sourceFiles(webviewDir)) {
		const css = file.endsWith(".css");
		const source = readFileSync(file, "utf8");
		const scanned = css ? source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ") : source;
		// path.relative yields backslashes on Windows; the registry spells
		// forward slashes. Normalize so the key is platform-invariant - run
		// 31764220436 failed all 11 entries on spelling alone.
		const relative = path.relative(webviewDir, file).split(path.sep).join("/");
		const matches = css
			? [...scanned.matchAll(DECLARATION_PATTERN), ...scanned.matchAll(TOKEN_PATTERN)]
			: [...scanned.matchAll(UTILITY_PATTERN)];
		for (const match of matches) {
			// A token holding a partial alpha is not an off state, and the border
			// patterns have already counted the ones written onto a border.
			if (match[0].startsWith("--") && match[0].includes("color-mix")) {
				continue;
			}
			const key = `${relative} :: ${match[0].trim()}`;
			found.set(key, (found.get(key) ?? 0) + 1);
		}
	}
	return found;
}

test("every transparent border in the webview is one this list has ruled on", () => {
	// Fails closed: a new transparent border, or one more occurrence of a
	// known one, lands here as an unexplained site rather than as a mark that
	// paints itself in the one mode where it was meant to stay dark.
	const found = scanForTransparentBorders();
	const declared = new Map(TRANSPARENT_BORDERS.map((site) => [`${site.file} :: ${site.text}`, site.count]));
	expect(Object.fromEntries([...found].sort())).toEqual(Object.fromEntries([...declared].sort()));
});

/** One line of CSS text, comparable across printers: no case, no line breaks. */
function normalize(css: string): string {
	return css.replace(/\s+/g, " ").toLowerCase();
}

/** The bodies of every rule opened by `selector` in the given CSS. */
function ruleBodies(css: string, selector: string): string[] {
	// Split on the selector where a selector may START - after a brace, a comma,
	// or the beginning - so a more specific sibling (`button .spinner` beside
	// `.spinner`) is a different rule rather than another copy of this one.
	const opener = new RegExp(String.raw`(?:^|[{};,]\s*)${escapeForRegExp(normalize(selector))}\s*\{`);
	const bodies: string[] = [];
	let rest = normalize(css);
	for (let match = opener.exec(rest); match !== null; match = opener.exec(rest)) {
		rest = rest.slice(match.index + match[0].length);
		bodies.push(rest.slice(0, rest.indexOf("}")));
	}
	return bodies;
}

/** A literal string as a regular-expression source. */
function escapeForRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

test("every transparent border named as handled compiles to a forced-colors rule", async () => {
	// The other half: the list above may not claim a fix that does not exist.
	// Read from the COMPILED sheets, so a commented-out declaration, a rule the
	// compiler dropped, and a utility the source scan stopped emitting all fail
	// here - none of which source text can tell apart from a working rule.
	//
	// Only from blocks that are UNCONDITIONAL, because a rule's address is half
	// of it: the same declaration nested in a width query is a fix that stops
	// existing at every other width, and nothing else here would notice it
	// moving there. Case and whitespace are dropped, so a system colour keyword
	// and a printer's indentation are not part of the contract, and the
	// declaration is looked for anywhere in its own rule's body rather than
	// first in it.
	//
	// What this cannot prove is which rule the browser ends up using: that
	// needs an engine, not a string. The uniqueness check below is the reach of
	// the claim - one rule per selector in these blocks - and a later rule under
	// a DIFFERENT selector would still be free to win.
	const compiled = {
		theme: forcedColorsBlocks(await compileTheme()),
		dashboard: forcedColorsBlocks(await compileDashboard()),
	};
	expect(compiled.theme.length).toBeGreaterThan(0);
	expect(compiled.dashboard.length).toBeGreaterThan(0);
	for (const site of TRANSPARENT_BORDERS) {
		if (site.disposition.kind !== "named") {
			continue;
		}
		const where = `${site.file} :: ${site.text}`;
		const text = compiled[site.disposition.sheet]
			.filter((block) => block.unconditional)
			.map((block) => block.text)
			.join("\n");
		const bodies = ruleBodies(text, site.disposition.selector);
		// Once, because a second rule for the same selector further down wins,
		// and hands the off state back its system colour with the suite green.
		expect(bodies.length, where).toBe(1);
		expect(bodies[0], where).toContain(normalize(site.disposition.declaration));
	}
});
