import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	DEFAULT_REASONING_EFFORT_LEVELS,
	effectiveReasoningLevels,
	reasoningEffortLevelsFromModelInfo,
	reasoningEffortPickerValues,
	reasoningEffortSchema,
	requestParamsFromModelConfiguration,
	supportsReasoningEffort,
} from "../../../../provider/catalog/modelConfiguration";
import type { LiteLLMProvider } from "../../../../provider/catalog/schemas";
import type { EffectiveCapabilityFields } from "../../../../shared/config/capabilityResolution";
import { expectDefined } from "../../../pureHelpers";

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

	describe("reasoningEffortLevelsFromModelInfo", () => {
		// Upstream LiteLLM's model_prices_and_context_window.json never flags low/medium/high as true: it stamps
		// supports_<level>_reasoning_effort only to add a tier above or below that baseline or to remove one with false
		// (#514). A report's true flags are therefore never the whole menu.
		const cases: ReadonlyArray<{ name: string; info: Record<string, unknown>; menu: string[] | undefined }> = [
			{
				name: "claude-opus-4-8: two tiers flagged above the baseline extend it",
				info: { supports_xhigh_reasoning_effort: true, supports_max_reasoning_effort: true },
				menu: ["low", "medium", "high", "xhigh", "max"],
			},
			{
				name: "claude-opus-4-6: one tier flagged above the baseline extends it",
				info: { supports_max_reasoning_effort: true },
				menu: ["low", "medium", "high", "max"],
			},
			{
				name: "gpt-5.4: a false flag on a non-baseline tier changes nothing, true flags add",
				info: {
					supports_none_reasoning_effort: true,
					supports_xhigh_reasoning_effort: true,
					supports_minimal_reasoning_effort: false,
				},
				menu: ["none", "low", "medium", "high", "xhigh"],
			},
			{
				name: "gpt-5.5-pro: a false flag on a baseline level removes it",
				info: {
					supports_none_reasoning_effort: false,
					supports_xhigh_reasoning_effort: true,
					supports_minimal_reasoning_effort: false,
					supports_low_reasoning_effort: false,
				},
				menu: ["medium", "high", "xhigh"],
			},
			{
				name: "a lone false flag on a tier outside the baseline is a report that yields the bare baseline",
				info: { supports_minimal_reasoning_effort: false },
				menu: ["low", "medium", "high"],
			},
			{
				name: "unknown level names are the server's to define and append after the known ones",
				info: { supports_ultra_reasoning_effort: true },
				menu: ["low", "medium", "high", "ultra"],
			},
			{
				name: "a report that removes the whole baseline leaves an empty menu, the server's explicit word",
				info: {
					supports_low_reasoning_effort: false,
					supports_medium_reasoning_effort: false,
					supports_high_reasoning_effort: false,
				},
				menu: [],
			},
			{
				name: "flags that are all null carry no signal",
				info: { supports_none_reasoning_effort: null, supports_high_reasoning_effort: null },
				menu: undefined,
			},
			{
				name: "a non-boolean flag value is ignored, not read as true",
				info: { supports_low_reasoning_effort: "yes" },
				menu: undefined,
			},
			{
				name: "non-flag keys carry no signal",
				info: { supports_reasoning: true, max_tokens: 5 },
				menu: undefined,
			},
			// 40 upstream entries carry an explicit reasoning_effort_levels list and no per-level flags at all.
			{
				name: "an explicit server list is the menu, in menu order",
				info: { reasoning_effort_levels: ["high", "none"] },
				menu: ["none", "high"],
			},
			{
				name: "an explicit server list wins over the flags beside it",
				info: { reasoning_effort_levels: ["high", "max"], supports_xhigh_reasoning_effort: true },
				menu: ["high", "max"],
			},
			{
				name: "an empty explicit list is no signal, so the flags decide",
				info: { reasoning_effort_levels: [], supports_xhigh_reasoning_effort: true },
				menu: ["low", "medium", "high", "xhigh"],
			},
			{
				name: "an explicit list with a non-string entry is no signal, so the flags decide",
				info: { reasoning_effort_levels: ["high", 5], supports_max_reasoning_effort: true },
				menu: ["low", "medium", "high", "max"],
			},
		];
		for (const { name, info, menu } of cases) {
			test(name, () => {
				assert.deepStrictEqual(reasoningEffortLevelsFromModelInfo(info), menu);
			});
		}

		test("non-record sources carry no signal", () => {
			assert.strictEqual(reasoningEffortLevelsFromModelInfo(undefined), undefined);
			assert.strictEqual(reasoningEffortLevelsFromModelInfo("supports_low_reasoning_effort"), undefined);
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
