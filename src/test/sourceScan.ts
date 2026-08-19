/**
 * The one shipped-source scanner behind every source-shape pin: suites that pin
 * an API or idiom to one file (singleton creation points, the profile-path
 * walk, the verdict and problem-band pipelines) share this walk, so the pins
 * cannot drift on what "shipped source" means.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_ROOT } from "./util/repoRoot";

export interface ShippedSource {
	/** Repo-relative posix path (src/...), the same string on every OS. */
	readonly file: string;
	readonly text: string;
}

/**
 * Every hand-written .ts/.tsx under src/ except src/test/: the code that
 * ships. Generated .d.ts files stay out - a declaration file states types
 * without implementing anything, so it can neither hold a creation call nor be
 * the home a pin names, while it could still carry the name and turn a
 * single-holder assertion into a two-file failure. `trees` narrows the scan to
 * top-level src/ trees (the problem-band pin walks only what the webview
 * bundle is built from); omitted, the walk covers all of src/.
 */
export function shippedSources(trees?: readonly string[]): ShippedSource[] {
	const srcDir = path.join(REPO_ROOT, "src");
	const testDir = path.join(srcDir, "test");
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (full !== testDir) {
					walk(full);
				}
			} else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
				files.push(full);
			}
		}
	};
	for (const dir of trees === undefined ? [srcDir] : trees.map((tree) => path.join(srcDir, tree))) {
		walk(dir);
	}
	return files.map((file) => ({
		file: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
		text: fs.readFileSync(file, "utf8"),
	}));
}

/** How many times `needle` occurs in `text`, as a plain substring. */
export function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}
