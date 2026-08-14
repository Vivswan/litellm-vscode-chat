import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dashboardEntry } from "./compileStyles";

/**
 * ONE right edge per surface (the visual-language charter's width rule): a
 * measured destination's header and body wear the SAME measure, spelled once
 * as a module constant so the two cannot drift apart. happy-dom runs no
 * cascade, so no component suite can see a header ruling past its list; the
 * source and the stylesheet are the only places the contract is checkable.
 */

const dashboardDir = path.resolve(import.meta.dir, "../../../../../webview/dashboard");

/** The `<NAME>_MEASURE` constant's value, asserted present and rem-valued. */
function measureConstant(file: string, name: string): { readonly utility: string; readonly width: string } {
	const source = readFileSync(path.join(dashboardDir, file), "utf8");
	const match = new RegExp(`const ${name} = "(max-w-\\[(\\d+rem)\\])";`).exec(source);
	expect(match, `${file} must declare const ${name} = "max-w-[<N>rem]"`).not.toBeNull();
	return { utility: match?.[1] ?? "", width: match?.[2] ?? "" };
}

/** How many times `needle` appears in `haystack`, as a plain substring. */
function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test("the Servers page's header and list share SERVERS_MEASURE", () => {
	const { utility } = measureConstant("servers.tsx", "SERVERS_MEASURE");
	const source = readFileSync(path.join(dashboardDir, "servers.tsx"), "utf8");
	// The surface measure is spelled exactly once - in the constant. A second
	// literal is a fork: it can drift and hand the header and the list
	// different right edges.
	expect(occurrences(source, utility)).toBe(1);
	// ...and both wearers read the constant: the section header and the list.
	expect(source).toContain("headerClassName={SERVERS_MEASURE}");
	expect(source).toMatch(/cn\("server-list", SERVERS_MEASURE\)/);
});

test("the Diagnostics page's headers and its stylesheet body caps agree", () => {
	const { utility, width } = measureConstant("diagnostics.tsx", "DIAGNOSTICS_MEASURE");
	const source = readFileSync(path.join(dashboardDir, "diagnostics.tsx"), "utf8");
	expect(occurrences(source, utility)).toBe(1);
	// All three section headers wear the constant.
	expect(occurrences(source, "headerClassName={DIAGNOSTICS_MEASURE}")).toBe(3);
	// The page's body caps live in dashboard.css (the problem list and the
	// resolution table's scrollport); each must state the same width the
	// headers wear, or the page grows a second right edge.
	const sheet = readFileSync(dashboardEntry, "utf8");
	for (const selector of [".config-diagnostics", ".resolved-scroll"]) {
		const rule = new RegExp(`\\${selector} \\{[^}]*max-width: ([^;]+);`).exec(sheet);
		expect(rule, `dashboard.css must cap ${selector} at the page measure`).not.toBeNull();
		expect(rule?.[1]).toBe(width);
	}
});
