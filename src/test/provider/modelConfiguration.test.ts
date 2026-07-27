import * as assert from "node:assert";
import {
	REASONING_EFFORT_LEVELS,
	REASONING_EFFORT_SCHEMA,
	requestParamsFromModelConfiguration,
	supportsReasoningEffort,
} from "../../provider/modelConfiguration";
import type { LiteLLMProvider } from "../../provider/schemas";
import { expectDefined } from "../testUtils";

suite("provider/modelConfiguration", () => {
	suite("reasoning-effort schema", () => {
		const property = () => expectDefined(REASONING_EFFORT_SCHEMA.properties?.reasoningEffort);

		test("declares the sentinel plus the effort levels with aligned labels and descriptions", () => {
			assert.deepStrictEqual(property().enum, ["default", ...REASONING_EFFORT_LEVELS]);
			assert.deepStrictEqual(
				property().enumItemLabels,
				["Provider default", "Low", "Medium", "High"],
				"the host requires enumItemLabels to match the enum's length and order"
			);
			assert.strictEqual(
				(property().enumDescriptions as string[]).length,
				(property().enum as string[]).length,
				"enumDescriptions must align with the enum too"
			);
		});

		test("defaults to the sentinel, which the request path drops", () => {
			assert.strictEqual(
				property().default,
				"default",
				"the host can only unset a stored choice by re-selecting the schema default"
			);
			assert.deepStrictEqual(
				requestParamsFromModelConfiguration({ reasoningEffort: "default" }),
				{},
				"the sentinel must never reach the wire (pass-through invariant)"
			);
		});

		test("is promoted to a primary picker action", () => {
			assert.strictEqual(property().group, "navigation");
		});
	});

	suite("supportsReasoningEffort", () => {
		const provider = (fields: Partial<LiteLLMProvider>): LiteLLMProvider => ({
			provider: "test",
			status: "ok",
			...fields,
		});

		test("an explicit supports_reasoning: true counts", () => {
			assert.strictEqual(supportsReasoningEffort(provider({ supports_reasoning: true })), true);
		});

		test("reasoning_effort among supported_openai_params counts when the flag is unknown", () => {
			assert.strictEqual(
				supportsReasoningEffort(provider({ supported_openai_params: ["temperature", "reasoning_effort"] })),
				true
			);
			assert.strictEqual(
				supportsReasoningEffort(provider({ supports_reasoning: null, supported_openai_params: ["reasoning_effort"] })),
				true
			);
		});

		test("an explicit supports_reasoning: false vetoes the supported-params fallback", () => {
			assert.strictEqual(
				supportsReasoningEffort(provider({ supports_reasoning: false, supported_openai_params: ["reasoning_effort"] })),
				false,
				"a disclaimed capability must not be resurrected by the params list"
			);
		});

		test("no reasoning data means no support", () => {
			assert.strictEqual(supportsReasoningEffort(provider({})), false);
			assert.strictEqual(supportsReasoningEffort(provider({ supported_openai_params: ["temperature"] })), false);
		});

		test("a malformed pass-through params list is ignored", () => {
			assert.strictEqual(
				supportsReasoningEffort(provider({ supported_openai_params: "reasoning_effort" as unknown as string[] })),
				false
			);
		});
	});

	suite("requestParamsFromModelConfiguration", () => {
		test("maps reasoningEffort onto the reasoning_effort wire key", () => {
			for (const level of REASONING_EFFORT_LEVELS) {
				assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: level }), {
					reasoning_effort: level,
				});
			}
		});

		test("an absent or empty configuration contributes nothing", () => {
			assert.deepStrictEqual(requestParamsFromModelConfiguration(undefined), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration({}), {});
		});

		test("values outside the declared levels drop silently", () => {
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: "extreme" }), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: 42 }), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: null }), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: ["high"] }), {});
		});

		test("non-object configurations contribute nothing", () => {
			assert.deepStrictEqual(requestParamsFromModelConfiguration("high"), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration(3), {});
		});

		test("undeclared properties are never forwarded", () => {
			assert.deepStrictEqual(
				requestParamsFromModelConfiguration({ verbosity: "high", reasoningEffort: "low" }),
				{ reasoning_effort: "low" },
				"only schema-declared properties may reach the request body"
			);
		});
	});
});
