import { describe, test } from "bun:test";
import * as assert from "node:assert";
import { reportedReasoningLevels } from "../../../../provider/catalog/modelCatalog";
import type { LiteLLMProvider } from "../../../../provider/catalog/schemas";

describe("provider/catalog/modelCatalog", () => {
	describe("reportedReasoningLevels", () => {
		const provider = (levels: string[] | null): LiteLLMProvider => ({
			provider: "openai",
			status: "ok",
			supports_tools: true,
			reasoning_effort_levels: levels,
		});

		// Two deployments of one model, as /model/info reports them; null is a deployment with no true level flag.
		const cases: { name: string; reported: (string[] | null)[]; expected: string[] | undefined }[] = [
			{ name: "one deployment reporting", reported: [["low"], null], expected: ["low"] },
			{ name: "both the same", reported: [["low"], ["low"]], expected: ["low"] },
			{ name: "disjoint, listed high first", reported: [["high"], ["low"]], expected: ["low", "high"] },
			{
				name: "overlapping",
				reported: [
					["low", "high", "max"],
					["low", "xhigh", "max"],
				],
				expected: ["low", "high", "xhigh", "max"],
			},
			{ name: "none", reported: [null, null], expected: undefined },
			{ name: "an unknown level trails the known ones", reported: [["ultra"], ["low"]], expected: ["low", "ultra"] },
		];
		for (const { name, reported, expected } of cases) {
			test(name, () => {
				assert.deepStrictEqual(reportedReasoningLevels(reported.map(provider)), expected);
			});
		}
	});
});
