import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHILD_PROCESS_TIMEOUT_MS } from "../../../childProcessTimeout";
import {
	type Block,
	blocks,
	compileDashboard,
	compileTheme,
	dashboardEntry,
	FORCED_COLORS_QUERY,
	forcedColorsBlocks,
	rulesFor,
	type StyleRule,
	themeEntry,
} from "./compileStyles";

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
	"border-control-outline",
	"text-accent-text",
	"hover:bg-accent-soft",
	// The action vocabulary's quiet tier and its hover strengthening: secondary
	// buttons rest on these, and losing either from the scan turns every
	// supporting action back into flat grey prose with the suites green.
	"text-accent-quiet",
	"hover:text-accent-strong",
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
	// The badge's shape: the one chip radius token, bound as a var utility so
	// the badge moves with the token instead of agreeing with it by arithmetic.
	"rounded-(--radius-chip)",
	// The field chrome's shape, same binding: input, select, and the declared
	// models textarea move with --radius-field the same way.
	"rounded-(--radius-field)",
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
	"has-[:checked]:outline-foreground",
	"forced-color-adjust-none",
	// The swatch's checked mark and its shared offset ride the ring geometry
	// tokens rather than literals; the swatch is the one outline consumer whose
	// offset applies outside a :focus selector, so the focus-geometry guard
	// below cannot see it and the scan pin here is its only enforcement.
	"outline-offset-(--ring-offset)",
	"has-[:checked]:outline-(length:--ring-w)",
	// The reveal primitive's whole class set (ui/reveal.tsx, models.tsx's row
	// scope included): the reveal is invisible to the component suites
	// (happy-dom runs no cascade), so a scan regression would strand every
	// revealed action hidden forever - or painted forever - with every test
	// green.
	"opacity-0",
	"transition-opacity",
	"motion-reduce:transition-none",
	"group-hover/row:opacity-100",
	"group-focus-within/row:opacity-100",
	"@max-[560px]/pane:opacity-100",
	// The record editors' settings.json jump reveals on its heading's hover
	// band (ui/reveal.tsx's "head" scope): a scan regression would strand the
	// jump painted only below 560px, with every component test green.
	"group-hover/head:opacity-100",
	"group-focus-within/head:opacity-100",
	// The settings rows' actions slot (ui/reveal.tsx's "setting" scope):
	// Reset and the settings.json jump on every row reveal on the row's own
	// group, same regression mode as the /row and /head entries.
	"group-hover/setting:opacity-100",
	"group-focus-within/setting:opacity-100",
	// The Button primitive's layout hand-back, and the one action-cluster gap
	// that is a utility rather than a stylesheet rule. Both are load-bearing
	// slots a scan regression would empty in silence: without the hand-back
	// every button's box parts from its ink, and gap-4.5 is what makes the
	// settings row's actions measure text-to-text like every other cluster.
	"mx-(--btn-mx)",
	"gap-4.5",
	// The settings gutter's modified mark, reading the runtime --accent-hue
	// chain directly. It is spelled as a var-shorthand utility precisely
	// because its previous spelling died silently: the named color utility's
	// @theme alias was deleted as orphaned and the bar fell back to
	// currentColor grey with every test green.
	"border-l-(--accent-hue)",
] as const;

/** A utility name as it appears escaped in a compiled selector. */
function escapedSelector(utility: string): string {
	return `.${utility.replace(/[^a-zA-Z0-9-]/g, (char) => `\\${char}`)}`;
}

