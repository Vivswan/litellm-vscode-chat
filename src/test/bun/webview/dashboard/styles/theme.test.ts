import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../../util/repoRoot";
import { CHILD_PROCESS_TIMEOUT_MS } from "../../../childProcessTimeout";
import {
	compileDashboard,
	compileTheme,
	dashboardEntry,
	FORCED_COLORS_QUERY,
	forcedColorsBlocks,
	rulesFor,
	type StyleRule,
	themeEntry,
} from "./compileStyles";
import { type Block, blocks } from "./cssBlocks";

/**
 * Load-bearing utilities the ui components consume: each one must compile from the source scan, or the styled
 * primitives silently lose that piece of their look (Tailwind's @source scan fails silently). A missing name here means
 * the scan broke or the component stopped using the utility - update deliberately either way.
 */
const REQUIRED_UTILITIES = [
	"inline-flex",
	"cursor-pointer",
	"rounded-sm",
	"border-control-outline",
	"text-accent-text",
	"hover:bg-accent-soft",
	// The action vocabulary's quiet tier and its hover strengthening: secondary buttons rest on these, and losing
	// either from the scan turns every supporting action back into flat grey prose with the suites green.
	"text-accent-quiet",
	"hover:text-accent-strong",
	"text-err-quiet",
	"hover:bg-err-wash",
	"hover:text-err-strong",
	"hover:bg-ghost-hover",
	"text-muted-foreground",
	// The spend meter's two halves. The axis is the only thing marking the 100% extent, and the forced-colors fill is
	// the only thing keeping a budgeted meter from reading as a measured zero when backgrounds flatten to Canvas - both
	// vanish silently if the scan stops emitting them.
	"border-axis",
	"forced-colors:bg-[Highlight]",
	// Secondary's resting affordance. It is the only thing that says a secondary button is a button before the pointer
	// arrives, and the component suites run without a cascade, so they can only assert that the class name is on the
	// element - if the scan stopped emitting the rule, every one of those buttons would go back to reading as prose
	// with the whole suite green.
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
	// The badge's shape: the one chip radius token, bound as a var utility so the badge moves with the token instead of
	// agreeing with it by arithmetic.
	"rounded-(--radius-chip)",
	// The field chrome's shape, same binding: input, select, and the declared models textarea move with --radius-field
	// the same way.
	"rounded-(--radius-field)",
	"focus-visible:outline-ring",
	"disabled:opacity-60",
	"disabled:bg-transparent",
	"disabled:text-disabled-foreground",
	// The accent picker's swatches: every hue paints, not just the live one, the checked ring is the foreground so it
	// reads against any of them, and the sample keeps its color where an OS forced-colors mode would repaint all four
	// the same.
	"bg-hue-blue",
	"bg-hue-violet",
	"bg-hue-teal",
	"bg-hue-amber",
	"has-[:checked]:outline-foreground",
	"forced-color-adjust-none",
	// The swatch's checked mark and its shared offset ride the ring geometry tokens rather than literals; the scan pin
	// here is their enforcement.
	"outline-offset-(--ring-offset)",
	"has-[:checked]:outline-(length:--ring-w)",
	//   The reveal primitive's whole class set (ui/reveal.tsx, models.tsx's row scope included): the reveal is
	//   invisible to the component suites
	//     -> a scan regression would strand every revealed action hidden forever - or painted forever - with every
	//        test green
	"opacity-0",
	"transition-opacity",
	"motion-reduce:transition-none",
	"group-hover/row:opacity-100",
	"group-focus-within/row:opacity-100",
	"@max-[560px]/pane:opacity-100",
	// The record editors' settings.json jump reveals on its heading's hover band (ui/reveal.tsx's "head" scope): a scan
	// regression would strand the jump painted only below 560px, with every component test green.
	"group-hover/head:opacity-100",
	"group-focus-within/head:opacity-100",
	// The settings rows' actions slot (ui/reveal.tsx's "setting" scope): Reset and the settings.json jump on every row
	// reveal on the row's own group, same regression mode as the /row and /head entries.
	"group-hover/setting:opacity-100",
	"group-focus-within/setting:opacity-100",
	// The Button primitive's layout hand-back, and the one action-cluster gap that is a utility rather than a
	// stylesheet rule. Both are load-bearing slots a scan regression would empty in silence: without the hand-back
	// every button's box parts from its ink, and gap-4.5 is what makes the settings row's actions measure text-to-text
	// like every other cluster.
	"mx-(--btn-mx)",
	"gap-4.5",
	// The settings gutter's modified mark, reading the runtime --accent-hue chain directly. It is spelled as a
	// var-shorthand utility precisely because its previous spelling died silently: the named color utility's @theme
	// alias was deleted as orphaned and the bar fell back to currentColor grey with every test green.
	"border-l-(--accent-hue)",
] as const;

