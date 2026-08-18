/**
 * The shipped-source scanner behind the source-shape pins: suites that pin an
 * API or idiom to one file (singleton creation points, the profile-path walk)
 * share this walk, so the pins cannot drift on what "shipped source" means.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Repo root from the compiled helper's location (out/test -> repo). */
function repoRoot(): string {
	return path.resolve(__dirname, "..", "..");
}

export interface ShippedSource {
	/** Repo-relative path. */
	readonly file: string;
	readonly text: string;
}

/** Every .ts/.tsx under src/ except src/test/: the code that ships. */
export function shippedSources(): ShippedSource[] {
	const root = repoRoot();
	const testDir = path.join(root, "src", "test");
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (full !== testDir) {
					walk(full);
				}
			} else if (/\.(ts|tsx)$/.test(entry.name)) {
				files.push(full);
			}
		}
	};
	walk(path.join(root, "src"));
	return files.map((file) => ({ file: path.relative(root, file), text: fs.readFileSync(file, "utf8") }));
}

/** How many times `needle` occurs in `text`, as a plain substring. */
export function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}
