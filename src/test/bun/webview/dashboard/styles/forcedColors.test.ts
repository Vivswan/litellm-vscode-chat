import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	blocks,
	compileDashboard,
	compileTheme,
	FORCED_COLORS_QUERY,
	forcedColorsBlocks,
	rulesFor,
} from "./compileStyles";

const webviewDir = path.resolve(import.meta.dir, "../../../../../webview");

/**
 * What forced colours do to one transparent border. `named`: a forced-colors
 * rule states the colour the author meant by transparent, given as that rule's
 * compiled selector and declaration. `welcome`: the repaint is an improvement.
 * `notABorder`: the value never lands on a border, and a fully transparent
 * BACKGROUND is left alone by this mode. Each carries its reason.
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
 * mode makes of it. The mode repaints a border colour whether or not the
 * author wrote it transparent, while a fully transparent BACKGROUND is left
 * alone - so `transparent` as an OFF state inverts for borders and only for
 * borders: the mark the design withholds gets painted. A new transparent
 * border fails this test until someone says which of the two things it is.
 *
 * Four spellings reach a border, so the scan reads all four: the utility, the
 * inline style object, the stylesheet declaration, and a custom property that
 * can resolve fully transparent. A partial alpha is not an off state and is
 * listed only where it lands on a border directly.
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
 * Every way a colour here can come out fully transparent: the keyword, a hex
 * with a zero alpha nibble or byte, and any colour function given a zero alpha
 * (slash form or rgba()/hsla()'s fourth argument). Spelled once, because a
 * guard that only knows the word `transparent` is one the next `#0000` walks
 * past. The slash form is function-agnostic; underscores count as spaces,
 * which is how an arbitrary Tailwind value spells one.
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
 * PROPERTY form, and a zero opacity modifier, which makes any colour
 * transparent without naming one.
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
 * Border longhands and shorthand. The lookbehind keeps the property name
 * whole, so a custom property merely ending in "border" is read by the pattern
 * below as the token it is rather than a declaration it is not.
 */
const DECLARATION_PATTERN = new RegExp(
	String.raw`(?<![a-z-])border[a-z-]*:[^;{}]*(?:${TRANSPARENT_VALUE})[^;{}]*`,
	"gi"
);
/**
 * Custom properties that can resolve fully transparent, which is a border
 * wherever a `border-*` utility names one. A `color-mix` into transparent is a
 * partial alpha rather than an off state, so those are excluded below; where
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
 * CSS comments come out first and whitespace is collapsed: a commented-out
 * declaration draws nothing, and a declaration Biome wrapped at 120 columns is
 * the same site as one that fits on a line. TypeScript comments are left in on
 * purpose - failing closed on a stray mention is the right way round.
 */
function scanForTransparentBorders(): Map<string, number> {
	const found = new Map<string, number>();
	for (const file of sourceFiles(webviewDir)) {
		const css = file.endsWith(".css");
		const source = readFileSync(file, "utf8");
		const scanned = css ? source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ") : source;
		// path.relative yields backslashes on Windows; the registry spells
		// forward slashes. Normalize so the key is platform-invariant.
		const relative = path.relative(webviewDir, file).split(path.sep).join("/");
		const matches = css
			? [...scanned.matchAll(DECLARATION_PATTERN), ...scanned.matchAll(TOKEN_PATTERN)]
			: [...scanned.matchAll(UTILITY_PATTERN)];
		for (const match of matches) {
			// A token holding a partial alpha is not an off state, and the border
			// patterns already counted the ones written onto a border.
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
	// Fails closed: a new transparent border, or one more occurrence of a known
	// one, lands here as an unexplained site.
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
	// The other half: the list may not claim a fix that does not exist. Read
	// from the COMPILED sheets, so a commented-out declaration, a dropped rule,
	// and a utility the scan stopped emitting all fail here. Only from
	// UNCONDITIONAL blocks, because a rule's address is half of it: the same
	// declaration nested in a width query stops existing at every other width.
	// Which rule the browser ends up using is beyond the claim; the uniqueness
	// check below is its reach - one rule per selector in these blocks.
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
		// Once, because a second rule for the same selector further down wins and
		// hands the off state back its system colour with the suite green.
		expect(bodies.length, where).toBe(1);
		expect(bodies[0], where).toContain(normalize(site.disposition.declaration));
	}
});

