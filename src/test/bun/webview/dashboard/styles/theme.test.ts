import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const themeEntry = path.resolve(import.meta.dir, "../../../../../webview/dashboard/styles/theme.css");
const scannedTrees = [
	path.resolve(import.meta.dir, "../../../../../webview"),
	path.resolve(import.meta.dir, "../../../../../dashboard"),
];

/**
 * The utilities Tailwind's source scan currently mints, every one from an
 * incidental word token (identifiers and UI strings), none consumed by
 * markup - the pixel-identity contract depends on that, and the collision
 * test below asserts it. A new name here means the scan picked something
 * up; update the pin deliberately.
 */
const EXPECTED_UTILITIES = [
	"absolute",
	"block",
	"blur",
	"border",
	"collapse",
	"container",
	"contents",
	"filter",
	"fixed",
	"flex",
	"grid",
	"hidden",
	"inline",
	"invisible",
	"ordinal",
	"relative",
	"shadow",
	"static",
	"sticky",
	"table",
	"transition",
	"visible",
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
		.map((name) => path.join(dir, name));
}

/**
 * Every class token the markup can carry: string literals inside class-ish
 * JSX attributes (className, inputClass, ...) including their ternary and
 * template forms, plus string literals in statements that assign class-list
 * variables (the `const chipClass = [...]` builders), split on whitespace.
 */
function markupClassTokens(): Set<string> {
	const tokens = new Set<string>();
	const collect = (segment: string) => {
		for (const [, literal] of segment.matchAll(/["'`]([^"'`]*)["'`]/g)) {
			for (const token of (literal ?? "").split(/[\s${}]+/)) {
				if (token.length > 0) {
					tokens.add(token);
				}
			}
		}
	};
	for (const file of scannedTrees.flatMap(sourceFiles)) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(/[A-Za-z]*[Cc]lass(?:Name)?=(?:"[^"]*"|\{[\s\S]*?\})/g)) {
			collect(match[0]);
		}
		for (const match of text.matchAll(/[A-Za-z]*[Cc]lass(?:es)?\s*=\s*\[[\s\S]*?\]/g)) {
			collect(match[0]);
		}
	}
	return tokens;
}

test("the Tailwind scan mints exactly the pinned utility set and none collides with markup", async () => {
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
	// Any-depth class selectors: variant utilities (sm:flex, hover:grid)
	// nest under @media or carry escaped colons, and must not escape the pin.
	const utilities = [...output.matchAll(/^\s*\.([^\s{]+) \{/gm)].map((match) => match[1] ?? "").sort();
	// An empty set would mean the @source paths stopped resolving (they fail
	// silently inside Tailwind), not that the sources went utility-free.
	expect(utilities).not.toBeEmpty();
	expect(utilities).toEqual(EXPECTED_UTILITIES);

	// A minted utility matching a class the markup actually carries would
	// silently restyle shipped elements: exactly what the pixel-identity
	// contract forbids while no markup consumes utilities on purpose. The
	// size floor keeps the extraction honest - an extractor that finds no
	// tokens proves nothing (the audited markup carries roughly 240).
	const markup = markupClassTokens();
	expect(markup.size).toBeGreaterThan(100);
	expect(utilities.filter((utility) => markup.has(utility))).toBeEmpty();
});
