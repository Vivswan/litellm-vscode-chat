import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compileDashboard, compileTheme, dashboardEntry, forcedColorsBlocks, themeEntry } from "./compileStyles";

/**
 * Load-bearing utilities the ui components consume: each one must compile
 * from the source scan, or the styled primitives silently lose that piece of
 * their look (Tailwind's @source scan fails silently). A missing name here
 * means the scan broke or the component stopped using the utility - update
 * deliberately either way.
 */
const REQUIRED_UTILITIES = [
	"inline-flex",
	"cursor-pointer",
	"rounded-sm",
	"rounded-xl",
	"border-control-outline",
	"text-accent-hue",
	"hover:bg-accent-soft",
	"text-err-quiet",
	"hover:bg-err-wash",
	"hover:text-err-strong",
	"hover:bg-ghost-hover",
	"text-muted-foreground",
	// The spend meter's two halves. The axis is the only thing marking the
	// 100% extent, and the forced-colors fill is the only thing keeping a
	// budgeted meter from reading as a measured zero when backgrounds flatten
	// to Canvas - both vanish silently if the scan stops emitting them.
	"border-axis",
	"forced-colors:bg-[Highlight]",
	// The record chips' resting state under forced colors, where a border
	// colour is repainted whether or not the author wrote it transparent:
	// without this the hairline the row offers on approach is on every chip
	// at rest, and the invalid and hinted ones stop being the marked ones.
	"forced-colors:border-[color:Canvas]",
	// Secondary's resting affordance. It is the only thing that says a
	// secondary button is a button before the pointer arrives, and the
	// component suites run without a cascade, so they can only assert that the
	// class name is on the element - if the scan stopped emitting the rule,
	// every one of those buttons would go back to reading as prose with the
	// whole suite green.
	"underline",
	"decoration-dotted",
	"underline-offset-2",
	"disabled:no-underline",
	"aria-disabled:no-underline",
	"border-input",
	"bg-input-background",
	"placeholder:text-input-placeholder",
	"aria-invalid:border-input-invalid",
	"bg-dropdown-background",
	"accent-primary",
	"bg-warn-chip",
	"text-warn-chip-foreground",
	"bg-chip",
	"focus-visible:outline-ring",
	"disabled:opacity-60",
	"disabled:bg-transparent",
	"disabled:text-disabled-foreground",
	// The accent picker's swatches: every hue paints, not just the live one,
	// the checked ring is the foreground so it reads against any of them, and
	// the sample keeps its color where an OS forced-colors mode would repaint
	// all four the same.
	"bg-hue-blue",
	"bg-hue-violet",
	"bg-hue-teal",
	"bg-hue-amber",
	"sr-only",
	"has-[:checked]:outline-foreground",
	"forced-color-adjust-none",
	// The copy action's reveal wrapper (models.tsx): the whole class set,
	// because the reveal is invisible to the component suites (happy-dom
	// runs no cascade) and a scan regression would strand the copy button
	// hidden forever - or painted forever - with every test green.
	"opacity-0",
	"transition-opacity",
	"motion-reduce:transition-none",
	"group-hover/row:opacity-100",
	"group-focus-within/row:opacity-100",
	"@max-[560px]/pane:opacity-100",
	// The record editors' settings.json jump (recordEditors.tsx) reveals on
	// its heading's hover band the same way: a scan regression would strand
	// the jump painted only below 560px, with every component test green.
	"group-hover/head:opacity-100",
	"group-focus-within/head:opacity-100",
] as const;

/** A utility name as it appears escaped in a compiled selector. */
function escapedSelector(utility: string): string {
	return `.${utility.replace(/[^a-zA-Z0-9-]/g, (char) => `\\${char}`)}`;
}

