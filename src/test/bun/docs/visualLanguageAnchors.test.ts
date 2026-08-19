import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The visual-language charter cites its evidence as durable anchors; every
 * anchor must resolve against today's source, so a renamed selector or a
 * deleted component fails HERE, with the charter line to fix. Line-number
 * citations are banned outright: they rot within days of landing.
 *
 * The grammar, documented at the top of the charter and implemented here:
 *
 * - A citation is one backtick span whose first token names a file by
 *   extension (a span may wrap across a line break; its whitespace collapses):
 *   `FILE` alone references the file (it must exist); `FILE ANCHOR` also
 *   names an anchor in it.
 * - FILE resolves under `src/webview/dashboard/` (`dashboard.css` and
 *   `theme.css` under its `styles/`); a path starting with `src/` resolves
 *   from the repository root.
 * - In a stylesheet, the anchor is a selector or at-rule prelude fragment and
 *   must appear inside some rule prelude, or a `--custom-property`, which
 *   must be declared.
 * - In a TS/TSX file, the anchor is an identifier or class-name token and
 *   must appear in the file's code or string literals - a stale comment does
 *   not count.
 */
const repoRoot = path.resolve(import.meta.dir, "../../../..");
const charterPath = path.join(repoRoot, "docs/dashboard-visual-language.md");
const dashboardRoot = path.join(repoRoot, "src/webview/dashboard");

/** First-token file names this grammar recognizes; everything else in backticks is ordinary prose. */
const CITED_FILE = /^[\w./-]+\.(?:css|tsx|ts)$/;

function resolveCitedFile(token: string): string {
	if (token === "dashboard.css" || token === "theme.css") {
		return path.join(dashboardRoot, "styles", token);
	}
	if (token.startsWith("src/")) {
		return path.join(repoRoot, token);
	}
	return path.join(dashboardRoot, token);
}

interface Citation {
	/** 1-based charter line, so a failure names the line to fix. */
	readonly line: number;
	readonly file: string;
	readonly anchor: string | undefined;
	readonly span: string;
}

function parseCharter(source: string): { citations: Citation[]; lineNumberForms: string[] } {
	const citations: Citation[] = [];
	const lineNumberForms: string[] = [];
	source.split("\n").forEach((text, index) => {
		// The banned line-number form: file.ext:123, backticked or not.
		if (/\.(?:css|tsx|ts):\d/.test(text)) {
			lineNumberForms.push(`charter line ${index + 1}: ${text.trim()}`);
		}
	});
	// Spans are scanned over the WHOLE document: markdown lets a backtick span
	// wrap across a line break, and a wrapped citation that stopped parsing would
	// be unchecked rot. Wrapped whitespace collapses to one space, as markdown
	// renders it.
	for (const match of source.matchAll(/`([^`]+)`/g)) {
		const span = (match[1] ?? "").replace(/\s+/g, " ").trim();
		const spaceAt = span.indexOf(" ");
		const fileToken = spaceAt === -1 ? span : span.slice(0, spaceAt);
		if (!CITED_FILE.test(fileToken)) {
			continue;
		}
		citations.push({
			line: source.slice(0, match.index).split("\n").length,
			file: fileToken,
			anchor: spaceAt === -1 ? undefined : span.slice(spaceAt + 1),
			span,
		});
	}
	return { citations, lineNumberForms };
}

/**
 * CSS with comments blanked and string contents kept EXCEPT structural
 * characters, so a comment cannot fake a prelude, a `content: "{"` cannot
 * unbalance the walk, and an attribute selector's quoted value still reads as
 * part of its prelude.
 */
function blankCssNoise(css: string): string {
	let out = "";
	for (let i = 0; i < css.length; i++) {
		const char = css[i] as string;
		if (char === "/" && css[i + 1] === "*") {
			const end = css.indexOf("*/", i + 2);
			const stop = end === -1 ? css.length : end + 2;
			out += " ".repeat(stop - i);
			i = stop - 1;
		} else if (char === '"' || char === "'") {
			out += char;
			let j = i + 1;
			while (j < css.length && css[j] !== char) {
				const piece = css[j] === "\\" ? css.slice(j, j + 2) : (css[j] as string);
				out += /[{};]/.test(piece) ? " ".repeat(piece.length) : piece;
				j += piece.length;
			}
			if (j < css.length) {
				out += char;
			}
			i = j;
		} else {
			out += char;
		}
	}
	return out;
}

/** Every rule and at-rule prelude in the sheet, at any nesting depth. */
function cssPreludes(css: string): string[] {
	const blanked = blankCssNoise(css);
	const preludes: string[] = [];
	let start = 0;
	for (let i = 0; i < blanked.length; i++) {
		const char = blanked[i];
		if (char === "{") {
			const prelude = blanked.slice(start, i).trim();
			if (prelude.length > 0) {
				preludes.push(prelude.replace(/\s+/g, " "));
			}
			start = i + 1;
		} else if (char === "}" || char === ";") {
			start = i + 1;
		}
	}
	return preludes;
}

/** Not part of a longer token on either side: the boundary set covers identifiers, class names, and custom properties. */
function hasTokenBoundaries(haystack: string, needle: string): boolean {
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^\\w$-])${escaped}($|[^\\w$-])`).test(haystack);
}

