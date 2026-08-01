/**
 * Shared machinery for the l10n scripts: the deterministic source walk and
 * extraction behind `l10n:extract`, the module-scope localization guard, and
 * the zod schemas `l10n:check` parses every translation file with. Scripts
 * run from the repo root (package.json invokes them there), so paths anchor
 * on process.cwd() like the other scripts in this tree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getL10nJson, type l10nJsonFormat } from "@vscode/l10n-dev";
import { z } from "zod";

/** The English reference bundle: what extract writes and check re-derives. */
export const BUNDLE_PATH = path.join(process.cwd(), "l10n", "bundle.l10n.json");

/**
 * The generated English bundle's values: a message, optionally wrapped with
 * translator comments (l10n.t({message, comment}) mints those). Translated
 * bundles are NOT allowed the wrapped shape; check.ts parses them with
 * nlsSchema because the webview bootstrap drops non-string values wholesale.
 */
export const bundleSchema = z.record(
	z.string(),
	z.union([z.string(), z.object({ message: z.string(), comment: z.array(z.string()) })])
);
export type BundleFile = z.infer<typeof bundleSchema>;

/** Flat key-to-string tables: package.nls*.json and translated bundle.l10n.<locale>.json. */
export const nlsSchema = z.record(z.string(), z.string());

/** The message text of one bundle value, whichever shape it uses. */
export function bundleMessage(value: BundleFile[string]): string {
	return typeof value === "string" ? value : value.message;
}

export interface SourceFile {
	readonly file: string;
	readonly contents: string;
}

/** Every src/**\/*.ts|tsx outside src/test with its contents, sorted so extraction order is stable. */
export async function readSourceFiles(): Promise<SourceFile[]> {
	const srcRoot = path.join(process.cwd(), "src");
	const entries = await fs.readdir(srcRoot, { recursive: true, withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) {
			continue;
		}
		const full = path.join(entry.parentPath, entry.name);
		const [head] = path.relative(srcRoot, full).split(path.sep);
		if (head === "test") {
			continue;
		}
		files.push(full);
	}
	files.sort();
	return Promise.all(files.map(async (file) => ({ file, contents: await fs.readFile(file, "utf8") })));
}

/** Extract every l10n.t()/vscode.l10n.t() literal from the source tree, key-sorted. */
export async function extractBundle(): Promise<l10nJsonFormat> {
	const files = await readSourceFiles();
	const extracted = await getL10nJson(files.map(({ file, contents }) => ({ extension: path.extname(file), contents })));
	const sorted: l10nJsonFormat = {};
	for (const key of Object.keys(extracted).sort()) {
		sorted[key] = extracted[key];
	}
	return sorted;
}

/** The bundle's on-disk form; one serializer so extract and check cannot disagree. */
export function serializeBundle(bundle: l10nJsonFormat): string {
	return `${JSON.stringify(bundle, null, "\t")}\n`;
}

/**
 * Line numbers (1-based) of module-level const/let/var initializers that
 * call a localization function on the declaration line. A module-scope call
 * evaluates before l10n.config and freezes the English text, so the lazy
 * rule bans it. A heuristic (column-zero declarations, same-line call), not
 * a parser: it catches the easy mistake, not every conceivable one; a
 * function-valued initializer defers the call and passes.
 */
export function moduleScopeL10nOffenses(contents: string): number[] {
	const offenses: number[] = [];
	for (const [index, line] of contents.split("\n").entries()) {
		if (!/^(?:export\s+)?(?:const|let|var)\s/.test(line)) {
			continue;
		}
		const call = /\bl10n\.t\(|\bmanageCommandTitle\(\)/.exec(line);
		if (call === null) {
			continue;
		}
		if (/=>|\bfunction\b/.test(line.slice(0, call.index))) {
			continue;
		}
		offenses.push(index + 1);
	}
	return offenses;
}
