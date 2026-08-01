/**
 * Shared machinery for the l10n scripts: the deterministic source walk and
 * extraction behind `l10n:extract`, plus the zod schemas `l10n:check` parses
 * every translation file with. Scripts run from the repo root (package.json
 * invokes them there), so paths anchor on process.cwd() like the other
 * scripts in this tree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getL10nJson, type l10nJsonFormat } from "@vscode/l10n-dev";
import { z } from "zod";

/** The English reference bundle: what extract writes and check re-derives. */
export const BUNDLE_PATH = path.join(process.cwd(), "l10n", "bundle.l10n.json");

/** bundle.l10n*.json values: a message, optionally wrapped with translator comments. */
export const bundleSchema = z.record(
	z.string(),
	z.union([z.string(), z.object({ message: z.string(), comment: z.array(z.string()) })])
);
export type BundleFile = z.infer<typeof bundleSchema>;

/** package.nls*.json: a flat key-to-string table. */
export const nlsSchema = z.record(z.string(), z.string());

/** The message text of one bundle value, whichever shape it uses. */
export function bundleMessage(value: BundleFile[string]): string {
	return typeof value === "string" ? value : value.message;
}

/** Every src/**\/*.ts|tsx outside src/test, sorted so extraction order is stable. */
async function listSourceFiles(): Promise<string[]> {
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
	return files.sort();
}

/** Extract every l10n.t()/vscode.l10n.t() literal from the source tree, key-sorted. */
export async function extractBundle(): Promise<l10nJsonFormat> {
	const files = await listSourceFiles();
	const contents = await Promise.all(
		files.map(async (file) => ({ extension: path.extname(file), contents: await fs.readFile(file, "utf8") }))
	);
	const extracted = await getL10nJson(contents);
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
