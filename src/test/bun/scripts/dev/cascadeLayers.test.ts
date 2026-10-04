import { expect, test } from "bun:test";
import { assertLayersOrdered } from "../../../../../scripts/dev/cascadeLayers";

/**
 * The compiled shapes the bundle hands the gate, hand-written: Tailwind prints the entry's order statement ahead of
 * the layer blocks it fills, and Bun's CSS bundler prints a plain sheet behind a file banner. The fixture's own order
 * is the case under test, never read back from theme.css.
 */
const tailwindEntry = (order: string, lead = ""): string =>
	[
		lead,
		`@layer ${order};`,
		"@layer theme { :root { --text-xs: 10px; } }",
		"@layer base { button { font-size: inherit; } }",
		"@layer utilities { .text-xs { font-size: var(--text-xs); } }",
		"",
	].join("\n");

const plainSheet = ({ wrap = "components", trailer = "" } = {}): string =>
	`/* src/webview/dashboard/styles/dashboard.css */\n@layer ${wrap} {\n  button.help {\n    font-size: 10px;\n  }\n}\n${trailer}`;

test("the declared order passes: theme, base, components, utilities", () => {
	expect(() => assertLayersOrdered([tailwindEntry("theme, base, components, utilities"), plainSheet()])).not.toThrow();
});

// Every rejected shape names the layers at fault, so the bundle failure points at the statement to fix. The first
// row is the order that let `@layer base`'s `button { font-size: inherit }` overwrite `button.help`'s own 10px with
// the gate green: a layer declared below base loses to base whatever its specificity.
const rejected: readonly {
	readonly name: string;
	readonly order: string;
	readonly sheet: string;
	readonly named: readonly string[];
	/** Printed ahead of the order statement, where a mention ranks before anything the statement says. */
	readonly lead?: string;
}[] = [
	{
		name: "components declared below base",
		order: "theme, components, base, utilities",
		sheet: plainSheet(),
		named: ["components", "base"],
	},
	{
		name: "components declared above utilities",
		order: "theme, base, utilities, components",
		sheet: plainSheet(),
		named: ["components", "utilities"],
	},
	{
		name: "components never declared, so it ranks last",
		order: "theme, base, utilities",
		sheet: plainSheet(),
		named: ["components", "utilities"],
	},
	// A sub-layer's first mention is its parent's first mention too: components.early ahead of base ranks components
	// ahead of base, whatever the order statement says afterwards.
	{
		name: "components first mentioned through a sub-layer",
		order: "components.early, theme, base, components, utilities",
		sheet: plainSheet(),
		named: ["components", "base"],
	},
	// A grouping rule opens no layer but holds only where its condition does: an order declared under print alone
	// leaves the screen with the unconditional one, which here puts components below base.
	{
		name: "a layer first mentioned inside a grouping rule",
		order: "components, theme, base, utilities",
		sheet: plainSheet(),
		named: ["theme", "@media print"],
		lead: "@media print { @layer theme, base, components; }",
	},
	// A sub-layer ranks where its parent does: components.late after base in the flat list still sits inside
	// components, which base beats.
	{
		name: "a dotted wrap whose parent ranks below base",
		order: "theme, components, base, components.late, utilities",
		sheet: plainSheet({ wrap: "components.late" }),
		named: ["components.late", "base"],
	},
	{
		name: "a rule outside the wrap, which outranks every layer",
		order: "theme, base, components, utilities",
		sheet: plainSheet({ trailer: ".stray-unlayered {\n  color: red;\n}\n" }),
		named: ["components", ".stray-unlayered"],
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
