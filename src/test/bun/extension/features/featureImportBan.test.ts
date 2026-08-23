/**
 * The fail-closed guard on the cross-feature import ban: features may not
 * import each other, and the ban must not fail OPEN when the next feature
 * directory lands. Biome's noRestrictedImports matches import SPECIFIERS, so a
 * generic features-wide override cannot except "the importing file's own
 * tree"; the ban is per-feature by necessity. What must not be per-feature is
 * REMEMBERING it: this guard derives the required overrides from the directory
 * listing itself, so a new feature directory fails here until its own ban
 * names every sibling and every existing ban names it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../util/repoRoot";

interface BiomeOverride {
	readonly includes?: readonly string[];
	readonly linter?: {
		readonly rules?: {
			readonly style?: {
				readonly noRestrictedImports?: {
					readonly level?: string;
					readonly options?: { readonly patterns?: readonly { readonly group?: readonly string[] }[] };
				};
			};
		};
	};
}

describe("extension/features cross-feature import ban", () => {
	test("every feature directory carries a biome override banning every sibling", () => {
		const featuresDir = path.join(REPO_ROOT, "src", "extension", "features");
		const features = readdirSync(featuresDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(features.length).toBeGreaterThan(1);
		const biome = JSON.parse(readFileSync(path.join(REPO_ROOT, "biome.json"), "utf8")) as {
			overrides?: readonly BiomeOverride[];
		};
		const overrides = biome.overrides ?? [];
		for (const feature of features) {
			const override = overrides.find(
				(candidate) =>
					candidate.includes?.length === 1 && candidate.includes[0] === `src/extension/features/${feature}/**`
			);
			expect(override, `biome.json has no override for src/extension/features/${feature}/**`).toBeDefined();
			// The right groups under a disabled rule ban nothing: the level is part
			// of the guard, not an assumption.
			expect(
				override?.linter?.rules?.style?.noRestrictedImports?.level,
				`${feature}'s override must enforce at level "error"`
			).toBe("error");
			const groups = (override?.linter?.rules?.style?.noRestrictedImports?.options?.patterns ?? []).flatMap(
				(pattern) => pattern.group ?? []
			);
			for (const sibling of features) {
				if (sibling === feature) {
					// A ban naming the feature's OWN directory would break its
					// internal imports; the guard refuses that misconfiguration too.
					expect(groups, `${feature}'s override bans its own tree`).not.toContain(`**/${sibling}/**`);
					continue;
				}
				expect(groups, `${feature}'s override does not ban imports from ${sibling}`).toContain(`**/${sibling}/**`);
			}
		}
	});

	test("exactly one features/-root file bridges into a feature directory", () => {
		// The features/ root sits outside every per-feature biome override, so a
		// root file CAN import from a feature tree - which is how the one
		// declared cross-feature bridge (quickFixChatCommands.ts, teaching the
		// participant /fix and /explain) works at all. That reachability must
		// not become a habit: everything else outside features/<feature>/
		// reaches a feature only through its wiring module, so a second bridge
		// fails here until it is a deliberate, named decision.
		const featuresDir = path.join(REPO_ROOT, "src", "extension", "features");
		const entries = readdirSync(featuresDir, { withFileTypes: true });
		const featureDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		const rootFiles = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
			.map((entry) => entry.name)
			.sort();
		expect(rootFiles.length).toBeGreaterThan(1);
		const importsFeatureDir = (file: string): boolean => {
			const source = readFileSync(path.join(featuresDir, file), "utf8");
			return featureDirs.some((dir) => new RegExp(`from\\s+"\\./${dir}/`).test(source));
		};
		const bridges = rootFiles.filter(importsFeatureDir);
		expect(bridges).toEqual(["quickFixChatCommands.ts"]);
	});

	test("outside the features tree, only a feature's wiring module is imported from its directory", () => {
		// The documented convention: everything outside features/<feature>/
		// reaches a feature only through its wiring module. Biome cannot express
		// this (the per-feature overrides govern the feature trees themselves),
		// so this leg walks every shipped source file outside the features tree
		// and fails on any import reaching features/<dir>/<module> where the
		// module is not the wiring seam.
		const srcDir = path.join(REPO_ROOT, "src");
		const featuresDir = path.join(srcDir, "extension", "features");
		const featureDirs = readdirSync(featuresDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					return full === featuresDir || full.startsWith(path.join(srcDir, "test")) ? [] : walk(full);
				}
				return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
			});
		const deepImport = new RegExp(`from\\s+"[^"]*/features/(${featureDirs.join("|")})/(?!wiring")[^"]+"`);
		const offenders = walk(srcDir).filter((file) => deepImport.test(readFileSync(file, "utf8")));
		expect(offenders.map((file) => path.relative(REPO_ROOT, file))).toEqual([]);
	});
});