/** How many times `needle` appears in `haystack`, as a plain substring. */
function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test(
	"the source scan compiles every utility the ui components depend on",
	async () => {
		const output = await compileTheme();
		// An empty utilities layer would mean the @source paths stopped resolving
		// (they fail silently inside Tailwind), so check names, not just success.
		for (const utility of REQUIRED_UTILITIES) {
			expect(output).toContain(escapedSelector(utility));
		}
		// The forced-colors block's own rules ride the same compile: the disabled
		// buttons' GrayText treatment (an author-styled control keeps its
		// repainted ButtonText otherwise, reading as actionable) and the marked
		// chips' width channel (every chip border repaints to one colour, so 2px
		// is what keeps invalid and hinted chips the marked ones).
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
		// Width alone made the rejected chip and the maybe-a-typo chip one 2px
		// box, so the hinted chip adds border-style as the second channel - the
		// severity rules' own solid-vs-dashed rank. Pinned as compiled rules in
		// the unlayered, unconditional forced-colors context, because a layered
		// or width-scoped copy is the rule silently dying, and a dropped
		// border-style hands the two marks back as one.
		const output = await compileTheme();
		// The forced-colors media must be the ONLY condition on these rules: a
		// width- or container-scoped copy stops existing at every other width.
		const onlyForced = (rule: StyleRule): boolean =>
			rule.context.filter((prelude) => /^@(?:media|container|supports)\b/.test(prelude)).join("") ===
			FORCED_COLORS_QUERY;
		const marked = rulesFor(output, ".chip-field.invalid").filter((rule) => rule.context.includes(FORCED_COLORS_QUERY));
		expect(marked).toHaveLength(1);
		// Exact selector-list membership, not a substring: ".chip-field.hintedly"
		// would satisfy toContain while the real hinted chip lost its width.
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
		// The dash must come after the shared width rule: both set the border
		// shorthand's longhands at equal specificity, so source order is what
		// keeps the hinted chip's 2px AND dashed.
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
		// The idiom's contract lives in one wrapper (ui/reveal.tsx) so it cannot
		// fork again, and its motion-reduce clause is unrenderable: the harness
		// cannot emulate prefers-reduced-motion, and happy-dom runs no cascade, so
		// this source-plus-compile pin is the clause's only enforcement.
		const source = readFileSync(
			path.resolve(import.meta.dir, "../../../../../webview/dashboard/ui/reveal.tsx"),
			"utf8"
		);
		for (const clause of [
			"opacity-0",
			"transition-opacity",
			"@max-[560px]/pane:opacity-100",
			"motion-reduce:transition-none",
		]) {
			expect(source).toContain(clause);
		}
		// Every group scope reveals on hover AND focus-within: visibility-based
		// spellings (which drop the control from the tab order) and hover-only
		// scopes are the two forks this primitive exists to prevent.
		const scopes = [...source.matchAll(/group-hover\/([a-z]+):opacity-100/g)].map((match) => match[1] ?? "");
		expect(scopes.length).toBeGreaterThanOrEqual(3);
		for (const scope of scopes) {
			expect(source).toContain(`group-focus-within/${scope}:opacity-100`);
		}
		// And the transition really stands down in the compiled sheet: the utility
		// must sit inside the prefers-reduced-motion media query, not merely appear
		// as a class name in the source.
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
		// The radius scale maps onto --radius; Tailwind's default rem-based scale
		// must stay unreachable so an off-scale rounded-2xl cannot compile.
		expect(output).not.toMatch(/border-radius:\s*[\d.]+rem/);
		// The named shape radii exist at runtime (the @theme block is inline, so
		// utilities bake values in and their variables never reach the page): the
		// plain-CSS chip, pill, and field rules read these tokens instead of
		// restating literals that drift.
		for (const token of ["--radius-chip: calc(var(--radius) - 2px)", "--radius-pill: 9px", "--radius-field:"]) {
			expect(output).toContain(token);
		}
		// And the near-pill literal stays minted once: a 9px radius written into
		// the dashboard sheet is a fork of --radius-pill.
		expect(readFileSync(dashboardEntry, "utf8")).not.toContain("border-radius: 9px");
		// The base shape literal is retired the same way: a 4px radius written
		// into the dashboard sheet is a fork of --radius.
		expect(readFileSync(dashboardEntry, "utf8")).not.toContain("border-radius: 4px");
		// The badge binds the chip token itself, not rounded-sm: the two agree only
		// by the coincident calc(var(--radius) - 2px), and the token is the one
		// knob the chip shape class is supposed to have. Read as the variants' own
		// base string, so a doc comment naming rounded-sm is the prose it is.
		const componentsDir = path.resolve(import.meta.dir, "../../../../../webview/dashboard");
		const badge = readFileSync(path.resolve(componentsDir, "ui/badge.tsx"), "utf8");
		const badgeBase = /cva\(\s*"([^"]*)"/.exec(badge)?.[1];
		expect(badgeBase, "no cva base string in badge.tsx").toBeDefined();
		expect(badgeBase).toContain("rounded-(--radius-chip)");
		expect(badgeBase).not.toContain("rounded-sm");
		// The remaining tsx chip and field sites bind their tokens the same way: a
		// rounded-sm in these files would re-mint the coincidence the badge shed.
		// Exact counts, because a site quietly losing its binding is the regression.
		const boundSites = [
			{ file: "recordEditors.tsx", utility: "rounded-(--radius-chip)", count: 3 },
			{ file: "ui/input.tsx", utility: "rounded-(--radius-field)", count: 1 },
			{ file: "ui/select.tsx", utility: "rounded-(--radius-field)", count: 1 },
			{ file: "ui/textarea.tsx", utility: "rounded-(--radius-field)", count: 1 },
		] as const;
		for (const site of boundSites) {
			const source = readFileSync(path.resolve(componentsDir, site.file), "utf8");
			expect(source, `${site.file} re-minted rounded-sm`).not.toContain("rounded-sm");
			expect(occurrences(source, site.utility), `${site.file} lost a token binding`).toBe(site.count);
		}
	},
	CHILD_PROCESS_TIMEOUT_MS
);

/**
 * The colour an `outline`/`outline-color` declaration states, or "" when it states none: widths and
 * style keywords come out, so a rule setting only geometry is the no-colour rule it is and anything
 * left is a colour that has to be the token. Every colour syntax survives the strips - the length
 * pattern only ever eats digits and units, `#000` still leaves its hash, and only the canonical
 * width token comes out (any other var() in width position reads as a colour and fails).
 */
