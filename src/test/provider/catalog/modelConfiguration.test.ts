import * as assert from "node:assert";
import {
	DEFAULT_REASONING_EFFORT_LEVELS,
	effectiveReasoningLevels,
	reasoningEffortLevelsFromFlags,
	reasoningEffortPickerValues,
	reasoningEffortSchema,
	requestParamsFromModelConfiguration,
	supportsReasoningEffort,
} from "../../../provider/catalog/modelConfiguration";
import type { LiteLLMProvider } from "../../../provider/catalog/schemas";
import type { EffectiveCapabilityFields } from "../../../shared/config/capabilityResolution";
import { expectDefined } from "../../pureHelpers";

suite("provider/catalog/modelConfiguration", () => {
	suite("reasoning-effort schema", () => {
		const property = (levels: readonly string[] = DEFAULT_REASONING_EFFORT_LEVELS) =>
			expectDefined(reasoningEffortSchema(levels).properties?.reasoningEffort);

		test("the default list declares the sentinel plus every built-in level, max included", () => {
			assert.deepStrictEqual(property().enum, ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
			assert.deepStrictEqual(
				property().enumItemLabels,
				["Provider default", "Off", "Minimal", "Low", "Medium", "High", "Extra High", "Max"],
				"the host requires enumItemLabels to match the enum's length and order"
			);
			assert.strictEqual(
				(property().enumDescriptions as string[]).length,
				(property().enum as string[]).length,
				"enumDescriptions must align with the enum too"
			);
		});

		test("a resolved level list replaces the menu wholesale, in its own order", () => {
			assert.deepStrictEqual(property(["high", "low"]).enum, ["default", "high", "low"]);
		});

		test("unknown levels are offered verbatim with an aligned label and description", () => {
			const p = property(["low", "ultra"]);
			assert.deepStrictEqual(p.enum, ["default", "low", "ultra"]);
			assert.deepStrictEqual(p.enumItemLabels, ["Provider default", "Low", "ultra"]);
			assert.strictEqual((p.enumDescriptions as string[]).length, 3);
		});

		test("duplicate, empty, and sentinel-colliding levels sanitize away", () => {
			assert.deepStrictEqual(
				reasoningEffortPickerValues(["low", "low", "", "default", "high"]),
				["default", "low", "high"],
				'a level named "default" would alias the send-nothing sentinel, and "" cannot be a wire value'
			);
		});

		test("an empty level list leaves only the sentinel", () => {
			assert.deepStrictEqual(property([]).enum, ["default"]);
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

	suite("reasoningEffortLevelsFromFlags", () => {
		test("collects the true-flagged levels, known ones in menu order", () => {
			assert.deepStrictEqual(
				reasoningEffortLevelsFromFlags({
					supports_max_reasoning_effort: true,
					supports_low_reasoning_effort: true,
					supports_xhigh_reasoning_effort: true,
				}),
				["low", "xhigh", "max"]
			);
		});

		test("false and null flags read as unreported, not as a veto", () => {
			assert.deepStrictEqual(
				reasoningEffortLevelsFromFlags({
					supports_none_reasoning_effort: null,
					supports_minimal_reasoning_effort: false,
					supports_high_reasoning_effort: true,
				}),
				["high"]
			);
		});

		test("a report whose every flag is false or null carries no signal", () => {
			assert.strictEqual(
				reasoningEffortLevelsFromFlags({
					supports_low_reasoning_effort: false,
					supports_high_reasoning_effort: null,
				}),
				undefined,
				"an all-negative stamp must fall through to the built-in list, never an empty menu"
			);
		});

		test("unknown level names are the server's to define and append after the known ones", () => {
			assert.deepStrictEqual(
				reasoningEffortLevelsFromFlags({
					supports_ultra_reasoning_effort: true,
					supports_medium_reasoning_effort: true,
				}),
				["medium", "ultra"]
			);
		});

		test("non-flag keys and non-record sources contribute nothing", () => {
			assert.strictEqual(reasoningEffortLevelsFromFlags({ supports_reasoning: true, max_tokens: 5 }), undefined);
			assert.strictEqual(reasoningEffortLevelsFromFlags(undefined), undefined);
			assert.strictEqual(reasoningEffortLevelsFromFlags("supports_low_reasoning_effort"), undefined);
		});
	});

	suite("effectiveReasoningLevels", () => {
		const fieldsWith = (value: unknown): EffectiveCapabilityFields =>
			({ reasoning_effort_levels: { value, level: "server", shadowed: [] } }) as unknown as EffectiveCapabilityFields;

		test("reads the resolved list when one is carried", () => {
			assert.deepStrictEqual(effectiveReasoningLevels(fieldsWith(["low", "max"])), ["low", "max"]);
		});

		test("falls back to the built-in list when no level carries one", () => {
			assert.deepStrictEqual(
				effectiveReasoningLevels({} as unknown as EffectiveCapabilityFields),
				DEFAULT_REASONING_EFFORT_LEVELS
			);
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

		test("a flag-derived level list decides the menu, never the control's existence", () => {
			assert.strictEqual(
				supportsReasoningEffort(provider({ reasoning_effort_levels: ["low", "high"] })),
				false,
				"the gate stays the supports_reasoning/params-list judgment"
			);
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
			for (const level of DEFAULT_REASONING_EFFORT_LEVELS) {
				assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: level }), {
					reasoning_effort: level,
				});
			}
		});

		test("Off is a real wire value, distinct from the sentinel that sends nothing", () => {
			assert.deepStrictEqual(
				requestParamsFromModelConfiguration({ reasoningEffort: "none" }),
				{ reasoning_effort: "none" },
				"none must reach the wire so LiteLLM can translate it into thinking-off"
			);
		});

		test("an absent or empty configuration contributes nothing", () => {
			assert.deepStrictEqual(requestParamsFromModelConfiguration(undefined), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration({}), {});
		});

		test("the vocabulary is open: any stored string except the sentinel is user-set and goes out as-is", () => {
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: "ultra" }), {
				reasoning_effort: "ultra",
			});
		});

		test("non-string values and the empty string drop silently", () => {
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: 42 }), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: null }), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: ["high"] }), {});
			assert.deepStrictEqual(requestParamsFromModelConfiguration({ reasoningEffort: "" }), {});
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
