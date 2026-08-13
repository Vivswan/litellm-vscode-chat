import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const stylesDir = path.resolve(import.meta.dir, "../../../../../webview/dashboard/styles");
const themeEntry = path.join(stylesDir, "theme.css");
const legacyEntry = path.join(stylesDir, "dashboard.css");

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
] as const;

/** A utility name as it appears escaped in a compiled selector. */
function escapedSelector(utility: string): string {
	return `.${utility.replace(/[^a-zA-Z0-9-]/g, (char) => `\\${char}`)}`;
}

async function compileTheme(): Promise<string> {
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
	expect(exitCode, errors).toBe(0);
	return output;
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

test("the cascade puts legacy below components and utilities", async () => {
	// The order declaration lives in theme.css and the wrap in dashboard.css;
	// together they are the contract that a utility always beats a legacy rule.
	expect(readFileSync(themeEntry, "utf8")).toContain("@layer theme, base, legacy, components, utilities;");
	expect(readFileSync(legacyEntry, "utf8")).toContain("@layer legacy {");
});

test("no minted utility collides with a class the legacy stylesheet styles", async () => {
	const output = await compileTheme();
	// Utilities outrank the legacy layer, so a utility whose name matches a
	// dashboard.css class would silently restyle every element carrying it
	// (the scan also mints utilities from incidental word tokens). Compare
	// against the classes the legacy stylesheet actually styles.
	const minted = new Set([...output.matchAll(/^\s*\.([A-Za-z][A-Za-z0-9-]*)[\s{,:]/gm)].map((match) => match[1] ?? ""));
	const legacyClasses = new Set(
		[...readFileSync(legacyEntry, "utf8").matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((match) => match[1] ?? "")
	);
	// The size floors keep both extractions honest; an extractor finding
	// nothing would prove nothing.
	expect(minted.size).toBeGreaterThan(REQUIRED_UTILITIES.length);
	expect(legacyClasses.size).toBeGreaterThan(100);
	expect([...minted].filter((utility) => legacyClasses.has(utility))).toBeEmpty();
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
	const legacy = readFileSync(legacyEntry, "utf8");
	const scrimRule = /\.scrim\s*\{[^}]*\}/.exec(legacy)?.[0];
	expect(scrimRule).toBeDefined();
	expect(scrimRule).toContain("pointer-events: auto");
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
	// every consumer reads: the semantic mapping, the legacy stylesheet's direct
	// reads, and the utilities alike. A token the palettes miss keeps its value
	// from the editor's theme, which is how a forced dark dashboard ends up a
	// light page with one black input.
	const read = new Set<string>();
	for (const entry of [themeEntry, legacyEntry]) {
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
	// otherwise: the legacy stylesheet paints pills through .tone-*, while
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
	const legacy = readFileSync(legacyEntry, "utf8");
	expect(/\.tone-ok \{\s*color: var\(--ok-text\);/.test(legacy)).toBe(true);
	// No status hue may still be painted as text anywhere in the legacy sheet.
	const rawText = [
		...legacy.matchAll(
			/\n\s*color: var\(--vscode-(testing-iconPassed|errorForeground|editorWarning-foreground|notificationsWarningIcon-foreground)/g
		),
	];
	expect(rawText).toBeEmpty();
});

test("status fills darken on light too, because a meter is the reading", async () => {
	// The text tier exempted fills on the grounds that a shape carries no
	// reading burden. True of a dot beside a word; false of a 3px meter, which
	// measured 1.88:1 against its own light track - a healthy bar nobody can
	// see. Fills need 3:1 rather than 4.5, so they darken more gently and keep
	// more of the bright character the meter wants.
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
