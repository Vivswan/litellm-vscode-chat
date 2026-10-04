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
	// A grouping rule opens no layer and holds only where its condition does: an order declared under print alone
	// leaves the screen with the unconditional one, which here puts components below base.
	{
		name: "a layer mentioned off the entry's top level",
		order: "components, theme, base, utilities",
		sheet: plainSheet(),
		named: ["theme.css", "media at line 1"],
		lead: "@media print { @layer theme, base, components; }",
	},
	{
		name: "an anonymous wrap",
		order: "theme, base, components, utilities",
		sheet: plainSheet({ wrap: "" }),
		named: ["dashboard.css", "anonymous"],
	},
	// A top-level layer block is a first mention too: a components block printed ahead of the order statement ranks
	// components first, whatever the statement says afterwards.
	{
		name: "components first mentioned by a block ahead of the order",
		order: "theme, base, components, utilities",
		sheet: plainSheet(),
		named: ["dashboard.css", "components", "theme"],
		lead: "@layer components { .early { color: red; } }",
	},
	// A dotted name is a sub-layer, which these sheets never declare; the gate refuses it rather than ranking it.
	{
		name: "a dotted layer name",
		order: "theme, base, components.extra, utilities",
		sheet: plainSheet({ wrap: "components.extra" }),
		named: ["theme.css", "components.extra", "flat"],
	},
	{
		name: "a rule outside the wrap, which outranks every layer",
		order: "theme, base, components, utilities",
		sheet: plainSheet({ trailer: ".stray-unlayered {\n  color: red;\n}\n" }),
		named: ["dashboard.css", "style at line 7"],
	},
	// A layer nested inside the wrap ranks below the wrap's own declarations, however deep a grouping rule hides it.
	{
		name: "a layer nested inside the wrap",
		order: "theme, base, components, utilities",
		sheet: plainSheet({
			inner: "  @media print {\n    @layer deep {\n      .z {\n        color: red;\n      }\n    }\n  }\n",
		}),
		named: ["dashboard.css", "components", "layer-block at line 7"],
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
