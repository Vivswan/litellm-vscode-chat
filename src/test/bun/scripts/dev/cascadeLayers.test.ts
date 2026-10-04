import { expect, test } from "bun:test";
import { assertLayersOrdered } from "../../../../../scripts/dev/cascadeLayers";

/**
 * The compiled shapes the bundle hands the gate, hand-written: Tailwind prints the entry's order statement ahead of
 * the layer blocks it fills, and Bun's CSS bundler prints a plain sheet behind a file banner. The fixture's own order
 * is the case under test, never read back from theme.css.
 */
const tailwindEntry = (order: string, lead = ""): { id: string; css: string } => ({
	id: "theme.css",
	css: [
		lead,
		`@layer ${order};`,
		"@layer theme { :root { --text-xs: 10px; } }",
		"@layer base { button { font-size: inherit; } }",
		"@layer utilities { .text-xs { font-size: var(--text-xs); } }",
		"",
	].join("\n"),
});

const plainSheet = ({ wrap = "components", inner = "", trailer = "" } = {}): { id: string; css: string } => ({
	id: "dashboard.css",
	css: `/* src/webview/dashboard/styles/dashboard.css */\n@layer ${wrap} {\n  button.help {\n    font-size: 10px;\n  }\n${inner}}\n${trailer}`,
});

test("the declared order passes: theme, base, components, utilities", () => {
	expect(() => assertLayersOrdered([tailwindEntry("theme, base, components, utilities"), plainSheet()])).not.toThrow();
});

// Every rejected shape names the sheet at fault and the layers or rule behind the refusal, so the bundle failure
// points at the statement to fix. The first row is the order that let `@layer base`'s `button { font-size: inherit }`
// overwrite `button.help`'s own 10px with the gate green: a layer declared below base loses to base whatever its
// specificity.
const rejected: readonly {
	readonly name: string;
	readonly order: string;
	readonly sheet: { id: string; css: string };
	readonly named: readonly string[];
	/** Printed ahead of the order statement, where a mention ranks before anything the statement says. */
	readonly lead?: string;
}[] = [
	{
		name: "components declared below base",
		order: "theme, components, base, utilities",
		sheet: plainSheet(),
		named: ["dashboard.css", "components", "base"],
	},
	{
		name: "components declared above utilities",
		order: "theme, base, utilities, components",
		sheet: plainSheet(),
		named: ["dashboard.css", "components", "utilities"],
	},
	{
		name: "components never declared, so it ranks last",
		order: "theme, base, utilities",
		sheet: plainSheet(),
		named: ["dashboard.css", "components", "utilities"],
	},
	// A sub-layer's first mention is its parent's first mention too: components.early ahead of base ranks components
	// ahead of base, whatever the order statement says afterwards.
	{
		name: "components first mentioned through a sub-layer",
		order: "components.early, theme, base, components, utilities",
		sheet: plainSheet(),
		named: ["dashboard.css", "components", "base"],
	},
	// An import into a layer mentions it where the import stands, ahead of the order statement.
	{
		name: "components first mentioned by an import into it",
		order: "theme, base, components, utilities",
		sheet: plainSheet(),
		named: ["dashboard.css", "components", "theme"],
		lead: '@import url("tokens.css") layer(components);',
	},
	// An import qualified by a condition mentions its layer only where the condition holds, so as a first mention it
	// is refused like a mention under a media query.
	{
		name: "components first mentioned by a conditional import",
		order: "theme, base, components, utilities",
		sheet: plainSheet(),
		named: ["theme.css", "components", "supports(display: grid)"],
		lead: '@import url("tokens.css") layer(components) supports(display: grid);',
	},
	// A grouping rule opens no layer and holds only where its condition does: an order declared under print alone
	// leaves the screen with the unconditional one, which here puts components below base.
	{
		name: "a layer first mentioned inside a grouping rule",
		order: "components, theme, base, utilities",
		sheet: plainSheet(),
		named: ["theme.css", "theme", "@media print"],
		lead: "@media print { @layer theme, base, components; }",
	},
	// A layer block nested inside a style rule (CSS nesting) is a real layer and would rank components first.
	{
		name: "a layer block nested inside a style rule ahead of the order",
		order: "theme, base, components, utilities",
		sheet: plainSheet(),
		named: ["theme.css", "components", "button.help"],
		lead: "button.help { @layer components { color: red; } }",
	},
	// A sub-layer ranks where its parent does: components.late after base in the flat list still sits inside
	// components, which base beats.
	{
		name: "a dotted wrap whose parent ranks below base",
		order: "theme, components, base, components.late, utilities",
		sheet: plainSheet({ wrap: "components.late" }),
		named: ["dashboard.css", "components.late", "base"],
	},
	// An escaped dot is part of the identifier, so this wrap is one top-level layer the entry never mentions, not the
	// sub-layer the entry declares.
	{
		name: "a wrap whose escaped dot is no sub-layer",
		order: "theme, base, components.early, utilities",
		sheet: plainSheet({ wrap: "components\\.early" }),
		named: ["dashboard.css", "utilities"],
	},
	{
		name: "a rule outside the wrap, which outranks every layer",
		order: "theme, base, components, utilities",
		sheet: plainSheet({ trailer: ".stray-unlayered {\n  color: red;\n}\n" }),
		named: ["dashboard.css", "components", ".stray-unlayered"],
	},
	// A layer nested inside the wrap ranks below the wrap's own declarations, however deep a grouping rule hides it.
	{
		name: "a layer nested inside the wrap",
		order: "theme, base, components, utilities",
		sheet: plainSheet({
			inner: "  @media print {\n    @layer deep {\n      .z {\n        color: red;\n      }\n    }\n  }\n",
		}),
		named: ["dashboard.css", "components", "@layer deep"],
	},
];

for (const { name, order, sheet, named, lead } of rejected) {
	test(`the gate rejects ${name}`, () => {
		let message = "";
		try {
			assertLayersOrdered([tailwindEntry(order, lead), sheet]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toStartWith("[CSS_ERROR]");
		for (const layer of named) {
			expect(message).toContain(layer);
		}
	});
}
