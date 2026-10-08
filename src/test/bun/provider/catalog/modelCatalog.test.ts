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

		// Two deployments of one model, as /model/info reports them; null is a deployment LiteLLM's rule resolves to unknown.
		// The merge mirrors the proxy's own: one unknown deployment leaves the group unknown, otherwise the intersection.
		const cases: { name: string; reported: (string[] | null)[]; expected: string[] | undefined }[] = [
			{ name: "one deployment unknown leaves the group unknown", reported: [["low"], null], expected: undefined },
			{ name: "both the same", reported: [["low"], ["low"]], expected: ["low"] },
			{ name: "disjoint deployments intersect to an empty menu", reported: [["high"], ["low"]], expected: [] },
			{
				name: "overlapping, in menu order",
				reported: [
					["low", "high", "max"],
					["max", "xhigh", "low"],
				],
				expected: ["low", "max"],
			},
			{ name: "every deployment unknown", reported: [null, null], expected: undefined },
			{
				name: "a level outside the built-in vocabulary survives when every deployment carries it",
				reported: [
					["ultra", "low"],
					["low", "ultra"],
				],
				expected: ["low", "ultra"],
			},
		];
		for (const { name, reported, expected } of cases) {
			test(name, () => {
				assert.deepStrictEqual(reportedReasoningLevels(reported.map(provider)), expected);
			});
		}
	});
});