/**
 * What forced colours do to one separating background fill. `twinned`: a
 * forced-colors rule restates the boundary in a channel the mode keeps, given
 * as that rule's compiled selector and declaration. `insideBorder`: the fill
 * only tints inside a border the component already draws, and borders survive.
 * `welcome`: losing the fill costs nothing a reader needs. Each carries its
 * reason.
 */
type FillDisposition =
	| {
			readonly kind: "twinned";
			/** The compiled selector of the forced-colors rule that restates the boundary. */
			readonly selector: string;
			/** Its declaration, which has to be inside that same rule. */
			readonly declaration: string;
			readonly why: string;
	  }
	| { readonly kind: "insideBorder"; readonly why: string }
	| { readonly kind: "welcome"; readonly why: string };

interface SeparatingFill {
	/**
	 * The rule's compiled selector list, whitespace-collapsed, verbatim -
	 * prefixed by any at-rule preludes wrapping it, because a rule's address is
	 * half of it: a fill that moves into a width query is a different claim.
	 */
	readonly selector: string;
	/** The compiled background declaration, whitespace-collapsed. */
	readonly declaration: string;
	/** How many times that selector paints that exact fill. */
	readonly count: number;
	readonly disposition: FillDisposition;
}

/**
 * Every background fill the dashboard sheet paints, and what an OS
 * forced-colors mode makes of it - the transparent-border registry's inverse.
 * The mode repaints every author background to Canvas (keeping only its
 * alpha), so a component whose ONLY separation channel is a fill dissolves
 * into the page. A new fill-separated rule fails this suite until someone says
 * which of the three things it is.
 *
 * The scope is the compiled dashboard sheet's own rules, background paint
 * only. theme.css carries its own forced-colors discipline (the theme suite
 * pins it), and a fill worn as a utility class is invisible here by
 * construction - UTILITY_FILLS names the one this sweep found, but that
 * channel's census is a reviewer's job. box-shadow and a fill-less separator
 * are likewise invisible.
 */