/**
 * TS/TSX with comments removed by the REAL parser, string and template contents
 * kept: an anchor satisfied only by a stale comment is the rot this suite
 * catches, while class names live in string literals and must keep counting.
 * Types are stripped with the comments, so an anchor must name a value, a
 * class-name token, or a JSX attribute.
 */
function stripTsComments(fileName: string, source: string): string {
	// removeComments spares copyright headers, so "/*!" is demoted to an ordinary
	// comment first. Inside a string literal the rewrite only shortens that
	// string's text, and no legal anchor contains "/*!".
	return ts.transpileModule(source.replaceAll("/*!", "/* "), {
		fileName,
		compilerOptions: {
			removeComments: true,
			jsx: ts.JsxEmit.Preserve,
			target: ts.ScriptTarget.ESNext,
		},
	}).outputText;
}

function anchorResolves(citedPath: string, anchor: string, source: string): boolean {
	if (citedPath.endsWith(".css")) {
		// Both routes read the sheet with comments blanked, so a commented-out
		// declaration cannot satisfy a citation.
		if (anchor.startsWith("--")) {
			return new RegExp(`${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(blankCssNoise(source));
		}
		const normalized = anchor.replace(/\s+/g, " ");
		return cssPreludes(source).some((prelude) => hasTokenBoundaries(prelude, normalized));
	}
	return hasTokenBoundaries(stripTsComments(path.basename(citedPath), source), anchor);
}

test("every charter citation resolves against today's source", () => {
	const charter = readFileSync(charterPath, "utf8");
	const { citations, lineNumberForms } = parseCharter(charter);
	expect(lineNumberForms).toEqual([]);
	// The exact count, not a floor: deletion is the one rot this resolver is
	// structurally blind to - removing a citation only makes "every anchor
	// resolves" greener - and it doubles as the parser's positive control. A
	// deliberate charter edit moves the number with it.
	expect(citations.length).toBe(176);
	const failures: string[] = [];
	const sources = new Map<string, string | undefined>();
	for (const citation of citations) {
		const citedPath = resolveCitedFile(citation.file);
		if (!sources.has(citedPath)) {
			sources.set(citedPath, existsSync(citedPath) ? readFileSync(citedPath, "utf8") : undefined);
		}
		const source = sources.get(citedPath);
		if (source === undefined) {
			failures.push(`charter line ${citation.line}: \`${citation.span}\` cites ${citation.file}, which does not exist`);
			continue;
		}
		if (citation.anchor !== undefined && !anchorResolves(citedPath, citation.anchor, source)) {
			failures.push(
				citedPath.endsWith(".css")
					? `charter line ${citation.line}: \`${citation.anchor}\` is not a selector in ${citation.file}`
					: `charter line ${citation.line}: \`${citation.anchor}\` does not appear in ${citation.file}`
			);
		}
	}
	expect(failures).toEqual([]);
});