function outlineColor(declarations: string): string {
	return [...declarations.matchAll(/(?:^|[;{\s])outline(?:-color)?:\s*([^;]+)/g)]
		.map((match) => (match[1] ?? "").trim())
		.join(" ")
		.replace(/\b(?:none|solid|dashed|dotted|double|groove|ridge|inset|outset|auto|thin|medium|thick)\b/g, "")
		.replace(/var\(--ring-w\)/g, "")
		.replace(/[\d.]+(?:px|rem|em)?/g, "")
		.trim();
}

test(
	"every focus rule takes its color from the ring token, never the host's focusBorder",
	async () => {
		// theme.css remaps --ring per accent and to contrastActiveBorder under high
		// contrast, and the tsx primitives follow it through outline-ring - so a
		// stylesheet focus rule spelling a colour of its own is a second ring colour
		// in the same view under any non-blue accent or HC theme. Asserted as the
		// positive claim rather than a ban on --vscode-focusBorder alone, so a
		// hardcoded hex fails here too. Keyed on the :focus selectors, which is the
		// boundary: a ring painted by a class the script toggles is out of reach, and
		// the dashboard has none.
		const sheets = { theme: await compileTheme(), dashboard: await compileDashboard() };
		const focusRules = (css: string) => blocks(css).filter((rule) => rule.prelude.includes(":focus"));
		for (const css of Object.values(sheets)) {
			const bodies = focusRules(css).map((rule) => ({
				prelude: rule.prelude,
				body: rule.body.replace(/\/\*[\s\S]*?\*\//g, ""),
			}));
			const colored = bodies.map((rule) => ({ prelude: rule.prelude, color: outlineColor(rule.body) }));
			expect(colored.filter((rule) => rule.color !== "" && rule.color !== "var(--ring)")).toBeEmpty();
			// The token is the whole route, so the host variable may not reach a focus
			// rule by any property: box-shadow and border-color paint a ring too, and
			// neither is an outline the check above can see.
			expect(bodies.filter((rule) => rule.body.includes("--vscode-focusBorder"))).toBeEmpty();
			// And no focus rule paints by box-shadow at all: a shadow ring's colour
			// (hardcoded or tokened) would dodge both outline checks above, and no
			// focus surface uses one - ban the property rather than parse it.
			expect(bodies.filter((rule) => rule.body.includes("box-shadow"))).toBeEmpty();
		}
		// The counts are the walk's positive control: a parser finding no focus rules,
		// or none stating a colour, would satisfy the emptiness above vacuously. Exact,
		// not floors - one rule losing its ring is precisely the regression - and Bun
		// splits a grouped selector, so the button/a/.tip-wrap global counts three
		// times (the record JSON textarea's own rule left with the shared Textarea
		// primitive). Update deliberately when a focus surface is added or removed.
		const ringed = (css: string) => focusRules(css).filter((rule) => outlineColor(rule.body) === "var(--ring)");
		expect(ringed(sheets.dashboard)).toHaveLength(4);
		expect(ringed(sheets.theme)).toHaveLength(3);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

/** Every outline-family declaration a rule body states, comments already stripped. */
function outlineDeclarations(declarations: string): { property: string; value: string }[] {
	return [...declarations.matchAll(/(?:^|[;{\s])(outline(?:-[a-z]+)?):\s*([^;}]+)/g)].map((match) => ({
		property: match[1] ?? "",
		value: (match[2] ?? "").trim(),
	}));
}

test(
	"every focus rule takes its geometry from the ring tokens, never a literal",
	async () => {
		// The ring's colour rides --ring (above); its geometry rides --ring-w and the two
		// offset tokens, so a focus rule or utility spelling `1px` or an off-token offset is
		// a second ring geometry - the fork this system replaced at a dozen sites. The inset
		// offset is the one named variant (fields and scrollports whose ring would be clipped
		// or sit on a fill); anything else fails here.
		const sheets = { theme: await compileTheme(), dashboard: await compileDashboard() };
		const OFFSETS = ["var(--ring-offset)", "var(--ring-offset-inset)"];
		for (const css of Object.values(sheets)) {
			for (const rule of blocks(css).filter((rule) => rule.prelude.includes(":focus"))) {
				const body = rule.body.replace(/\/\*[\s\S]*?\*\//g, "");
				for (const { property, value } of outlineDeclarations(body)) {
					const where = `${rule.prelude} { ${property}: ${value} }`;
					// No literal length in any outline declaration on a focus rule: the token
					// names carry no digits, so one digit is a geometry spelled outside them.
					expect(value, `a focus rule spells outline geometry of its own: ${where}`).not.toMatch(/\d/);
					if (property === "outline-offset") {
						expect(OFFSETS, `an off-token focus offset: ${where}`).toContain(value);
					}
					if (property === "outline-width") {
						expect(value, `an off-token focus width: ${where}`).toBe("var(--ring-w)");
					}
					if (property === "outline") {
						expect(value.startsWith("var(--ring-w) "), `a shorthand off the width token: ${where}`).toBe(true);
					}
				}
			}
		}
		// Positive controls, exact: the offset statements per sheet and variant, so a parser
		// finding no outline declarations cannot pass vacuously and a surface changing its
		// variant is a deliberate update here. Dashboard: the button/a/.tip-wrap global (Bun
		// splits it into three) outset; the windowed scrollport inset (the record JSON textarea
		// rides the shared Textarea primitive's utilities now). Theme: the focus-visible outset
		// utility; the focus and focus-visible inset ones.
		const offsetRules = (css: string, token: string) =>
			blocks(css).filter(
				(rule) =>
					rule.prelude.includes(":focus") &&
					outlineDeclarations(rule.body).some(
						(declaration) => declaration.property === "outline-offset" && declaration.value === token
					)
			);
		expect(offsetRules(sheets.dashboard, "var(--ring-offset)")).toHaveLength(3);
		expect(offsetRules(sheets.dashboard, "var(--ring-offset-inset)")).toHaveLength(1);
		expect(offsetRules(sheets.theme, "var(--ring-offset)")).toHaveLength(1);
		expect(offsetRules(sheets.theme, "var(--ring-offset-inset)")).toHaveLength(2);
		// The tokens themselves: canonical values in the compiled theme, minted exactly once
		// across both sources (the --axis idiom - a second declaration further down would win),
		// with the inset offset derived from the width so the two cannot part.
		expect(sheets.theme).toContain("--ring-w: 1px;");
		expect(sheets.theme).toContain("--ring-offset: 1px;");
		expect(sheets.theme).toContain("--ring-offset-inset: calc(-1 * var(--ring-w));");
		for (const token of ["--ring-w:", "--ring-offset:", "--ring-offset-inset:"]) {
			const declarations = [themeEntry, dashboardEntry].flatMap((entry) => [
				...readFileSync(entry, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.matchAll(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
			]);
			expect(declarations, `${token} must be minted exactly once`).toHaveLength(1);
		}
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"one screen-reader-only recipe: .visually-hidden, with its width-tier mirrors declaration-identical",
	async () => {
		// Markup carries .visually-hidden for every unconditional case (Tailwind's sr-only
		// twin was retired, ui/absent.tsx included). The rules that force the recipe inside a
		// width tier - where a markup class cannot - are deliberate copies, and this pin is
		// what keeps them copies: a rule stating ANY of the recipe's hiding devices (`clip:`,
		// a `clip-path: inset` respelling, or the 1px box) is read as an embodiment and must
		// match the canonical rule declaration for declaration (sorted, because the printer
		// reorders them). Fail-closed: a fourth copy that diverges fails on equality, and the
		// exact count makes a new mirror a deliberate update here.
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
		expect(copies).toHaveLength(4);
		const canonical = copies.filter(unconditional);
		expect(canonical).toHaveLength(1);
		expect(canonical[0]?.prelude).toBe(".visually-hidden");
		// The recipe itself, pinned once: the mirrors then agree with it by equality.
		expect(sortedDeclarations(canonical[0]?.body ?? "")).toBe(
			"border: 0; clip: rect(0 0 0 0); height: 1px; margin: -1px; overflow: hidden; padding: 0; position: absolute; white-space: nowrap; width: 1px"
		);
		for (const mirror of copies.filter((rule) => !unconditional(rule))) {
			expect(sortedDeclarations(mirror.body), `${mirror.prelude} diverged from .visually-hidden`).toBe(
				sortedDeclarations(canonical[0]?.body ?? "")
			);
		}
		// And the theme sheet mints no second embodiment: no sr-only utility (nothing uses
		// it, so the scan must not emit it) and no hiding recipe of its own.
		const theme = await compileTheme();
		expect(theme).not.toContain(".sr-only");
		expect(blocks(theme).filter((rule) => !rule.prelude.startsWith("@") && hidesFromPaint(rule.body))).toBeEmpty();
	},
	CHILD_PROCESS_TIMEOUT_MS
);

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
	// One flat layer settles equal-specificity arguments by source order, and each pair
	// below was settled wrongly at least once: the base spelling must precede the override.
	// Anchors are asserted UNIQUE declaration texts, so a reworded or duplicated rule fails
	// loudly instead of quietly unpinning the guard; every override must also fall below
	// the banner opening the narrow tail.
	const sheet = readFileSync(dashboardEntry, "utf8");
	const bannerAt = sheet.indexOf("The narrow rules: what the dashboard does");
	expect(bannerAt).toBeGreaterThan(-1);
	expect(sheet.indexOf("The narrow rules", bannerAt + 1)).toBe(-1);
	const pairs: readonly (readonly [string, string])[] = [
		// the rail's full width, then its collapsed width
		["flex: 0 0 216px", "flex: 0 0 48px"],
		// the slide-over's resting width, then its collapsed-rail width
		["width: min(680px, 94vw)", "width: min(680px, calc(100% - 49px))"],
		// the server actions hidden at rest, then the sub-560 tier's
		// always-painted state (the reveal idiom's one threshold) - the very
		// opacity collision being guarded
		["opacity: 0;\n\t\ttransition: opacity 120ms ease-out;", ".server-actions {\n\t\t\topacity: 1;\n\t\t}"],
		// the rail icons unpainted at full width, then painted collapsed
		[".rail-icon {\n\t\tdisplay: none;", ".rail-icon {\n\t\t\tdisplay: flex;"],
		// the server name's full-width placement, then its three-line re-place
		[".server-name {\n\t\tgrid-area: 1 / 2;", "grid-area: 1 / 2 / auto / -1"],
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

test(
	"no minted utility collides with a class the dashboard stylesheet styles",
	async () => {
		const output = await compileTheme();
		// Utilities outrank the components layer, so a utility whose name matches a
		// dashboard.css class would silently restyle every element carrying it
		// (the scan also mints utilities from incidental word tokens). Compare
		// against the classes the dashboard stylesheet actually styles. Only the
		// utilities LAYER counts as minted: theme.css's own hand-written rules
		// (the tone-text block, the forced-colors repairs) name dashboard classes
		// on purpose - they are rules FOR those classes, not scan accidents.
		const minted = new Set(
			blocks(output)
				.filter((block) => block.context.some((prelude) => prelude.startsWith("@layer utilities")))
				// The brace restores the terminator the block walk stripped, so the
				// name boundary stays what it always was: `.group\/setting` is the
				// variant machinery, not a minted `group` utility.
				.flatMap((block) =>
					[...`${block.prelude}{`.matchAll(/\.([A-Za-z][A-Za-z0-9-]*)[\s{,:]/g)].map((m) => m[1] ?? "")
				)
		);
		const dashboardClasses = new Set(
			[...readFileSync(dashboardEntry, "utf8").matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((match) => match[1] ?? "")
		);
		// The size floors keep both extractions honest; an extractor finding
		// nothing would prove nothing.
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
		// [hidden] is a user-agent rule, so an element carrying `grid` or `flex` stays visible
		// with the attribute set - and hiding by attribute is how the settings filter and the
		// record editors hide a row without unmounting its draft. happy-dom runs no cascade,
		// so only the stylesheet can pin this. Comments are stripped first so the match cannot
		// start inside the rule's own explanatory comment and pass off its words.
		const rule = /\[hidden\][^{]*\{[^}]*\}/.exec(output.replace(/\/\*[\s\S]*?\*\//g, ""))?.[0] ?? "";
		expect(rule.replace(/\s+/g, "")).toContain("display:none!important");
		// Case-insensitively, because the user agent matches the value that way:
		// hidden="UNTIL-FOUND" is until-found to Chrome and must stay findable.
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
	},
	CHILD_PROCESS_TIMEOUT_MS
);

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
	const opener = new RegExp(String.raw`[{};]\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*\{([^}]*)\}`, "g");
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
	// error a square, muted a hollow ring - at the 2px state floor, and still
	// hollow: the 8px box keeps a 4px hole, so absence cannot read as presence.
	expect(onlyRuleBody(output, ".pill.tone-error .dot")).toContain("border-radius: 2px");
	const muted = onlyRuleBody(output, ".pill.tone-muted .dot");
	expect(muted).toContain("background: none");
	expect(muted).toContain("border: 2px solid");
	// The collapsed rail scales the whole vocabulary through the shared size
	// property and declares nothing else: a shape property of its own here is
	// how the rail's dot and the rows' fork apart again.
	expect(onlyRuleBody(output, ".rail-status .dot").trim()).toBe("--dot-size: 11px;");
});

test("the problem-band tiers: one bar in color modes with hue and headline text, geometry ranking in the bordered modes", async () => {
	// The band pipeline's stylesheet half. In color modes every toned band wears
	// the SAME 2px solid bar - two "error" treatments with different bar weights
	// on one page read as a mistake, not a rank - and the tier rides hue plus the
	// headline's text colour. The bordered modes (forced colors, the HC theme
	// twins) re-rank by stroke geometry (6px double / 2px solid / 1px dashed),
	// because that is where hue stops existing. happy-dom runs no cascade, so the
	// compiled sheet is the only place this can be pinned.
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
	// The base rule owns the geometry defaults and the one compensation formula:
	// rule width plus padding-left always sum to --band-x, so every tier starts
	// its text on one x at every width and in every mode - the per-tier,
	// per-width padding table this replaced drifted apart once already.
	const shared = base(".row-diagnostic");
	expect(shared.declarations).toContain("--band-x: 14px");
	expect(shared.declarations).toContain("--band-rule-w: 2px");
	expect(shared.declarations).toContain("--band-rule-style: solid");
	expect(shared.declarations).toMatch(/padding:[^;]*calc\(var\(--band-x\)\s+-\s+var\(--band-rule-w\)\)/);
	expect(shared.declarations).toMatch(
		/border-left:\s*var\(--band-rule-w\)\s*var\(--band-rule-style\)\s*var\(--band-rule-color\)/
	);
	// The toned tiers set hue, wash, and headline text ONLY: a width or style
	// here is a second bar geometry, the exact fork the pipeline exists to
	// prevent.
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
	// The headline wears the tier's readable text colour; the detail lines keep
	// their muted colour (the base .row-diagnostic-detail rule), one rule
	// everywhere a band renders.
	expect(base(".row-diagnostic.tier-error .row-diagnostic-headline").declarations).toContain("color: var(--err-text)");
	expect(base(".row-diagnostic.tier-warn .row-diagnostic-headline").declarations).toContain("color: var(--warn-text)");
	// The quiet tier: no wash, no toned text, and the one sanctioned geometry
	// step down - 1px dashed says "lightest" without asking colour to.
	const advisory = base(".row-diagnostic.tier-advisory");
	expect(advisory.declarations).toContain("--band-rule-w: 1px");
	expect(advisory.declarations).toContain("--band-rule-style: dashed");
	// (the compiler prints `background: transparent` as `none`)
	expect(advisory.declarations).toContain("background: none");
	// The bordered modes re-rank by stroke geometry, in BOTH spellings: the
	// forced-colors query and the HC theme body twins (VS Code's HC themes never
	// trip the media query). 6px, never 4: `double` cuts the width into three,
	// and a 4px double reads LIGHTER than the 2px solid below it.
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
	// The bordered override must COMPILE after the tier rules it outranks: the
	// forced-colors rule ties the unconditional tier-error on specificity, so
	// source order alone decides it.
	expect(forcedError.start).toBeGreaterThan(error.start);
	// Advisory's one forced-colors repaint survives: GrayText is the mode's own
	// hint for "matters least", on top of the geometry.
	expect(
		rulesFor(output, ".row-diagnostic.tier-advisory").some(
			(rule) => rule.context.includes(FORCED_COLORS_QUERY) && rule.declarations.toLowerCase().includes("graytext")
		)
	).toBe(true);
	// The narrow tier restates the text x alone and leans on the same calc: a
	// hand-written padding here would stop compensating the bordered modes' 6px.
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
	// A floor as the extraction's positive control, not a count: it was 40
	// until the consumerless token chains left theme.css and took seven
	// distinct host-token reads with them (46 down to 39).
	expect(read.size).toBeGreaterThan(35);
	for (const theme of ["dark", "light"] as const) {
		const defined = new Set(
			[...forcedBlock(theme).matchAll(/^\s*(--vscode-[A-Za-z0-9-]+):/gm)].map((match) => match[1] ?? "")
		);
		expect([...read].filter((token) => !defined.has(token)).sort()).toBeEmpty();
	}
});

test(
	"high contrast wins: nothing either appearance setting drives escapes the guard",
	async () => {
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
	},
	CHILD_PROCESS_TIMEOUT_MS
);

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
	const ours = [...forcedBlock("light").matchAll(/^\s*(--(?!vscode-)[a-z0-9-]+):\s*([^;]+);/gm)];
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
		[...block.matchAll(/^\s*(--(?!vscode-)[a-z0-9-]+):\s*([^;]+);/gm)]
			.map((match) => `${match[1]}: ${match[2]?.trim()}`)
			.sort();
	// A floor, not a count: it only has to be big enough that an extraction
	// finding nothing cannot pass the equality below vacuously.
	expect(ownTokens(hostDerived).length).toBeGreaterThanOrEqual(4);
	expect(ownTokens(forcedBlock("light"))).toEqual(ownTokens(hostDerived));
});

test("a forced-light override of a body-declared token is repeated on the body twin", () => {
	// The fourth block, and the one no equality reached. A token in the `:root, body`
	// block is declared DIRECTLY on body, and a direct declaration beats an inherited
	// one - so the forced light block, which sits on `html`, silently loses for exactly
	// those tokens and needs the twin to win where they are read. Which tokens those are
	// is DERIVED from the two blocks rather than listed, because the failure mode is a
	// quiet tier landing in three of its four homes and forced light keeping the dark
	// lean with every suite green.
	const source = readFileSync(themeEntry, "utf8");
	const rootAndBody = /^:root,\nbody \{([\s\S]*?)\n\}/m.exec(source)?.[1] ?? "";
	const twin = /&\[data-theme="light"\] body \{([\s\S]*?)\n\t\}/.exec(source)?.[1] ?? "";
	const declarations = (block: string) =>
		[...block.matchAll(/^\s*(--(?!vscode-)[a-z0-9-]+):\s*([^;]+);/gm)].map(
			(match) => `${match[1]}: ${match[2]?.trim()}`
		);
	const nameOf = (declaration: string) => declaration.split(":")[0] ?? "";
	// Floors as the extractions' positive controls: a regex that stopped matching would
	// otherwise satisfy the equality below with two empty lists.
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
	"severity as text resolves to the readable tier, as fills to the raw hue",
	async () => {
		// The raw hues are tuned for a dark editor (Light Modern's own published values are
		// under AA as words). The repair is a TOKEN, not a class: the pills paint through
		// .tone-* while components use text-ok/warn/err utilities - a class-only fix leaves
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
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"status fills darken on light too, because a meter is the reading",
	async () => {
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
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"the meter's axis carries no alpha of its own",
	async () => {
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
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test("the selected rail tab keeps its forced-colors mark at every width", async () => {
	// Forced colours leave the Highlight edge bar as the selection's only surviving mark.
	// Two pins, one per half of the fix: the bar must live in a forced-colors block
	// OUTSIDE every width query (first written inside the collapse query, it stopped
	// existing at full width), and the narrow re-placement must restate the system colour
	// from a LATER narrow forced-colors block - one flat layer, last background wins.
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
		// border-l-transparent gets repainted like any other border colour, so every row wore
		// the modified mark. Only the compiled cascade can catch it (happy-dom runs no cascade
		// or forced-colors mode; the class names are right either way). Asserted inside the
		// UNLAYERED forced-colors block: a system colour outside the media query paints in
		// every ordinary theme, and a layered copy loses to the very utility it overrules.
		const output = await compileTheme();
		const forced = forcedColorsBlocks(output)
			.filter((block) => block.unlayered)
			.map((block) => block.text)
			.join("\n");
		expect(forced).toContain(".setting-row:not(.modified) {\n    border-left-color: Canvas;");
		expect(forced).toContain(".setting-row.modified {\n    border-left-color: Highlight;");
		// Once each in this sheet: a second rule further down would win and hand the off state
		// its CanvasText back with the suite green. This sheet only - dashboard.css is wholly
		// layered and cannot outrank an unlayered rule. Counted without the brace, so a
		// grouped selector counts as the second declaration it is.
		expect(occurrences(output, ".setting-row:not(.modified)")).toBe(1);
		expect(occurrences(output, ".setting-row.modified")).toBe(1);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

/**
 * The ONE rule both high-contrast selectors open together. Both are looked up as rules
 * and their selector lists compared - a substring match is satisfied by
 * `...-light .thing:hover`, leaving the resting HC-light state unstyled, pin green.
 */
function highContrastTwin(css: string, selector: string): StyleRule {
	const dark = rulesFor(css, `body.vscode-high-contrast ${selector}`);
	const light = rulesFor(css, `body.vscode-high-contrast-light ${selector}`);
	// Exactly one each, because the caller then reads ONE rule's declarations and
	// context: a second copy further down - inside a width query, say - is the
	// one the browser would apply at the width it names, and the assertions
	// below would be describing the rule it beat.
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
		// The bordered modes must take the buttons' padding hand-back away or adjacent boxes
		// merge into one segmented control - but `margin-inline: 0` writes both longhands and
		// killed the record matcher pencil's ms-auto; zeroing the property composes. Only the
		// compiled cascade can catch a regression (happy-dom runs no cascade or forced-colors
		// mode).
		const output = await compileTheme();
		const blocks = forcedColorsBlocks(output).filter((block) => block.text.includes('[data-slot="button"]'));
		expect(blocks).toHaveLength(1);
		const block = blocks[0];
		// Unlayered, because the value it overrules is set by a utility and only an
		// unlayered rule beats one; unconditional, because a button's box is drawn
		// at every width.
		expect(block?.unlayered).toBe(true);
		expect(block?.unconditional).toBe(true);
		expect(block?.text).toMatch(/\[data-slot="button"\] \{\s*--btn-mx: 0px;\s*\}/);
		expect(block?.text).not.toContain("margin-inline");
		// The high-contrast twin says the same thing the same way: both HC themes
		// light --control-outline up, so they draw the same boxes.
		const hc = highContrastTwin(output, '[data-slot="button"]');
		expect(hc.declarations).toContain("--btn-mx: 0px");
		expect(hc.declarations).not.toContain("margin-inline");
		expect(hc.unlayered).toBe(true);
		expect(hc.unconditional).toBe(true);
		// And the other half of the pencil's alignment, in the ORDINARY themes: the
		// hand-back is a margin-inline shorthand and ms-auto a start longhand at
		// equal specificity, so the push survives only because Tailwind emits the
		// longhand later. Reordered, the pencil lands mid-line at narrow with every
		// component test green.
		const handBack = output.indexOf(escapedSelector("mx-(--btn-mx)"));
		expect(handBack).toBeGreaterThan(-1);
		expect(output.indexOf(escapedSelector("ms-auto"))).toBeGreaterThan(handBack);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

/**
 * The action clusters whose bordered-mode fallback is TIGHT: left alone, a cluster
 * silently grows by the padding its ink-stated gap was spanning (12px per adjacent
 * compact pair), overrunning measured budgets or moving bordered renders. Not every
 * ink-stated container is here: .confirm-actions and the .chip/.toast paddings drift
 * into MORE room, and a fallback that only loosens cannot merge two boxes. `unlayered`
 * is per cluster, decided by what the twin overrules (a utility needs an unlayered twin).
 */
const INK_GAP_CLUSTERS = [
	{ selector: ".setting-actions", sheet: "theme", declaration: "gap: 6px", unlayered: true },
	{ selector: ".model-row-actions", sheet: "dashboard", declaration: "gap: 6px", unlayered: false },
	{ selector: ".server-actions", sheet: "dashboard", declaration: "column-gap: 8px", unlayered: false },
	{ selector: ".row-diagnostic-actions", sheet: "dashboard", declaration: "column-gap: 4px", unlayered: false },
	{ selector: ".notice .toolbar", sheet: "dashboard", declaration: "column-gap: 8px", unlayered: false },
	{ selector: ".banner", sheet: "dashboard", declaration: "gap: 8px", unlayered: false },
	// The banner's trailing padding is ink-stated too (the Dismiss sits at the
	// banner's own edge), so its twin restates the box inset beside the gap.
	{ selector: ".banner", sheet: "dashboard", declaration: "padding-right: 12px", unlayered: false },
	{ selector: ".record-frame .editor-actions", sheet: "dashboard", declaration: "column-gap: 8px", unlayered: false },
] as const;

/**
 * A rule's declarations, asserted to STATE `declaration` rather than merely to
 * contain its text: `gap: 6px` is a substring of `row-gap: 6px`, which is a
 * different property with a different effect on the same rule.
 */
function statesDeclaration(declarations: string, declaration: string): boolean {
	const escaped = declaration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[;{\\s])${escaped};`).test(declarations);
}

test(
	"every ink-stated action cluster keeps its bordered-mode box gap",
	async () => {
		const sheets = { theme: await compileTheme(), dashboard: await compileDashboard() };
		for (const cluster of INK_GAP_CLUSTERS) {
			const output = sheets[cluster.sheet];
			// The forced-colors gap is read as the RULE it is, not as a substring of
			// the block around it: that block holds six other rules in theme.css, so
			// "the block mentions this selector and the block mentions this gap"
			// stays green with the gap on any one of its neighbours.
			const forced = rulesFor(output, cluster.selector).filter((rule) => rule.context.includes(FORCED_COLORS_QUERY));
			expect(forced, `no forced-colors gap for ${cluster.selector}`).toHaveLength(1);
			expect(
				statesDeclaration(forced[0]?.declarations ?? "", cluster.declaration),
				`${cluster.selector}'s forced-colors twin states another gap`
			).toBe(true);
			// The forced-colors query and NOTHING else: a twin written inside a width
			// query stops existing at every other width, and the narrow tiers are
			// where these clusters have the least room to grow into.
			expect(
				forced[0]?.context.filter((prelude) => /^@(?:media|container|supports)\b/.test(prelude)),
				`${cluster.selector}'s twin sits inside another query`
			).toEqual([FORCED_COLORS_QUERY]);
			expect(forced[0]?.unlayered, `${cluster.selector}'s twin is in the wrong layer`).toBe(cluster.unlayered);
			// The high-contrast themes draw the same boxes, so they take the same
			// number - read as the one rule both selectors open, carrying the
			// declaration itself, because a selector that merely occurs somewhere
			// proves neither that it states the gap nor that its sibling exists.
			const hc = highContrastTwin(output, cluster.selector);
			expect(
				statesDeclaration(hc.declarations, cluster.declaration),
				`the high-contrast twin for ${cluster.selector} states another gap`
			).toBe(true);
			expect(hc.unconditional).toBe(true);
			expect(hc.unlayered).toBe(cluster.unlayered);
		}
	},
	CHILD_PROCESS_TIMEOUT_MS
);

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
	// This value has been wrong once already, in a landed commit: #007100 is the hcLight
	// value, not light - the registry ships {dark/light/hcDark: #73c991, hcLight: #007100}
	// and light_modern.json does not override it. The palette is documented as faithful to
	// Light Modern; the contrast repair belongs to --ok-text, measured and tested above.
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

test(
	"tone text is one unlayered presentation: severity color plus the weight channel",
	async () => {
		// Pins the tone-text register (color AND weight - weight survives forced colors), the
		// placement (unlayered, unconditional: as layered color-only rules these lost to
		// p.hint on specificity and to color utilities by layer order), and the count (exactly
		// one ordinary rule per class - a second further down would win).
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
		// And dashboard.css may not fork it: no bare .error, .state-warn, or
		// .state-ok rule at all over there - the rules that PLACE tone text
		// (.row .row-status and friends) are longer selectors and stay.
		const dashboard = await compileDashboard();
		expect(rulesFor(dashboard, ".error")).toHaveLength(0);
		expect(rulesFor(dashboard, ".state-warn")).toHaveLength(0);
		expect(rulesFor(dashboard, ".state-ok")).toHaveLength(0);
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"tone text keeps a second channel under forced colors: the editor's squiggle",
	async () => {
		// Forced colors repaint the severity hue to CanvasText, leaving weight as
		// the only mark - a quiet one at hint sizes - so the unlayered
		// forced-colors block adds the wavy underline, the editor's own problem
		// mark. Pinned in the unlayered, unconditional forced-colors blocks
		// because a layered or width-scoped copy is the rule silently dying.
		const output = await compileTheme();
		const forced = forcedColorsBlocks(output)
			.filter((block) => block.unlayered && block.unconditional)
			.map((block) => block.text)
			.join("\n");
		const rule = /\.error,\s*\.state-warn \{([^}]*)\}/.exec(forced)?.[1] ?? "";
		expect(rule).toContain("text-decoration: underline wavy");
		// The squiggle is the PROBLEM mark, so the ok register must never wear it:
		// a forced-colors rule decorating .state-ok would dress a pass as a fault.
		expect(forced).not.toContain(".state-ok");
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"the squiggle survives source order: no tone-text rule may declare a decoration of its own",
	async () => {
		// The squiggle rule compiles BEFORE the unlayered tone-text block at equal
		// specificity, so any text-decoration the tone block gained would beat it by source
		// order. The pin: the squiggle rule is the ONLY rule for these selectors declaring
		// text-decoration at all.
		const output = await compileTheme();
		const squiggleStart = Math.min(
			...rulesFor(output, ".error").flatMap((candidate) =>
				candidate.context.includes(FORCED_COLORS_QUERY) && candidate.declarations.includes("underline wavy")
					? [candidate.start]
					: []
			)
		);
		expect(squiggleStart, "no forced-colors squiggle rule for .error").toBeLessThan(Number.POSITIVE_INFINITY);
		for (const selector of [".error", ".state-warn", ".state-ok"] as const) {
			for (const candidate of rulesFor(output, selector)) {
				if (candidate.context.includes(FORCED_COLORS_QUERY) && candidate.declarations.includes("underline wavy")) {
					continue;
				}
				expect(
					candidate.declarations.includes("text-decoration") && candidate.start > squiggleStart,
					`a ${selector} rule after the squiggle declares its own text-decoration and silently overrides it`
				).toBe(false);
			}
		}
	},
	CHILD_PROCESS_TIMEOUT_MS
);

test(
	"the bordered modes keep the reveal primitive painted",
	async () => {
		// The bordered modes refuse ui/reveal.tsx's quietness trade (a resting-invisible
		// action is a bare box flickering under the pointer). Unlayered because opacity-0 is a
		// utility; unconditional because the boxes draw at every width. Only the compiled
		// cascade can catch a regression here.
		const output = await compileTheme();
		const blocks = forcedColorsBlocks(output).filter((block) => block.text.includes('[data-slot="reveal"]'));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.unlayered).toBe(true);
		expect(blocks[0]?.unconditional).toBe(true);
		expect(blocks[0]?.text).toMatch(/\[data-slot="reveal"\] \{\s*opacity: 1;\s*\}/);
		const hc = highContrastTwin(output, '[data-slot="reveal"]');
		expect(hc.declarations).toContain("opacity: 1");
		expect(hc.unlayered).toBe(true);
		expect(hc.unconditional).toBe(true);
	},
	CHILD_PROCESS_TIMEOUT_MS
);