/** How many times `needle` appears in `haystack`, as a plain substring. */
function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test("the source scan compiles every utility the ui components depend on", async () => {
	const output = await compileTheme();
	// An empty utilities layer would mean the @source paths stopped resolving
	// (they fail silently inside Tailwind), so check names, not just success.
	for (const utility of REQUIRED_UTILITIES) {
		expect(output).toContain(escapedSelector(utility));
	}
});

test("the palette and radius resets keep Tailwind's defaults unreachable", async () => {
	const output = await compileTheme();
	// Every color in the design system is a var() chain onto host tokens;
	// Tailwind's own palette is oklch-valued, so one oklch() in the output
	// means a hardcoded palette color (bg-red-500, say) compiled.
	expect(output).not.toContain("oklch(");
	// The radius scale maps onto --radius; Tailwind's default rem-based scale
	// must stay unreachable so an off-scale rounded-2xl cannot compile.
	expect(output).not.toMatch(/border-radius:\s*[\d.]+rem/);
});

test("the cascade puts the dashboard stylesheet below utilities", async () => {
	// The order declaration lives in theme.css and the wrap in dashboard.css;
	// together they are the contract that a utility always beats a stylesheet
	// rule. There is exactly ONE layer wrap: the dashboard rules are one flat
	// layer whose internal order is load-bearing (the narrow overrides at the
	// file's tail win their equal-specificity arguments by coming later).
	expect(readFileSync(themeEntry, "utf8")).toContain("@layer theme, base, components, utilities;");
	const dashboard = readFileSync(dashboardEntry, "utf8");
	expect(dashboard).toContain("@layer components {");
	expect([...dashboard.matchAll(/@layer/g)]).toHaveLength(1);
});

test("source order keeps every narrow override after the full-width rule it beats", () => {
	// The dashboard stylesheet is one flat layer, so every equal-specificity,
	// same-property argument is settled by source order alone - the file's
	// header calls that ordering load-bearing, and this is the assertion
	// behind the comment. Each pair below is an argument that was settled
	// wrongly at least once (the rail's collapse, the slide-over's narrow
	// width, the server actions' always-painted fold, the rail icons, a
	// folded row's placement): the base spelling must precede the override,
	// or the override silently loses at exactly the width it exists for.
	// Anchors are asserted UNIQUE declaration texts, so a reworded or
	// duplicated rule fails loudly here instead of quietly unpinning the
	// guard, and every override must also fall below the banner that divides
	// the full-width region from the narrow tail.
	const sheet = readFileSync(dashboardEntry, "utf8");
	// One banner divides the full-width region from the narrow tail.
	const bannerAt = sheet.indexOf("The narrow rules: what the dashboard does");
	expect(bannerAt).toBeGreaterThan(-1);
	expect(sheet.indexOf("The narrow rules", bannerAt + 1)).toBe(-1);
	const pairs: readonly (readonly [string, string])[] = [
		// the rail's full width, then its collapsed width
		["flex: 0 0 216px", "flex: 0 0 48px"],
		// the slide-over's resting width, then its collapsed-rail width
		["width: min(680px, 94vw)", "width: min(680px, calc(100% - 49px))"],
		// the server actions hidden at rest, then the folded cluster's
		// always-painted state - the very opacity collision being guarded
		["opacity: 0;\n\t\ttransition: opacity 120ms ease-out;", "justify-content: flex-end;\n\t\t\topacity: 1;"],
		// the rail icons unpainted at full width, then painted collapsed
		[".rail-icon {\n\t\tdisplay: none;", ".rail-icon {\n\t\t\tdisplay: flex;"],
		// the server name's full-width placement, then its three-line re-place
		[".server-name {\n\t\tgrid-area: 1 / 1;", "grid-area: 1 / 1 / auto / 3"],
	];
	for (const [base, override] of pairs) {
		const baseAt = sheet.indexOf(base);
		const overrideAt = sheet.indexOf(override);
		expect(baseAt, `base anchor missing: ${base}`).toBeGreaterThan(-1);
		expect(overrideAt, `override anchor missing: ${override}`).toBeGreaterThan(-1);
		expect(sheet.lastIndexOf(base), `base anchor is not unique: ${base}`).toBe(baseAt);
		expect(sheet.lastIndexOf(override), `override anchor is not unique: ${override}`).toBe(overrideAt);
		expect(baseAt, `override precedes its base rule: ${override}`).toBeLessThan(overrideAt);
		expect(bannerAt, `override sits above the narrow banner: ${override}`).toBeLessThan(overrideAt);
	}
});