const SEPARATING_FILLS: readonly SeparatingFill[] = [
	{
		selector: ".rail",
		declaration: "background: var(--card)",
		count: 1,
		disposition: {
			kind: "insideBorder",
			why: "the rail's border-right is its seam with the pane and survives; the fill is a surface tint behind it",
		},
	},
	{
		selector: ".pill .dot",
		declaration: "background: currentColor",
		count: 1,
		disposition: {
			kind: "twinned",
			selector: ".pill .dot",
			declaration: "background: CanvasText;",
			why: "currentColor is not a system colour, so the mode repaints the dot's only paint to Canvas and every verdict mark vanishes; the twin inks it back, and the one-shape-per-tone rules keep the tones apart",
		},
	},
	{
		selector: ".model-row:hover .model-row-line",
		declaration: "background: var(--vscode-list-hoverBackground, #80808014)",
		count: 1,
		disposition: { kind: "welcome", why: "hover feedback: the pointer is its own mark" },
	},
	{
		selector: ".model-row.is-open .model-row-line",
		declaration: "background: var(--vscode-list-hoverBackground, #80808014)",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "the open state is told twice without it - the rotated chevron and the opened detail block - and the border registry's named rule retracts the row's divider so the pair still reads as one block",
		},
	},
	{
		selector: ".model-detail",
		declaration: "background: var(--vscode-textBlockQuote-background, #80808012)",
		count: 1,
		disposition: {
			kind: "insideBorder",
			why: "the accent-rail idiom: the 2px border-left ties the detail to its opener and survives; the fill tints inside it",
		},
	},
	{
		selector: ".server-row:has( > .server-line:hover)",
		declaration: "background: var(--vscode-list-hoverBackground, #8080801f)",
		count: 1,
		disposition: { kind: "welcome", why: "hover feedback: the pointer is its own mark" },
	},
	{
		selector: '.server-row:has( > .server-line[aria-expanded="true"])',
		declaration: "background: var(--vscode-list-hoverBackground, #8080801f)",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "the open state is the rotated chevron and the opened drawer; the wash is reinforcement",
		},
	},
	{
		selector: ".server-drawer",
		declaration: "background: var(--vscode-textBlockQuote-background, #80808012)",
		count: 1,
		disposition: { kind: "insideBorder", why: "the same accent rail as .model-detail, the idiom's one geometry" },
	},
	{
		selector: ".row-diagnostic.sev-blocking",
		declaration: "background: color-mix(in srgb, var(--err) 10%, transparent)",
		count: 1,
		disposition: {
			kind: "insideBorder",
			why: "the severity rules' geometry (6px double against 2px solid against 1px dashed) ranks the tiers alone by design; the wash only says toned, and the rules' own comment already plans for the mode discarding it",
		},
	},
	{
		selector: ".row-diagnostic.sev-degraded",
		declaration: "background: color-mix(in srgb, var(--warn) 7%, transparent)",
		count: 1,
		disposition: { kind: "insideBorder", why: "the same ladder's middle rung: the 2px solid rule carries the rank" },
	},
	{
		selector: "tbody tr:hover",
		declaration: "background: var(--vscode-list-hoverBackground, transparent)",
		count: 1,
		disposition: { kind: "welcome", why: "hover feedback: the pointer is its own mark" },
	},
	{
		selector: "table.resolved-models td.actions, table.resolved-models th.actions",
		declaration: "background: var(--background)",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "the pinned Inspect column's job is OCCLUSION, not tint: columns scroll under the header cell and the body cells alike, and the mode repaints this fill to opaque Canvas, which occludes exactly the same; the sub-920px border-left seam is a border and survives on its own",
		},
	},
	{
		selector: "table.resolved-models tbody tr:hover td.actions",
		declaration:
			"background-image: linear-gradient(var(--vscode-list-hoverBackground, transparent), var(--vscode-list-hoverBackground, transparent))",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "the row hover's restatement over the pinned cell's opaque base; hover feedback the pointer marks itself, and the mode zeroing the gradient leaves the Canvas base doing the occlusion",
		},
	},
	{
		selector: ".tip-bubble",
		declaration: "background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background))",
		count: 1,
		disposition: { kind: "insideBorder", why: "the bubble's 1px hover-widget border is its outline and survives" },
	},
	{
		selector: ".catalog-results",
		declaration: "background: var(--vscode-editorHoverWidget-background)",
		count: 1,
		disposition: { kind: "insideBorder", why: "the dropdown's 1px hover-widget border is its outline" },
	},
	{
		selector: ".catalog-results button:hover, .catalog-results button.active",
		declaration: "background: var(--vscode-list-hoverBackground)",
		count: 1,
		disposition: {
			kind: "twinned",
			selector: ".catalog-results button.active",
			declaration: "background: Highlight;",
			why: "the fill is the keyboard-highlighted option's ONLY mark - the option Enter will pick - so it repaints in the platform's own selection pair; the hover half needs nothing, the pointer marks itself",
		},
	},
	{
		selector: ".group",
		declaration: "background: var(--vscode-editorWidget-background, transparent)",
		count: 1,
		disposition: { kind: "insideBorder", why: "the card's 1px border is the box; the fill tints inside it" },
	},
	{
		selector: ".record-frame",
		declaration: "background: var(--vscode-editorWidget-background, transparent)",
		count: 1,
		disposition: { kind: "insideBorder", why: "the frame's 1px border is the box, same chrome as .group" },
	},
	{
		selector: ".record-json textarea",
		declaration: "background: var(--vscode-input-background)",
		count: 1,
		disposition: {
			kind: "insideBorder",
			why: "a field: its always-present border repaints from its transparent fallback (the border registry's welcome case), a field that looks like a field",
		},
	},
	{
		selector: ".model-inspector .max-tokens",
		declaration: "background: var(--chip)",
		count: 1,
		disposition: {
			kind: "twinned",
			selector: ".model-inspector .max-tokens",
			declaration: "border: 1px solid CanvasText;",
			why: "the strip's fill was its ONLY separation from the table above it, and the one line every request obeys dissolved into the page - the instance that showed the class this list guards",
		},
	},
	{
		selector: ".scrim",
		declaration: "background: #00000073",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "the mode keeps a background's alpha, so the wash goes on dimming the inert page (toward Canvas instead of black); ranking the modal above it is its panel's border's job",
		},
	},
	{
		selector: ".slide-over",
		declaration: "background: var(--vscode-editor-background, var(--vscode-panel-background))",
		count: 1,
		disposition: {
			kind: "twinned",
			selector: ".slide-over",
			declaration: "border-left: 1px solid CanvasText;",
			why: "elevation is the shadow alone, and the mode forces shadows off while repainting the fill - a Canvas panel over a Canvas page with no edge of its own; the border restates the one edge that meets the page, the confirm dialog's own answer",
		},
	},
	{
		selector: ".confirm-dialog",
		declaration: "background: var(--vscode-editorWidget-background, var(--vscode-editor-background))",
		count: 1,
		disposition: {
			kind: "insideBorder",
			why: "its 1px border is there for exactly this mode, as its own comment says",
		},
	},
	{
		selector: ".banner-error",
		declaration: "background: var(--vscode-inputValidation-errorBackground, transparent)",
		count: 1,
		disposition: {
			kind: "insideBorder",
			why: "the banner's 1px border (severity-coloured here) is the box; the tint reinforces inside it",
		},
	},
	{
		selector: ".toast",
		declaration: "background: var(--vscode-notifications-background, var(--vscode-editorWidget-background))",
		count: 1,
		disposition: { kind: "insideBorder", why: "the toast's 1px notifications border is the box" },
	},
	{
		selector: ".filter-pill:hover",
		declaration: "background: var(--ghost-hover)",
		count: 1,
		disposition: { kind: "welcome", why: "hover feedback: the pointer is its own mark" },
	},
	{
		selector: '.filter-pill[aria-pressed="true"]',
		declaration: "background: var(--chip)",
		count: 1,
		disposition: {
			kind: "twinned",
			selector: '.filter-pill[aria-pressed="true"]',
			declaration: "border-width: 2px;",
			why: "pressed reads as filled-vs-outline and the mode flattens both; border thickness is the channel it leaves alone, with the padding handing the extra pixel back",
		},
	},
	{
		selector: ".empty-start",
		declaration: "background: var(--vscode-editorWidget-background, transparent)",
		count: 1,
		disposition: { kind: "insideBorder", why: "the guided-start card's 1px border is the box" },
	},
	{
		selector: ".notice",
		declaration: "background: var(--vscode-editorWidget-background, transparent)",
		count: 1,
		disposition: { kind: "insideBorder", why: "the callout's 1px border is the box" },
	},
	{
		selector: ".skeleton",
		declaration: "background: var(--vscode-foreground)",
		count: 1,
		disposition: {
			kind: "twinned",
			selector: ".skeleton",
			declaration: "border: 1px solid GrayText;",
			why: "12% of a repainted Canvas fill over Canvas is nothing, so the loading page rendered blank; the mode's inert colour outlines the placeholder at full opacity instead",
		},
	},
	{
		selector: "button:disabled",
		declaration: "background: var(--vscode-button-secondaryBackground, #80808040)",
		count: 1,
		disposition: {
			kind: "welcome",
			why: "the mode restyles buttons in its own vocabulary and says disabled with GrayText itself; the author fill's job is done for it",
		},
	},
	{
		selector: ".chip-popover",
		declaration: "background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background))",
		count: 1,
		disposition: { kind: "insideBorder", why: "the popover's 1px hover-widget border is its outline" },
	},
	{
		selector: ".matcher-editor .editor-footer",
		declaration: "background: var(--vscode-editor-background, var(--vscode-panel-background))",
		count: 1,
		disposition: {
			kind: "insideBorder",
			why: "the border-top draws the seam; the fill's second job - occluding rows scrolling under the sticky footer - survives, because the forced fill keeps this opaque value's alpha",
		},
	},
	{
		selector: '@media (max-width: 999.999px) .rail-nav .rail-tab[aria-selected="true"]:before',
		declaration: "background: var(--accent-hue)",
		count: 1,
		disposition: {
			kind: "twinned",
			selector: '.rail-nav .rail-tab[aria-selected="true"]:before',
			declaration: "background: Highlight;",
			why: "the collapsed rail's active bar is fill-only; the unconditional twin paints it Highlight at every width, and the narrow block's later restatement only wins the geometry argument back",
		},
	},
];

