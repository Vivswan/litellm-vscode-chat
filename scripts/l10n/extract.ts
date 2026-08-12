/**
 * Writes l10n/bundle.l10n.json: every l10n.t() literal in src (tests
 * excluded), key-sorted so a rerun or a merge always reproduces the same
 * bytes. `l10n:check` fails the build when this file drifts from the
 * source, so run this after adding or changing localized strings.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { BUNDLE_PATH, extractBundle, serializeBundle } from "./lib";

async function main(): Promise<void> {
	const bundle = await extractBundle();
	await fs.mkdir(path.dirname(BUNDLE_PATH), { recursive: true });
	await fs.writeFile(BUNDLE_PATH, serializeBundle(bundle));
	console.log(`Wrote ${Object.keys(bundle).length} keys to ${path.relative(process.cwd(), BUNDLE_PATH)}.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
