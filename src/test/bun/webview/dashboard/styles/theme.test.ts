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
	"hover:bg-err-wash",
	"hover:text-err",
	"hover:bg-ghost-hover",
	"text-muted-foreground",
	"border-input",
	"bg-input-background",
	"placeholder:text-input-placeholder",
	"aria-invalid:border-input-invalid",
	"bg-dropdown-background",
	"accent-primary",
	"text-warning",
	"focus-visible:outline-ring",
	"disabled:opacity-60",
	"disabled:bg-transparent",
	"disabled:text-disabled-foreground",
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