function escapedSelector(utility: string): string {
	return `.${utility.replace(/[^a-zA-Z0-9-]/g, (char) => `\\${char}`)}`;
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test(
	"the source scan compiles every utility the ui components depend on",
	async () => {
		const output = await compileTheme();
		// An empty utilities layer would mean the @source paths stopped resolving (they fail silently inside Tailwind),
		// so check names, not just success.
		for (const utility of REQUIRED_UTILITIES) {
			expect(output).toContain(escapedSelector(utility));
		}
		// The forced-colors block's own rules ride the same compile: the disabled buttons' GrayText treatment (an
		// author-styled control keeps its repainted ButtonText otherwise, reading as actionable) and the marked chips'
		// width channel (every chip border repaints to one colour, so 2px is what keeps invalid and hinted chips the
		// marked ones).
		expect(output).toContain('[data-slot="button"]:disabled');
		expect(output).toContain("GrayText");
		expect(output).toContain(".chip-field.invalid");
		expect(output).toContain(".chip-field.hinted");
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"forced colors rank the two chip marks: shared width, and the hint takes the advisory dash",
	async () => {
		// Width alone made the rejected chip and the maybe-a-typo chip one 2px box, so the hinted chip adds
		// border-style as the second channel - the severity rules' own solid-vs-dashed rank. Pinned as compiled rules
		// in the unlayered, unconditional forced-colors context, because a layered or width-scoped copy is the rule
		// silently dying, and a dropped border-style hands the two marks back as one.
		const output = await compileTheme();
		// The forced-colors media must be the ONLY condition on these rules: a width- or container-scoped copy stops
		// existing at every other width.
		const onlyForced = (rule: StyleRule): boolean =>
			rule.context.filter((prelude) => /^@(?:media|container|supports)\b/.test(prelude)).join("") ===
			FORCED_COLORS_QUERY;
		const marked = rulesFor(output, ".chip-field.invalid").filter((rule) => rule.context.includes(FORCED_COLORS_QUERY));
		expect(marked).toHaveLength(1);
		// Exact selector-list membership, not a substring: ".chip-field.hintedly" would satisfy toContain while the
		// real hinted chip lost its width.
		expect(marked[0]?.selectorList.split(",").map((part) => part.trim())).toContain(".chip-field.hinted");
		expect(marked[0]?.declarations).toContain("border-width: 2px");
		expect(marked[0]?.unlayered).toBe(true);
		expect(marked[0] === undefined || onlyForced(marked[0])).toBe(true);
		const hinted = rulesFor(output, ".chip-field.hinted").filter(
			(rule) => rule.context.includes(FORCED_COLORS_QUERY) && rule.declarations.includes("border-style")
		);
		expect(hinted).toHaveLength(1);
		expect(hinted[0]?.declarations).toContain("border-style: dashed");
		expect(hinted[0]?.selectorList, "the dash is the hint's own; on the invalid chip it would unrank the marks").toBe(
			".chip-field.hinted"
		);
		expect(hinted[0]?.unlayered).toBe(true);
		expect(hinted[0] === undefined || onlyForced(hinted[0])).toBe(true);
		// The dash must come after the shared width rule: both set the border shorthand's longhands at equal
		// specificity, so source order is what keeps the hinted chip's 2px AND dashed.
		expect(hinted[0]?.start ?? 0).toBeGreaterThan(marked[0]?.start ?? 0);
		for (const rule of rulesFor(output, ".chip-field.invalid")) {
			expect(rule.declarations).not.toContain("dashed");
		}
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"the reveal primitive carries the whole idiom, reduced motion included",
	async () => {
		//   The idiom's contract lives in one wrapper (ui/reveal.tsx) -> it cannot fork again
		//   its motion-reduce clause is unrenderable: the harness cannot emulate prefers-reduced-motion
		//     -> this source-plus-compile pin is the clause's only enforcement
		const source = readFileSync(path.join(REPO_ROOT, "src/webview/dashboard/ui/reveal.tsx"), "utf8");
		for (const clause of [
			"opacity-0",
			"transition-opacity",
			"@max-[560px]/pane:opacity-100",
			"motion-reduce:transition-none",
		]) {
			expect(source).toContain(clause);
		}
		// Every group scope reveals on hover AND focus-within: visibility-based spellings (which drop the control from
		// the tab order) and hover-only scopes are the two forks this primitive exists to prevent.
		const scopes = [...source.matchAll(/group-hover\/([a-z]+):opacity-100/g)].map((match) => match[1] ?? "");
		expect(scopes.length).toBeGreaterThanOrEqual(3);
		for (const scope of scopes) {
			expect(source).toContain(`group-focus-within/${scope}:opacity-100`);
		}
		// And the transition really stands down in the compiled sheet: the utility must sit inside the
		// prefers-reduced-motion media query, not merely appear as a class name in the source.
		const output = await compileTheme();
		expect(output).toMatch(
			/@media \(prefers-reduced-motion: reduce\) \{\s*\.motion-reduce\\:transition-none \{\s*transition-property: none;/
		);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"the palette and radius resets keep Tailwind's defaults unreachable",
	async () => {
		const output = await compileTheme();
		// Every color in the design system is a var() chain onto host tokens;
		// Tailwind's own palette is oklch-valued, so one oklch() in the output
		// means a hardcoded palette color (bg-red-500, say) compiled.
		expect(output).not.toContain("oklch(");
		// The radius scale maps onto --radius; Tailwind's default rem-based scale must stay unreachable so an off-scale
		// rounded-2xl cannot compile.
		expect(output).not.toMatch(/border-radius:\s*[\d.]+rem/);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test("one screen-reader-only recipe: .visually-hidden, with its width-tier mirrors declaration-identical", async () => {
	// The rules that force the recipe inside a width tier - where a markup class cannot - are deliberate copies, and
	// this pin is what keeps them copies: a rule stating ANY of the recipe's hiding devices (`clip:`, a `clip-path:
	// inset` respelling, or the 1px box) is read as an embodiment and must match the canonical rule declaration for
	// declaration (sorted, because the printer reorders them).
	const sortedDeclarations = (body: string) =>
		body
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.split(";")
			.map((declaration) => declaration.replace(/\s+/g, " ").trim())
			.filter((declaration) => declaration.length > 0)
			.sort()
			.join("; ");
	const hidesFromPaint = (body: string) =>
		body.includes("clip:") ||
		body.includes("clip-path: inset") ||
		(body.includes("width: 1px") && body.includes("height: 1px"));
	const unconditional = (rule: Block) => !rule.context.some((prelude) => /^@(?:media|container)\b/.test(prelude));
	const copies = blocks(await compileDashboard()).filter(
		(rule) => !rule.prelude.startsWith("@") && hidesFromPaint(rule.body)
	);
	const canonical = copies.filter(unconditional);
	expect(canonical).toHaveLength(1);
	for (const mirror of copies.filter((rule) => !unconditional(rule))) {
		expect(sortedDeclarations(mirror.body), `${mirror.prelude} diverged from .visually-hidden`).toBe(
			sortedDeclarations(canonical[0]?.body ?? "")
		);
	}
});

test("the scrim re-enables pointer events Radix takes away", () => {
	// Radix's modal layer sets pointer-events:none on <body> and restores it only on the dialog node. The scrim is the
	// dialog's sibling, so without an explicit auto it inherits none and click-to-close dies in a real browser.
	//
	//   happy-dom does no hit-testing  -> a synthesized click still passes whatever pointer-events says - this rule is
	//                                     the only place the contract can be pinned
	const dashboard = readFileSync(dashboardEntry, "utf8");
	const scrimRule = /\.scrim\s*\{[^}]*\}/.exec(dashboard)?.[0];
	expect(scrimRule).toBeDefined();
	expect(scrimRule).toContain("pointer-events: auto");
});

test(
	"no minted utility collides with a class the dashboard stylesheet styles",
	async () => {
		const output = await compileTheme();
		// Utilities outrank the components layer, so a utility whose name matches a dashboard.css class would silently
		// restyle every element carrying it (the scan also mints utilities from incidental word tokens).
		// Only the utilities LAYER counts as minted: theme.css's own hand-written rules (the tone-text block, the
		// forced-colors repairs) name dashboard classes on purpose - they are rules FOR those classes, not scan
		// accidents.
		const minted = new Set(
			blocks(output)
				.filter((block) => block.context.some((prelude) => prelude.startsWith("@layer utilities")))
				// The brace restores the terminator the block walk stripped, so the name boundary stays what it always
				// was: `.group\/setting` is the variant machinery, not a minted `group` utility.
				.flatMap((block) =>
					[...`${block.prelude}{`.matchAll(/\.([A-Za-z][A-Za-z0-9-]*)[\s{,:]/g)].map((m) => m[1] ?? "")
				)
		);
		const dashboardClasses = new Set(
			[...readFileSync(dashboardEntry, "utf8").matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((match) => match[1] ?? "")
		);
		// The size floors keep both extractions honest; an extractor finding nothing would prove nothing.
		expect(minted.size).toBeGreaterThan(REQUIRED_UTILITIES.length);
		expect(dashboardClasses.size).toBeGreaterThan(100);
		expect([...minted].filter((utility) => dashboardClasses.has(utility))).toBeEmpty();
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"the hidden attribute beats a display utility",
	async () => {
		const output = await compileTheme();
		// [hidden] is a user-agent rule, so an element carrying `grid` or `flex` stays visible with the attribute set -
		// and hiding by attribute is how the settings filter and the record editors hide a row without unmounting its
		// draft. Comments are stripped first so the match cannot start inside the rule's own explanatory comment and
		// pass off its words.
		const rule = /\[hidden\][^{]*\{[^}]*\}/.exec(output.replace(/\/\*[\s\S]*?\*\//g, ""))?.[0] ?? "";
		expect(rule.replace(/\s+/g, "")).toContain("display:none!important");
		// Case-insensitively, because the user agent matches the value that way: hidden="UNTIL-FOUND" is until-found to
		// Chrome and must stay findable.
		expect(rule).toMatch(/until-found"\s*i/);
		// And the utility it has to beat really compiles.
		expect(output).toContain("display: grid");
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"the disabled utilities settle after the hover ones",
	async () => {
		const output = await compileTheme();
		// Disabled and hover utilities carry equal specificity, so a hovered disabled control only reads as disabled
		// because Tailwind emits the disabled variants later. The vocabulary leans on that: every variant answers hover
		// with a fill, and disabled has to overrule all of them.
		const lastHover = Math.max(
			output.indexOf(`${escapedSelector("hover:bg-accent-soft")}:hover`),
			output.indexOf(`${escapedSelector("hover:bg-ghost-hover")}:hover`),
			output.indexOf(`${escapedSelector("hover:bg-err-wash")}:hover`)
		);
		expect(lastHover).toBeGreaterThan(-1);
		for (const disabled of ["disabled:bg-transparent", "disabled:text-disabled-foreground"]) {
			expect(output.indexOf(`${escapedSelector(disabled)}:disabled`)).toBeGreaterThan(lastHover);
		}
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test("the problem-band tiers: one bar in color modes with hue and headline text, geometry ranking in the bordered modes", async () => {
	// In color modes every toned band wears the SAME 2px solid bar - two "error" treatments with different bar weights
	// on one page read as a mistake, not a rank - and the tier rides hue plus the headline's text colour. The bordered
	// modes (forced colors, the HC theme twins) re-rank by stroke geometry (6px double / 2px solid / 1px dashed),
	// because that is where hue stops existing.
	const output = await compileDashboard();
	const one = (selector: string, wanted: (rule: StyleRule) => boolean, why: string): StyleRule => {
		const rules = rulesFor(output, selector).filter(wanted);
		expect(rules, `expected one ${why} rule for ${selector}`).toHaveLength(1);
		if (rules[0] === undefined) {
			throw new Error(`no ${why} rule for ${selector}`);
		}
		return rules[0];
	};
	const base = (selector: string) => one(selector, (rule) => rule.unconditional, "unconditional");
	// The base rule owns the geometry defaults and the one compensation formula: rule width plus padding-left always
	// sum to --band-x, so every tier starts its text on one x at every width and in every mode - the per-tier,
	// per-width padding table this replaced drifted apart once already.
	const shared = base(".row-diagnostic");
	expect(shared.declarations).toContain("--band-x: 14px");
	expect(shared.declarations).toContain("--band-rule-w: 2px");
	expect(shared.declarations).toContain("--band-rule-style: solid");
	expect(shared.declarations).toMatch(/padding:[^;]*calc\(var\(--band-x\)\s+-\s+var\(--band-rule-w\)\)/);
	expect(shared.declarations).toMatch(
		/border-left:\s*var\(--band-rule-w\)\s*var\(--band-rule-style\)\s*var\(--band-rule-color\)/
	);
	// The toned tiers set hue, wash, and headline text ONLY: a width or style here is a second bar geometry, the exact
	// fork the pipeline exists to prevent.
	const error = base(".row-diagnostic.tier-error");
	const warn = base(".row-diagnostic.tier-warn");
	for (const tier of [error, warn]) {
		expect(tier.declarations).not.toContain("--band-rule-w");
		expect(tier.declarations).not.toContain("--band-rule-style");
	}
	expect(error.declarations).toContain("--band-rule-color: var(--err-fill)");
	expect(error.declarations).toContain("background: color-mix(in srgb, var(--err) 8%, transparent)");
	expect(warn.declarations).toContain("--band-rule-color: var(--warn-fill)");
	expect(warn.declarations).toContain("background: color-mix(in srgb, var(--warn) 8%, transparent)");
	// The headline wears the tier's readable text colour; the detail lines keep their muted colour (the base
	// .row-diagnostic-detail rule), one rule everywhere a band renders.
	expect(base(".row-diagnostic.tier-error .row-diagnostic-headline").declarations).toContain("color: var(--err-text)");
	expect(base(".row-diagnostic.tier-warn .row-diagnostic-headline").declarations).toContain("color: var(--warn-text)");
	// The quiet tier: no wash, no toned text, and the one sanctioned geometry step down - 1px dashed says "lightest"
	// without asking colour to.
	const advisory = base(".row-diagnostic.tier-advisory");
	expect(advisory.declarations).toContain("--band-rule-w: 1px");
	expect(advisory.declarations).toContain("--band-rule-style: dashed");
	// (the compiler prints `background: transparent` as `none`)
	expect(advisory.declarations).toContain("background: none");
	// The bordered modes re-rank by stroke geometry, in BOTH spellings: the forced-colors query and the HC theme body
	// twins (VS Code's HC themes never trip the media query). 6px, never 4: `double` cuts the width into three, and a
	// 4px double reads LIGHTER than the 2px solid below it.
	const forcedError = one(
		".row-diagnostic.tier-error",
		(rule) => rule.context.includes(FORCED_COLORS_QUERY),
		"forced-colors"
	);
	const hcError = one(
		"body.vscode-high-contrast .row-diagnostic.tier-error",
		(rule) => rule.unconditional,
		"high-contrast twin"
	);
	for (const bordered of [forcedError, hcError]) {
		expect(bordered.declarations).toContain("--band-rule-w: 6px");
		expect(bordered.declarations).toContain("--band-rule-style: double");
	}
	expect(hcError.selectorList).toContain("body.vscode-high-contrast-light .row-diagnostic.tier-error");
	// The bordered override must COMPILE after the tier rules it outranks: the forced-colors rule ties the
	// unconditional tier-error on specificity, so source order alone decides it.
	expect(forcedError.start).toBeGreaterThan(error.start);
	// Advisory's one forced-colors repaint survives: GrayText is the mode's own hint for "matters least", on top of the
	// geometry.
	expect(
		rulesFor(output, ".row-diagnostic.tier-advisory").some(
			(rule) => rule.context.includes(FORCED_COLORS_QUERY) && rule.declarations.toLowerCase().includes("graytext")
		)
	).toBe(true);
	// The narrow tier restates the text x alone and leans on the same calc: a hand-written padding here would stop
	// compensating the bordered modes' 6px.
	const narrow = one(
		".row-diagnostic",
		(rule) => !rule.unconditional && !rule.context.includes(FORCED_COLORS_QUERY),
		"narrow"
	);
	expect(narrow.declarations).toContain("--band-x: 12px");
	expect(narrow.declarations).toMatch(/padding:[^;]*calc\(var\(--band-x\)\s+-\s+var\(--band-rule-w\)\)/);
	expect(narrow.start, "the narrow restatement precedes its base rule").toBeGreaterThan(shared.start);
	// No tier restates padding at any width: the formula is the one compensation.
	for (const selector of [".row-diagnostic.tier-error", ".row-diagnostic.tier-warn", ".row-diagnostic.tier-advisory"]) {
		for (const rule of rulesFor(output, selector)) {
			expect(rule.declarations, `${selector} hand-rolls a padding`).not.toContain("padding");
		}
	}
});

/**
 * Tokens a forced palette deliberately leaves alone. The font trio is the reader's editor setting rather than a theme,
 * and the two contrast tokens are undefined in every ordinary theme - the chains that read them are written for exactly
 * that absence, and a forced theme is never high contrast.
 */
const UNFORCED_HOST_TOKENS = new Set([
	"--vscode-font-family",
	"--vscode-font-size",
	"--vscode-editor-font-family",
	"--vscode-contrastBorder",
	"--vscode-contrastActiveBorder",
]);

function forcedBlock(theme: "dark" | "light"): string {
	const source = readFileSync(themeEntry, "utf8");
	const block = new RegExp(`&\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\t\\}`).exec(source)?.[1];
	expect(block, `theme.css has no &[data-theme="${theme}"] block`).toBeDefined();
	return block ?? "";
}

/** The declarations inside theme.css's `:root, body` derivation block; a comment may sit between its two selectors. */
function rootAndBodyBlock(): string {
	const source = readFileSync(themeEntry, "utf8");
	const block = /^:root,\n(?:\/\*[\s\S]*?\*\/\n)?body \{([\s\S]*?)\n\}/m.exec(source)?.[1];
	expect(block, "theme.css has no `:root, body` block").toBeDefined();
	return block ?? "";
}

test("a forced theme redefines every host token the stylesheets read", () => {
	// Forcing a theme means replacing the HOST's variables, because that is what every consumer reads: the semantic
	// mapping, the dashboard stylesheet's direct reads, and the utilities alike. A token the palettes miss keeps its
	// value from the editor's theme, which is how a forced dark dashboard ends up a light page with one black input.
	const read = new Set<string>();
	for (const entry of [themeEntry, dashboardEntry]) {
		for (const match of readFileSync(entry, "utf8").matchAll(/var\((--vscode-[A-Za-z0-9-]+)/g)) {
			if (!UNFORCED_HOST_TOKENS.has(match[1] ?? "")) {
				read.add(match[1] ?? "");
			}
		}
	}
	// A floor as the extraction's positive control, not a count: it was 40 until the consumerless token chains left
	// theme.css and took seven distinct host-token reads with them (46 down to 39).
	expect(read.size).toBeGreaterThan(35);
	for (const theme of ["dark", "light"] as const) {
		const defined = new Set(
			[...forcedBlock(theme).matchAll(/^\s*(--vscode-[A-Za-z0-9-]+):/gm)].map((match) => match[1] ?? "")
		);
		expect([...read].filter((token) => !defined.has(token)).sort()).toBeEmpty();
	}
});

test("every forced host token carries !important, because inline styles are what it is fighting", async () => {
	// VS Code writes --vscode-* onto the document element's inline style, and an inline declaration outranks every
	// author rule on that element. A forced palette without !important loses in the editor while looking correct in any
	// render that delivers the tokens as CSS.
	//
	//   This is the whole mechanism  -> it is pinned per declaration rather than trusted
	for (const theme of ["dark", "light"] as const) {
		const declarations = [...forcedBlock(theme).matchAll(/^\s*(--vscode-[A-Za-z0-9-]+):\s*([^;]+);/gm)];
		expect(declarations.length).toBeGreaterThan(50);
		expect(
			declarations.filter((match) => !(match[2] ?? "").endsWith("!important")).map((match) => match[1])
		).toBeEmpty();
	}
	// And the tokens we own carry none: nothing shadows them, and !important there would only make them harder to
	// override later.
	const ours = [...forcedBlock("light").matchAll(/^\s*(--(?!vscode-)[a-z0-9-]+):\s*([^;]+);/gm)];
	expect(ours.length).toBeGreaterThan(0);
	expect(ours.filter((match) => (match[2] ?? "").includes("!important")).map((match) => match[1])).toBeEmpty();
});

test("the two light blocks agree on everything a light surface changes", () => {
	// One surface reached two ways: the host-derived rule (auto, and high contrast of either kind) and the forced light
	// block. They are separate rules because they match on different things, so only a test keeps them saying the same
	// thing - and it compares the whole list rather than the three tokens that happen to be there today, so a
	// light-only token added to one block has to reach the other.
	const source = readFileSync(themeEntry, "utf8");
	const hostDerived = /body\.vscode-high-contrast-light \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
	// The forced block additionally carries the host palette (--vscode-*) and its color-scheme; those are what forcing
	// a theme means, not what being light means.
	const ownTokens = (block: string): string[] =>
		[...block.matchAll(/^\s*(--(?!vscode-)[a-z0-9-]+):\s*([^;]+);/gm)]
			.map((match) => `${match[1]}: ${match[2]?.trim()}`)
			.sort();
	// A floor, not a count: it only has to be big enough that an extraction finding nothing cannot pass the equality
	// below vacuously.
	expect(ownTokens(hostDerived).length).toBeGreaterThanOrEqual(4);
	expect(ownTokens(forcedBlock("light"))).toEqual(ownTokens(hostDerived));
});

test("a forced-light override of a body-declared token is repeated on the body twin", () => {
	// A token in the `:root, body` block is declared DIRECTLY on body, and a direct declaration beats an inherited
	// one - so the forced light block, which sits on `html`, silently loses for exactly those tokens and needs the twin
	// to win where they are read. Which tokens those are is DERIVED from the two blocks rather than listed, because the
	// failure mode is a quiet tier landing in three of its four homes and forced light keeping the dark lean with every
	// suite green.
	const rootAndBody = rootAndBodyBlock();
	const twin = /&\[data-theme="light"\] body \{([\s\S]*?)\n\t\}/.exec(readFileSync(themeEntry, "utf8"))?.[1] ?? "";
	const declarations = (block: string) =>
		[...block.matchAll(/^\s*(--(?!vscode-)[a-z0-9-]+):\s*([^;]+);/gm)].map(
			(match) => `${match[1]}: ${match[2]?.trim()}`
		);
	const nameOf = (declaration: string) => declaration.split(":")[0] ?? "";
	// Floors as the extractions' positive controls: a regex that stopped matching would otherwise satisfy the equality
	// below with two empty lists.
	const onBody = new Set(declarations(rootAndBody).map(nameOf));
	expect(onBody.size).toBeGreaterThanOrEqual(8);
	const owed = declarations(forcedBlock("light"))
		.filter((declaration) => onBody.has(nameOf(declaration)))
		.sort();
	expect(owed.length).toBeGreaterThan(0);
	// Equality, so the twin cannot carry a stale token either.
	expect(declarations(twin).sort()).toEqual(owed);
});

test(
	"status fills darken on light too, because a meter is the reading",
	async () => {
		// The text tier exempted fills on the grounds that a shape carries no reading burden. True of a dot beside a
		// word; false of a 3px meter, which measured 2.0:1 on the light page - a healthy bar nobody can see.
		//
		//   Fills need 3:1 rather than 4.5  -> they darken more gently and keep more of the bright character the meter
		//                                      wants
		const output = await compileTheme();
		const source = readFileSync(themeEntry, "utf8");
		for (const hue of ["ok", "warn", "err"] as const) {
			expect(output).toContain(`--${hue}-fill: var(--${hue})`);
			expect(output).toContain(`--${hue}-fill: color-mix(in oklab, var(--${hue}) 78%, black)`);
			// The utility the meter actually paints with has to read the tier, not the raw hue - that indirection is
			// the whole fix.
			expect(source).toContain(`--color-${hue}-fill: var(--${hue}-fill);`);
		}
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"the meter's axis carries no alpha of its own",
	async () => {
		// The whole reason this token exists rather than a foreground/55 utility is that a translucent axis
		// recomposites over the row's hover wash and drops to 2.95:1. Nothing else pins that: REQUIRED_UTILITIES proves
		// `border-axis` compiles and the component suite proves the class is on the element, so rewriting the value to
		// an alpha - or to `transparent`, which reproduces the invisible track this replaced - leaves the whole suite
		// green.
		const output = await compileTheme();
		// Both pins read the COMPILED stylesheet rather than the source text, which buys two things a source pin
		// cannot: a declaration commented out still satisfies toContain against the source while the token goes
		// undefined, and only the compiler settles which of several declarations wins.
		expect(output).toContain("--axis: color-mix(in srgb, var(--foreground) 65%, var(--background));");
		// `border-axis` paints through --color-axis, so an alpha introduced there evades the value pin entirely - and
		// the compiler takes whichever --color-axis comes last, so a second one added below the first is the one the
		// meter would paint with.
		expect(output).toContain(".border-axis {\n    border-color: var(--axis);");
		// Declared once across BOTH stylesheets, so neither a per-theme override nor a rule in dashboard.css can
		// reintroduce an alpha under one palette while the pins above still pass. `--color-axis:` does not match it.
		//
		//   Comments come out first  -> a commented-out declaration counts as the absent thing it is
		//   an override indented with spaces, or inlined into a one-line block, is still an override
		//     -> Unanchored on purpose
		const declarations = [themeEntry, dashboardEntry].flatMap((entry) => [
			...readFileSync(entry, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.matchAll(/--axis:/g),
		]);
		expect(declarations).toHaveLength(1);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test("the selected rail tab keeps its forced-colors mark at every width", async () => {
	// Forced colours leave the Highlight edge bar as the selection's only surviving mark. Two pins, one per half of the
	// fix: the bar must live in a forced-colors block OUTSIDE every width query (first written inside the collapse
	// query, it stopped existing at full width), and the narrow re-placement must restate the system colour from a
	// LATER narrow forced-colors block - one flat layer, last background wins.
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

test(
	"the settings gutter marks the modified row alone, under forced colors too",
	async () => {
		// border-l-transparent gets repainted like any other border colour, so every row wore the modified mark.
		// Asserted inside the UNLAYERED forced-colors block: a system colour outside the media query paints in every
		// ordinary theme, and a layered copy loses to the very utility it overrules.
		//
		//   the class names are right either way -> Only the compiled cascade can catch it
		const output = await compileTheme();
		const forced = forcedColorsBlocks(output)
			.filter((block) => block.unlayered)
			.map((block) => block.text)
			.join("\n");
		expect(forced).toContain(".setting-row:not(.modified) {\n    border-left-color: Canvas;");
		expect(forced).toContain(".setting-row.modified {\n    border-left-color: Highlight;");
		// Once each in this sheet: a second rule further down would win and hand the off state its CanvasText back with
		// the suite green.
		//
		//   dashboard.css is wholly layered and cannot outrank an unlayered rule -> This sheet only
		//   Counted without the brace -> a grouped selector counts as the second declaration it is
		expect(occurrences(output, ".setting-row:not(.modified)")).toBe(1);
		expect(occurrences(output, ".setting-row.modified")).toBe(1);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

/**
 * The ONE rule both high-contrast selectors open together. Both are looked up as rules and their selector lists
 * compared - a substring match is satisfied by `...-light .thing:hover`, leaving the resting HC-light state unstyled,
 * pin green.
 */
function highContrastTwin(css: string, selector: string): StyleRule {
	const dark = rulesFor(css, `body.vscode-high-contrast ${selector}`);
	const light = rulesFor(css, `body.vscode-high-contrast-light ${selector}`);
	// Exactly one each, because the caller then reads ONE rule's declarations and context: a second copy further down -
	// inside a width query, say - is the one the browser would apply at the width it names, and the assertions below
	// would be describing the rule it beat.
	expect(dark, `expected one high-contrast rule for ${selector}`).toHaveLength(1);
	expect(light, `expected one high-contrast-light rule for ${selector}`).toHaveLength(1);
	if (dark[0] === undefined || light[0] === undefined) {
		throw new Error(`no high-contrast twin for ${selector}`);
	}
	expect(light[0].selectorList, `the two high-contrast rules for ${selector} are not one rule`).toBe(
		dark[0].selectorList
	);
	return dark[0];
}

test(
	"the bordered modes drop the button hand-back as a property, never as a margin",
	async () => {
		// The bordered modes must take the buttons' padding hand-back away or adjacent boxes merge into one segmented
		// control - but `margin-inline: 0` writes both longhands and killed the record matcher pencil's ms-auto;
		// zeroing the property composes.
		const output = await compileTheme();
		const blocks = forcedColorsBlocks(output).filter((block) => block.text.includes('[data-slot="button"]'));
		expect(blocks).toHaveLength(1);
		const block = blocks[0];
		// Unlayered, because the value it overrules is set by a utility and only an unlayered rule beats one;
		// unconditional, because a button's box is drawn at every width.
		expect(block?.unlayered).toBe(true);
		expect(block?.unconditional).toBe(true);
		expect(block?.text).toMatch(/\[data-slot="button"\] \{\s*--btn-mx: 0px;\s*\}/);
		expect(block?.text).not.toContain("margin-inline");
		// The high-contrast twin says the same thing the same way: both HC themes light --control-outline up, so they
		// draw the same boxes.
		const hc = highContrastTwin(output, '[data-slot="button"]');
		expect(hc.declarations).toContain("--btn-mx: 0px");
		expect(hc.declarations).not.toContain("margin-inline");
		expect(hc.unlayered).toBe(true);
		expect(hc.unconditional).toBe(true);
		// And the other half of the pencil's alignment, in the ORDINARY themes: the hand-back is a margin-inline
		// shorthand and ms-auto a start longhand at equal specificity, so the push survives only because Tailwind emits
		// the longhand later. Reordered, the pencil lands mid-line at narrow with every component test green.
		const handBack = output.indexOf(escapedSelector("mx-(--btn-mx)"));
		expect(handBack).toBeGreaterThan(-1);
		expect(output.indexOf(escapedSelector("ms-auto"))).toBeGreaterThan(handBack);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test("the status text aliases are declared on :root alone, never on body", () => {
	// A plain alias declared on `body` matches body DIRECTLY, which beats the forced-theme override on `html` - so the
	// forced light palette kept the raw hue and the whole fix was dead in the one mode it was written for. Only
	// derivations that read a per-surface input belong in the `:root, body` block.
	const rootAndBody = rootAndBodyBlock();
	for (const hue of ["ok", "warn", "err"] as const) {
		expect(rootAndBody).not.toContain(`--${hue}-text:`);
		expect(rootAndBody).not.toContain(`--${hue}-fill:`);
	}
});

test("the forced light palette keeps Light Modern's passing green, low contrast and all", () => {
	// This value has been wrong once already, in a landed commit: #007100 is the hcLight
	// value, not light - the registry ships {dark/light/hcDark: #73c991, hcLight: #007100}
	// and light_modern.json does not override it. The palette is documented as faithful to
	// Light Modern; the readable tier is --ok-text's job, which the tone-text test below
	// pins .state-ok to.
	const light = forcedBlock("light");
	expect(light).toContain("--vscode-testing-iconPassed: #73c991");
	expect(light).not.toContain("#007100");
	// The high contrast light emulation is where #007100 legitimately lives.
	const emulationsDir = path.join(REPO_ROOT, "scripts/dev/render/hostThemes");
	const lightEmulation = readFileSync(path.join(emulationsDir, "light.css"), "utf8");
	expect(lightEmulation).toContain("--vscode-testing-iconPassed: #73c991");
	const hcLightEmulation = readFileSync(path.join(emulationsDir, "high-contrast-light.css"), "utf8");
	expect(hcLightEmulation).toContain("--vscode-testing-iconPassed: #007100");
});

test(
	"tone text is one unlayered presentation: severity color plus the weight channel",
	async () => {
		// Pins the tone-text register (color AND weight - weight survives forced colors), the placement (unlayered,
		// unconditional: as layered color-only rules these lost to p.hint on specificity and to color utilities by
		// layer order), and the count (exactly one ordinary rule per class - a second further down would win).
		const output = await compileTheme();
		const registers = [
			{ selector: ".error", color: "color: var(--err-text)" },
			{ selector: ".state-warn", color: "color: var(--warn-text)" },
			{ selector: ".state-ok", color: "color: var(--ok-text)" },
		] as const;
		for (const register of registers) {
			const rules = rulesFor(output, register.selector);
			const ordinary = rules.filter((rule) => rule.unconditional);
			expect(ordinary, register.selector).toHaveLength(1);
			expect(ordinary[0]?.unlayered, register.selector).toBe(true);
			expect(ordinary[0]?.declarations, register.selector).toContain(register.color);
			expect(ordinary[0]?.declarations, register.selector).toContain("font-weight: 600");
		}
		// And dashboard.css may not fork it: no bare .error, .state-warn, or .state-ok rule at all over there - the
		// rules that PLACE tone text (.row .row-status and friends) are longer selectors and stay.
		const dashboard = await compileDashboard();
		expect(rulesFor(dashboard, ".error")).toHaveLength(0);
		expect(rulesFor(dashboard, ".state-warn")).toHaveLength(0);
		expect(rulesFor(dashboard, ".state-ok")).toHaveLength(0);
	},
	CHILD_PROCESS_TIMEOUT_MS
);