test("no minted utility collides with a class the dashboard stylesheet styles", async () => {
	const output = await compileTheme();
	// Utilities outrank the components layer, so a utility whose name matches a
	// dashboard.css class would silently restyle every element carrying it
	// (the scan also mints utilities from incidental word tokens). Compare
	// against the classes the dashboard stylesheet actually styles.
	const minted = new Set([...output.matchAll(/^\s*\.([A-Za-z][A-Za-z0-9-]*)[\s{,:]/gm)].map((match) => match[1] ?? ""));
	const dashboardClasses = new Set(
		[...readFileSync(dashboardEntry, "utf8").matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((match) => match[1] ?? "")
	);
	// The size floors keep both extractions honest; an extractor finding
	// nothing would prove nothing.
	expect(minted.size).toBeGreaterThan(REQUIRED_UTILITIES.length);
	expect(dashboardClasses.size).toBeGreaterThan(100);
	expect([...minted].filter((utility) => dashboardClasses.has(utility))).toBeEmpty();
});

test("the hidden attribute beats a display utility", async () => {
	const output = await compileTheme();
	// [hidden] is a user-agent rule, so an element carrying `grid` or `flex`
	// stays visible with the attribute set - and hiding by attribute is how the
	// settings filter and the record editors hide a row without unmounting the
	// draft inside it. happy-dom runs no cascade, so the component suites cannot
	// catch this; the stylesheet is the only place it can be pinned.
	// Anchored at the start of a line: an unanchored match begins at the
	// `[hidden]` inside the explanatory comment above the rule and walks to the
	// real rule's brace, so the assertions pass off the comment's own words -
	// deleting the exclusion entirely left this green.
	const rule = /^\s*\[hidden\][^{]*\{[^}]*\}/m.exec(output)?.[0] ?? "";
	expect(rule.replace(/\s+/g, "")).toContain("display:none!important");
	// Case-insensitively, because the user agent matches the value that way:
	// hidden="UNTIL-FOUND" is until-found to Chrome and must stay findable.
	expect(rule).toMatch(/until-found"\s*i/);
	// And the utility it has to beat really compiles.
	expect(output).toContain("display: grid");
});

test("the disabled utilities settle after the hover ones", async () => {
	const output = await compileTheme();
	// Disabled and hover utilities carry equal specificity, so a hovered
	// disabled control only reads as disabled because Tailwind emits the
	// disabled variants later. The vocabulary leans on that: every variant
	// answers hover with a fill, and disabled has to overrule all of them.
	const lastHover = Math.max(
		output.indexOf(`${escapedSelector("hover:bg-accent-soft")}:hover`),
		output.indexOf(`${escapedSelector("hover:bg-ghost-hover")}:hover`),
		output.indexOf(`${escapedSelector("hover:bg-err-wash")}:hover`)
	);
	expect(lastHover).toBeGreaterThan(-1);
	for (const disabled of ["disabled:bg-transparent", "disabled:text-disabled-foreground"]) {
		expect(output.indexOf(`${escapedSelector(disabled)}:disabled`)).toBeGreaterThan(lastHover);
	}
});

test("the scrim re-enables pointer events Radix takes away", () => {
	// Radix's modal layer sets pointer-events:none on <body> and restores it
	// only on the dialog node. The scrim is the dialog's sibling, so without an
	// explicit auto it inherits none and click-to-close dies in a real browser.
	// happy-dom does no hit-testing, so a synthesized click still passes
	// whatever pointer-events says - this rule is the only place the contract
	// can be pinned.
	const dashboard = readFileSync(dashboardEntry, "utf8");
	const scrimRule = /\.scrim\s*\{[^}]*\}/.exec(dashboard)?.[0];
	expect(scrimRule).toBeDefined();
	expect(scrimRule).toContain("pointer-events: auto");
});

/** The body of the ONE rule `selector` opens in `css`, uniqueness asserted. */
function onlyRuleBody(css: string, selector: string): string {
	// Anchored after a brace or semicolon, so a longer selector ending in this
	// one (`.rail-state .rail-status .dot` beside `.rail-status .dot`) is the
	// different rule it is rather than a second copy of this one.
	const opener = new RegExp(String.raw`[{};]\s*${selector.replace(/\./g, "\\.")}\s*\{([^}]*)\}`, "g");
	const bodies = [...css.matchAll(opener)].map((match) => match[1] ?? "");
	expect(bodies, `expected exactly one \`${selector}\` rule`).toHaveLength(1);
	return bodies[0] ?? "";
}

test("one shape per tone: the pill dots' shape vocabulary survives compilation", async () => {
	// The dots are the only channel ranking two rows whose verdict text agrees
	// (stale-but-serving and healthy both say "Connected"), so the shapes carry
	// the reading for anyone who cannot separate green from amber. happy-dom
	// runs no cascade, so no component suite would notice a shape dropping out
	// - the compiled sheet is the only place the vocabulary can be pinned.
	// Values are asserted as Bun's printer canonicalizes them (`transparent`
	// on a background prints as `none`, a shorthand's currentColor is elided).
	const compiled = await compileDashboard();
	// The forced-colors repaints reuse these selectors for paint alone; drop
	// those blocks so each shape rule asserts unique in the ordinary cascade,
	// where a second rule for the same selector would silently win.
	const output = forcedColorsBlocks(compiled).reduce((css, block) => css.replace(block.text, ""), compiled);
	// One size property, circle by default: every tone rides the same box.
	const base = onlyRuleBody(output, ".pill .dot");
	expect(base).toContain("--dot-size: 8px");
	expect(base).toContain("width: var(--dot-size)");
	expect(base).toContain("height: var(--dot-size)");
	expect(base).toContain("border-radius: 50%");
	expect(base).toContain("background: currentColor");
	// warn is a triangle: the clip-path is the shape, and the radius reset is
	// what lets a clipped corner exist at all.
	const warn = onlyRuleBody(output, ".pill.tone-warn .dot");
	expect(warn).toContain("clip-path: polygon(50% 0%, 100% 100%, 0% 100%)");
	expect(warn).toContain("border-radius: 0");
	// error a square, muted a hollow ring.
	expect(onlyRuleBody(output, ".pill.tone-error .dot")).toContain("border-radius: 2px");
	const muted = onlyRuleBody(output, ".pill.tone-muted .dot");
	expect(muted).toContain("background: none");
	expect(muted).toContain("border: 1.5px solid");
	// The collapsed rail scales the whole vocabulary through the shared size
	// property and declares nothing else: a shape property of its own here is
	// how the rail's dot and the rows' fork apart again.
	expect(onlyRuleBody(output, ".rail-status .dot").trim()).toBe("--dot-size: 11px;");
});

/**
 * Tokens a forced palette deliberately leaves alone. The font trio is the
 * reader's editor setting rather than a theme, and the two contrast tokens are
 * undefined in every ordinary theme - the chains that read them are written
 * for exactly that absence, and a forced theme is never high contrast.
 */
const UNFORCED_HOST_TOKENS = new Set([
	"--vscode-font-family",
	"--vscode-font-size",
	"--vscode-editor-font-family",
	"--vscode-contrastBorder",
	"--vscode-contrastActiveBorder",
]);

/** The declarations inside one `&[data-theme="..."]` block of theme.css. */
function forcedBlock(theme: "dark" | "light"): string {
	const source = readFileSync(themeEntry, "utf8");
	const block = new RegExp(`&\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\t\\}`).exec(source)?.[1];
	expect(block, `theme.css has no &[data-theme="${theme}"] block`).toBeDefined();
	return block ?? "";
}

test("a forced theme redefines every host token the stylesheets read", () => {
	// Forcing a theme means replacing the HOST's variables, because that is what
	// every consumer reads: the semantic mapping, the dashboard stylesheet's
	// direct reads, and the utilities alike. A token the palettes miss keeps its
	// value from the editor's theme, which is how a forced dark dashboard ends
	// up a light page with one black input.
	const read = new Set<string>();
	for (const entry of [themeEntry, dashboardEntry]) {
		for (const match of readFileSync(entry, "utf8").matchAll(/var\((--vscode-[A-Za-z0-9-]+)/g)) {
			if (!UNFORCED_HOST_TOKENS.has(match[1] ?? "")) {
				read.add(match[1] ?? "");
			}
		}
	}
	expect(read.size).toBeGreaterThan(40);
	for (const theme of ["dark", "light"] as const) {
		const defined = new Set(
			[...forcedBlock(theme).matchAll(/^\s*(--vscode-[A-Za-z0-9-]+):/gm)].map((match) => match[1] ?? "")
		);
		expect([...read].filter((token) => !defined.has(token)).sort()).toBeEmpty();
	}
});

test("high contrast wins: nothing either appearance setting drives escapes the guard", async () => {
	// The rule is structural rather than remembered - a palette or hue added
	// inside the guarded block is covered and there is no outside to add one to
	// - so the test is that no rule keyed on either setting's attribute compiles
	// without the guard on it. Both attributes, because the accent is a
	// preference exactly as much as the theme is.
	const output = await compileTheme();
	const guard = ":not(:has(body.vscode-high-contrast, body.vscode-high-contrast-light))";
	const keyed = [...output.matchAll(/^([^\n{]*\[data-(?:theme|accent)=[^\n{]*)\{/gm)].map((match) => match[1] ?? "");
	// `auto` is the one value that means "no choice was made", so its rule is
	// the host-derived path and belongs outside: that is how a high contrast
	// host keeps reaching it. Exactly one, so a second unguarded shape shows up
	// here rather than passing as another exemption.
	const [hostDerived, forced] = [
		keyed.filter((selector) => selector.includes('[data-theme="auto"]')),
		keyed.filter((selector) => !selector.includes('[data-theme="auto"]')),
	];
	expect(hostDerived).toHaveLength(1);
	// An exact count, not a floor: a floor lets one more unguarded rule through,
	// which is the mistake this test exists to catch. Update it deliberately.
	expect(forced).toHaveLength(12);
	expect(forced.filter((selector) => !selector.includes(guard))).toBeEmpty();
});

test("every forced host token carries !important, because inline styles are what it is fighting", async () => {
	// VS Code writes --vscode-* onto the document element's inline style, and an
	// inline declaration outranks every author rule on that element. A forced
	// palette without !important loses in the editor while looking correct in
	// any render that delivers the tokens as CSS. This is the whole mechanism,
	// so it is pinned per declaration rather than trusted.
	for (const theme of ["dark", "light"] as const) {
		const declarations = [...forcedBlock(theme).matchAll(/^\s*(--vscode-[A-Za-z0-9-]+):\s*([^;]+);/gm)];
		expect(declarations.length).toBeGreaterThan(50);
		expect(
			declarations.filter((match) => !(match[2] ?? "").endsWith("!important")).map((match) => match[1])
		).toBeEmpty();
	}
	// And the tokens we own carry none: nothing shadows them, and !important
	// there would only make them harder to override later.
	const ours = [...forcedBlock("light").matchAll(/^\s*(--(?!vscode-)[a-z-]+):\s*([^;]+);/gm)];
	expect(ours.length).toBeGreaterThan(0);
	expect(ours.filter((match) => (match[2] ?? "").includes("!important")).map((match) => match[1])).toBeEmpty();
});

test("the two light blocks agree on everything a light surface changes", () => {
	// One surface reached two ways: the host-derived rule (auto, and high
	// contrast of either kind) and the forced light block. They are separate
	// rules because they match on different things, so only a test keeps them
	// saying the same thing - and it compares the whole list rather than the
	// three tokens that happen to be there today, so a light-only token added
	// to one block has to reach the other.
	const source = readFileSync(themeEntry, "utf8");
	const hostDerived = /body\.vscode-high-contrast-light \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
	// The forced block additionally carries the host palette (--vscode-*) and
	// its color-scheme; those are what forcing a theme means, not what being
	// light means.
	const ownTokens = (block: string): string[] =>
		[...block.matchAll(/^\s*(--(?!vscode-)[a-z-]+):\s*([^;]+);/gm)]
			.map((match) => `${match[1]}: ${match[2]?.trim()}`)
			.sort();
	// A floor, not a count: it only has to be big enough that an extraction
	// finding nothing cannot pass the equality below vacuously.
	expect(ownTokens(hostDerived).length).toBeGreaterThanOrEqual(4);
	expect(ownTokens(forcedBlock("light"))).toEqual(ownTokens(hostDerived));
});

test("severity as text resolves to the readable tier, as fills to the raw hue", async () => {
	// The raw hues are tuned for a dark editor: on white the passing green
	// measures 2.0:1, the warning 3.1:1, the error 3.4:1, all under AA - which
	// is what VS Code's own Light Modern publishes, not a mistake of ours.
	//
	// The repair is a TOKEN, not a class, because the two consumers never meet
	// otherwise: the dashboard stylesheet paints pills through .tone-*, while
	// components use the text-ok/text-warn/text-err utilities compiled from the
	// theme mapping. A class-only fix repairs the pills and silently leaves
	// every utility consumer failing, in light only.
	const output = await compileTheme();
	const source = readFileSync(themeEntry, "utf8");
	for (const hue of ["ok", "warn", "err"] as const) {
		expect(output).toContain(`--${hue}-text: var(--${hue})`);
		expect(output).toContain(`--${hue}-text: color-mix(in oklab, var(--${hue}) 65%, black)`);
		// The @theme inline mapping bakes its chain into the utilities rather
		// than emitting a property, so the mapping itself is read from source
		// and its effect from the compiled utility below.
		expect(source).toContain(`--color-${hue}: var(--${hue}-text);`);
		// ...and the shape-shaped one reads the fill tier, which on light is a
		// darkened value of its own; see the fill-tier test below.
		expect(source).toContain(`--color-${hue}-fill: var(--${hue}-fill);`);
	}
	// The utilities that exist today are text ones, and they must carry the
	// readable tier: these are live call sites in the server editor.
	expect(output).toContain(".text-err {\n    color: var(--err-text);");
	expect(output).toContain(".text-warn {\n    color: var(--warn-text);");
	const dashboard = readFileSync(dashboardEntry, "utf8");
	expect(/\.tone-ok \{\s*color: var\(--ok-text\);/.test(dashboard)).toBe(true);
	// No status hue may still be painted as text anywhere in the dashboard sheet.
	const rawText = [
		...dashboard.matchAll(
			/\n\s*color: var\(--vscode-(testing-iconPassed|errorForeground|editorWarning-foreground|notificationsWarningIcon-foreground)/g
		),
	];
	expect(rawText).toBeEmpty();
});

test("status fills darken on light too, because a meter is the reading", async () => {
	// The text tier exempted fills on the grounds that a shape carries no
	// reading burden. True of a dot beside a word; false of a 3px meter, which
	// measured 2.0:1 on the light page - a healthy bar nobody can see. Fills
	// need 3:1 rather than 4.5, so they darken more gently and keep more of the
	// bright character the meter wants.
	const output = await compileTheme();
	const source = readFileSync(themeEntry, "utf8");
	for (const hue of ["ok", "warn", "err"] as const) {
		expect(output).toContain(`--${hue}-fill: var(--${hue})`);
		expect(output).toContain(`--${hue}-fill: color-mix(in oklab, var(--${hue}) 78%, black)`);
		// The utility the meter actually paints with has to read the tier, not
		// the raw hue - that indirection is the whole fix.
		expect(source).toContain(`--color-${hue}-fill: var(--${hue}-fill);`);
	}
});

test("the meter's axis carries no alpha of its own", async () => {
	// The whole reason this token exists rather than a foreground/55 utility is
	// that a translucent axis recomposites over the row's hover wash and drops
	// to 2.95:1. Nothing else pins that: REQUIRED_UTILITIES proves `border-axis`
	// compiles and the component suite proves the class is on the element, so
	// rewriting the value to an alpha - or to `transparent`, which reproduces
	// the invisible track this replaced - leaves the whole suite green.
	const output = await compileTheme();
	// Both pins read the COMPILED stylesheet rather than the source text, which
	// buys two things a source pin cannot: a declaration commented out still
	// satisfies toContain against the source while the token goes undefined,
	// and only the compiler settles which of several declarations wins.
	expect(output).toContain("--axis: color-mix(in srgb, var(--foreground) 65%, var(--background));");
	// `border-axis` paints through --color-axis, so an alpha introduced there
	// evades the value pin entirely - and the compiler takes whichever
	// --color-axis comes last, so a second one added below the first is the one
	// the meter would paint with.
	expect(output).toContain(".border-axis {\n    border-color: var(--axis);");
	// Declared once across BOTH stylesheets, so neither a per-theme override nor
	// a rule in dashboard.css can reintroduce an alpha under one palette while
	// the pins above still pass. Comments come out first, so a commented-out
	// declaration counts as the absent thing it is. Unanchored on purpose: an
	// override indented with spaces, or inlined into a one-line block, is still
	// an override. `--color-axis:` does not match it.
	const declarations = [themeEntry, dashboardEntry].flatMap((entry) => [
		...readFileSync(entry, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.matchAll(/--axis:/g),
	]);
	expect(declarations).toHaveLength(1);
});

test("the selected rail tab keeps its forced-colors mark at every width", async () => {
	// Forced colours discard the selected tab's fill (bg-accent-soft) and
	// repaint its text, so the Highlight edge bar is the selection's only
	// surviving mark - and it was first written inside the collapsed rail's
	// width query, where it stopped existing at full width and font weight
	// carried the selection alone. Two pins, one per half of the fix: the bar
	// must live in a forced-colors block OUTSIDE every width query so it
	// paints at every width, and the narrow re-placement (which re-sets the
	// bar to the accent hue after that block) must restate the system colour
	// from a LATER narrow forced-colors block - one flat layer, so whichever
	// background comes last wins the collapsed rail's mark.
	const output = await compileDashboard();
	const selector = '.rail-nav .rail-tab[aria-selected="true"]:before';
	const blocks = forcedColorsBlocks(output).filter((block) => block.text.includes(selector));
	const everyWidth = blocks.filter((block) => block.unconditional);
	expect(everyWidth).toHaveLength(1);
	expect(everyWidth[0]?.text).toContain('content: ""');
	expect(everyWidth[0]?.text).toContain("background: highlight;");
	const narrow = blocks.filter((block) => !block.unconditional);
	expect(narrow).toHaveLength(1);
	expect(narrow[0]?.text).toContain("background: highlight;");
	const narrowAt = output.indexOf(narrow[0]?.text ?? "");
	const geometryAt = output.indexOf("left: -4px;");
	expect(geometryAt, "the collapsed rail's edge-bar geometry rule").toBeGreaterThan(-1);
	expect(narrowAt, "the narrow Highlight restatement must follow the accent-hue geometry").toBeGreaterThan(geometryAt);
});

test("the settings gutter marks the modified row alone, under forced colors too", async () => {
	// A modified setting is marked by its left border, and the unmodified state
	// spells that as border-l-transparent - which forced colours repaint like
	// any other border colour, so every row wore the mark and the modified one
	// stopped standing out. Nothing else can catch that: happy-dom runs no
	// cascade and no forced-colors mode, and the class names on the element are
	// right either way, so the regression is invisible to the component suite
	// and lives only in the compiled cascade. Asserted inside the UNLAYERED
	// forced-colors block, because both halves of that placement are
	// load-bearing: a system colour outside the media query paints in every
	// ordinary theme, where it answers to the OS rather than to the host's
	// palette, and a layered copy loses to the very utility it overrules.
	const output = await compileTheme();
	const forced = forcedColorsBlocks(output)
		.filter((block) => block.unlayered)
		.map((block) => block.text)
		.join("\n");
	expect(forced).toContain(".setting-row:not(.modified) {\n    border-left-color: Canvas;");
	expect(forced).toContain(".setting-row.modified {\n    border-left-color: Highlight;");
	// Once each in this sheet, because the pins above prove only that a correct
	// rule exists: a second one further down would win, and hand the off state
	// its CanvasText back with the whole suite green. This sheet and not the
	// shipped stylesheet, which also carries dashboard.css - that file is wholly
	// layered and cannot outrank an unlayered rule, so a copy over there would
	// be inert rather than dangerous. Counted without the brace, so a grouped
	// selector - `.setting-row.modified, .elsewhere { ... }` - counts as the
	// second declaration it is.
	expect(occurrences(output, ".setting-row:not(.modified)")).toBe(1);
	expect(occurrences(output, ".setting-row.modified")).toBe(1);
});

test("the status text aliases are declared on :root alone, never on body", () => {
	// A plain alias declared on `body` matches body DIRECTLY, which beats the
	// forced-theme override on `html` - so the forced light palette kept the raw
	// hue and the whole fix was dead in the one mode it was written for. Only
	// derivations that read a per-surface input belong in the `:root, body`
	// block.
	const source = readFileSync(themeEntry, "utf8");
	const rootAndBody = /:root,\nbody \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
	expect(rootAndBody.length).toBeGreaterThan(0);
	for (const hue of ["ok", "warn", "err"] as const) {
		expect(rootAndBody).not.toContain(`--${hue}-text:`);
		expect(rootAndBody).not.toContain(`--${hue}-fill:`);
	}
});

test("the forced light palette keeps Light Modern's passing green, low contrast and all", () => {
	// This value has been wrong once already, in a landed commit, on the belief
	// that #007100 is the registry's light value. It is the hcLight value. The
	// registry reads {dark:#73c991, light:#73c991, hcDark:#73c991,
	// hcLight:#007100} and light_modern.json does not override it, so VS Code's
	// own light theme really does ship a ~2:1 passing green.
	//
	// The palette is documented as faithful to Light Modern, and a palette that
	// quietly "improves" one value is a palette nobody can trust to describe the
	// host - the render harness then agrees with the edit and hides it. The
	// contrast repair belongs to --ok-text, which is measured and tested above.
	const light = forcedBlock("light");
	expect(light).toContain("--vscode-testing-iconPassed: #73c991");
	expect(light).not.toContain("#007100");
	// The high contrast light emulation is where #007100 legitimately lives.
	const harness = readFileSync(
		path.resolve(import.meta.dir, "../../../../../../scripts/dev/render-dashboard.ts"),
		"utf8"
	);
	const lightEmulation = /function lightCss\(\)[\s\S]*?\n\}/.exec(harness)?.[0] ?? "";
	expect(lightEmulation).toContain("--vscode-testing-iconPassed: #73c991");
	expect(harness).toContain("--vscode-testing-iconPassed: #007100");
});