/**
 * Background declarations that carry paint: the shorthand and the two
 * longhands the mode acts on (it repaints colours and forces non-url()
 * background images to none). The positioning longhands paint nothing.
 */
const FILL_DECLARATION = /^background(?:-color|-image)?:/;

/**
 * Every background fill in the compiled dashboard sheet, as
 * `address :: declaration` counts, where the address is the rule's selector
 * prefixed by any at-rule preludes wrapping it (a fill that moves into a width
 * query is news, not the same entry). The COMPILED sheet through a
 * comment-aware brace walk, not a text grep: the compiler's spelling is the
 * one the browser gets, a commented-out declaration paints nothing, and the
 * walk knows which rules sit inside forced-colors blocks - those are the twins
 * themselves. `background: none` separates nothing.
 */
function scanForSeparatingFills(css: string): Map<string, number> {
	const found = new Map<string, number>();
	for (const block of blocks(css)) {
		if (block.prelude.startsWith("@") || block.context.includes(FORCED_COLORS_QUERY)) {
			continue;
		}
		for (const declaration of block.body.split(";")) {
			const text = declaration.replace(/\s+/g, " ").trim();
			if (!FILL_DECLARATION.test(text) || /^background(?:-color|-image)?: none$/.test(text)) {
				continue;
			}
			const address = [...block.context.filter((prelude) => !prelude.startsWith("@layer")), block.prelude]
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			const key = `${address} :: ${text}`;
			found.set(key, (found.get(key) ?? 0) + 1);
		}
	}
	return found;
}

