import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	DEFAULT_REASONING_EFFORT_LEVELS,
	effectiveReasoningLevels,
	intersectSupportedReasoningEfforts,
	reasoningEffortPickerValues,
	reasoningEffortSchema,
	requestParamsFromModelConfiguration,
	resolveSupportedReasoningEfforts,
	supportsReasoningEffort,
} from "../../../../provider/catalog/modelConfiguration";
import type { LiteLLMProvider } from "../../../../provider/catalog/schemas";
import type { EffectiveCapabilityFields } from "../../../../shared/config/capabilityResolution";
import { expectDefined } from "../../../pureHelpers";
import { INTERSECT_CASES, RESOLVE_CASES } from "./litellmReasoningEffortCases";

describe("provider/catalog/modelConfiguration", () => {
	describe("reasoning-effort schema", () => {
		const property = (levels: readonly string[] = DEFAULT_REASONING_EFFORT_LEVELS) =>
			expectDefined(reasoningEffortSchema(levels).properties?.reasoningEffort);

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

	describe("resolveSupportedReasoningEfforts", () => {
		// LiteLLM's resolver is the source of truth for what a deployment's flags mean (#514); the vectors are its own
		// unit tests, so a divergence here is a bug in the mirror.
		for (const { name, modelInfo, deploymentIsMapped, expected } of RESOLVE_CASES) {
			test(`LiteLLM conformance: ${name}`, () => {
				assert.deepStrictEqual(resolveSupportedReasoningEfforts(modelInfo, { deploymentIsMapped }), expected);
			});
		}

		// The reporter's four models as upstream's price map describes them today, with LiteLLM's answers.
		const reported: ReadonlyArray<{ name: string; info: Record<string, unknown>; menu: string[] | undefined }> = [
			{
				name: "claude-opus-4-8",
				info: { supports_reasoning: true, supports_xhigh_reasoning_effort: true, supports_max_reasoning_effort: true },
				menu: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
			},
			{
				name: "claude-opus-4-6",
				info: { supports_reasoning: true, supports_max_reasoning_effort: true },
				menu: ["none", "minimal", "low", "medium", "high", "max"],
			},
			{
				name: "gpt-5.4",
				info: {
					supports_reasoning: true,
					supports_none_reasoning_effort: true,
					supports_xhigh_reasoning_effort: true,
					supports_minimal_reasoning_effort: false,
				},
				menu: ["none", "low", "medium", "high", "xhigh"],
			},
			{
				name: "gpt-5.5-pro",
				info: {
					supports_reasoning: true,
					supports_none_reasoning_effort: false,
					supports_xhigh_reasoning_effort: true,
					supports_minimal_reasoning_effort: false,
					supports_low_reasoning_effort: false,
				},
				menu: ["medium", "high", "xhigh"],
			},
			{
				name: "an azure deployment spelled gpt5_series is the gpt-5 family too, so none needs an explicit true",
				info: {
					supports_reasoning: true,
					litellm_provider: "azure",
					key: "azure/my-gpt5_series-deploy",
					supports_minimal_reasoning_effort: true,
				},
				menu: ["minimal", "low", "medium", "high"],
			},
			{
				name: "an azure gpt-5-chat deployment is outside the gpt-5 family, so none stays opt-out",
				info: {
					supports_reasoning: true,
					litellm_provider: "azure",
					key: "azure/gpt-5-chat-latest",
					supports_max_reasoning_effort: true,
				},
				menu: ["none", "minimal", "low", "medium", "high", "max"],
			},
		];
		for (const { name, info, menu } of reported) {
			test(`the wire shape of ${name}`, () => {
				assert.deepStrictEqual(resolveSupportedReasoningEfforts(info, { deploymentIsMapped: false }), menu);
			});
		}

		test("non-record sources resolve to unknown", () => {
			assert.strictEqual(resolveSupportedReasoningEfforts(undefined, { deploymentIsMapped: false }), undefined);
			assert.strictEqual(
				resolveSupportedReasoningEfforts("supports_reasoning", { deploymentIsMapped: true }),
				undefined
			);
		});
	});

	describe("intersectSupportedReasoningEfforts", () => {
		for (const { name, current, resolved, expected } of INTERSECT_CASES) {
			test(`LiteLLM conformance: ${name}`, () => {
				assert.deepStrictEqual(intersectSupportedReasoningEfforts(current, resolved), expected);
			});
		}

		test("a level outside the built-in vocabulary survives the intersection when both sides carry it", () => {
			assert.deepStrictEqual(intersectSupportedReasoningEfforts(["ultra", "low"], ["low", "ultra"]), ["low", "ultra"]);
		});
	});

	describe("effectiveReasoningLevels", () => {
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

	describe("supportsReasoningEffort", () => {
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

	describe("requestParamsFromModelConfiguration", () => {
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
