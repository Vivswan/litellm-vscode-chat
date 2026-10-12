import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { inferLazyL10nNames, type SourceFile } from "../../../../../scripts/l10n/lib";
import { LAZY_INFERENCE_FIXTURES } from "./lazyInferenceFixture";

function declaredElsewhere(name: string): SourceFile {
	return { file: `${name}.ts`, contents: `export function ${name}(): string {\n\treturn l10n.t("x");\n}\n` };
}

/**
 * Each fixture's lazy set is exact, so a walk that stops seeing a shape fails here instead of silently narrowing what
 * the module-scope guard matches: over the repository, a narrower inference only makes the gate quieter.
 */
describe("l10n lazy-helper inference per fixture", () => {
	for (const fixture of LAZY_INFERENCE_FIXTURES) {
		test(fixture.name, () => {
			const elsewhere = fixture.lazyElsewhere ?? [];
			const sources = [...fixture.sources, ...elsewhere.map(declaredElsewhere)];
			const found = [...inferLazyL10nNames(sources).keys()].sort();
			assert.deepStrictEqual(found, [...fixture.expected, ...elsewhere].sort());
		});
	}
});