test("every separating background fill in the dashboard sheet is one this list has ruled on", async () => {
	// Fails closed: a new background fill, or one more copy of a known one,
	// lands here as an unexplained site. Update SEPARATING_FILLS with the new
	// selector and an honest disposition - twinned (and write the forced-colors
	// rule), insideBorder, or welcome.
	const found = scanForSeparatingFills(await compileDashboard());
	const declared = new Map(SEPARATING_FILLS.map((site) => [`${site.selector} :: ${site.declaration}`, site.count]));
	expect(
		Object.fromEntries([...found].sort()),
		"a fill SEPARATING_FILLS has not ruled on, or one it claims that no longer compiles: update the list in forcedColors.test.ts"
	).toEqual(Object.fromEntries([...declared].sort()));
});

test("every fill named as twinned compiles to a forced-colors rule restating its boundary", async () => {
	// The other half, the same contract as the border registry's second test:
	// the list may not claim a twin that does not exist. Twins are read from
	// blocks unconditional apart from the forced-colors query itself, because a
	// twin nested in a width query is a boundary that stops existing at every
	// other width. Which rule the browser ends up using is beyond the claim;
	// the uniqueness check is its reach - one qualifying rule per selector.
	const compiled = await compileDashboard();
	for (const site of SEPARATING_FILLS) {
		if (site.disposition.kind !== "twinned") {
			continue;
		}
		const where = `${site.selector} :: ${site.declaration}`;
		const twins = rulesFor(compiled, site.disposition.selector).filter(
			(rule) =>
				rule.context.includes(FORCED_COLORS_QUERY) &&
				rule.context.every((prelude) => prelude.startsWith("@layer") || prelude === FORCED_COLORS_QUERY)
		);
		expect(twins.length, where).toBe(1);
		for (const twin of twins) {
			expect(normalize(twin.declarations), where).toContain(normalize(site.disposition.declaration));
		}
	}
});

/**
 * Separating fills in the UTILITY channel: a fill worn as a Tailwind class
 * never appears in the dashboard sheet, so the scan above cannot see it. Named
 * here instead and proven from both ends - the source must pair the fill with
 * its `forced-colors:` twin in one class list (deleting either side fails the
 * count), and the twin must compile into the theme sheet's forced-colors
 * block, so a typo'd variant fails here rather than shipping.
 */
interface UtilityFill {
	/** Path under src/webview/. */
	readonly file: string;
	/** The class list pairing the fill with its twin, verbatim. */
	readonly text: string;
	/** How many times that exact text appears in that file. */
	readonly count: number;
	/** The twin utility's compiled selector in the theme sheet. */
	readonly twinSelector: string;
	/** Its declaration, inside that selector's forced-colors rule. */
	readonly twinDeclaration: string;
	readonly why: string;
}

const UTILITY_FILLS: readonly UtilityFill[] = [
	{
		file: "dashboard/serverEditPage.tsx",
		text: '"mt-2 mb-3 h-px bg-border forced-colors:bg-[CanvasText]"',
		count: 1,
		twinSelector: String.raw`.forced-colors\:bg-\[CanvasText\]`,
		twinDeclaration: "background-color: CanvasText;",
		why: "the form-section seam is a 1px rule whose only paint is the fill; repainted to Canvas it vanished under every section header at once",
	},
];

test("every utility-channel separating fill pairs its twin in source and the twin compiles", async () => {
	for (const site of UTILITY_FILLS) {
		const where = `${site.file} :: ${site.text}`;
		const source = readFileSync(path.join(webviewDir, site.file), "utf8");
		expect(source.split(site.text).length - 1, where).toBe(site.count);
	}
	const theme = await compileTheme();
	for (const site of UTILITY_FILLS) {
		const twins = rulesFor(theme, site.twinSelector).filter((rule) => rule.context.includes(FORCED_COLORS_QUERY));
		expect(twins.length, site.twinSelector).toBe(1);
		for (const twin of twins) {
			expect(normalize(twin.declarations), site.twinSelector).toContain(normalize(site.twinDeclaration));
		}
	}
});
