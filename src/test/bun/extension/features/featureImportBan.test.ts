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
});
