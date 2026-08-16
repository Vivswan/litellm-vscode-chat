/**
 * The installed Tailwind CLI's entry, resolved by path. `bun x @tailwindcss/cli` re-resolves against the npm
 * registry on every spawn, making each bundle and compiled-sheet spawn hostage to a registry blip. The exports map
 * exposes only the package.json, so resolve that and read the bin it declares; a missing devDependency throws.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export function tailwindCliBin(): string {
	// Anchored on the running entry script (always inside this repo for both consumers), not import.meta (the scripts
	// tsconfig type-checks this file under CommonJS output, which bans the meta-property) and not cwd (never an input).
	const packageJsonPath = Bun.resolveSync("@tailwindcss/cli/package.json", path.dirname(Bun.main));
	const declared: unknown = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bin?: { tailwindcss?: unknown } })
		.bin?.tailwindcss;
	if (typeof declared !== "string") {
		throw new Error(`@tailwindcss/cli declares no tailwindcss bin in ${packageJsonPath}`);
	}
	return path.join(path.dirname(packageJsonPath), declared);
}
