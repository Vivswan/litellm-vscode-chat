/**
 * The installed Tailwind CLI's entry, resolved by path. `bun x
 * @tailwindcss/cli` re-resolves the package against the npm registry on every
 * spawn, which made each CI bundle - and all twenty compiled-sheet test
 * spawns - hostage to a registry blip (an ETIMEDOUT there failed a green
 * tree). The package's exports map exposes only its package.json, so resolve
 * that and read the bin it declares; a missing devDependency throws out of
 * resolveSync, loudly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export function tailwindCliBin(): string {
	// Anchored on the running entry script (always inside this repo for both
	// consumers), not import.meta (the scripts tsconfig type-checks this file
	// under CommonJS output, which bans the meta-property) and not cwd (never
	// an input).
	const packageJsonPath = Bun.resolveSync("@tailwindcss/cli/package.json", path.dirname(Bun.main));
	const declared: unknown = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bin?: { tailwindcss?: unknown } })
		.bin?.tailwindcss;
	if (typeof declared !== "string") {
		throw new Error(`@tailwindcss/cli declares no tailwindcss bin in ${packageJsonPath}`);
	}
	return path.join(path.dirname(packageJsonPath), declared);
}
