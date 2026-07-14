import * as assert from "assert";
import * as vscode from "vscode";
import { buildModelInfos } from "../../provider/registration";
import {
	applyReasoningEffortConfiguration,
	supportsReasoningEffort,
	withReasoningEffortConfiguration,
} from "../../provider/reasoning";
import type { LiteLLMModelItem, LiteLLMProvider } from "../../types";

interface ConfigurableModelInfo extends vscode.LanguageModelChatInformation {
	configurationSchema?: {
		properties?: {
			reasoningEffort?: {
				enum?: readonly string[];
				default?: string;
				group?: string;
			};
		};
	};
}

suite("provider/reasoning", () => {
	const modelInfo: vscode.LanguageModelChatInformation = {
		id: "reasoning-model",
		name: "reasoning-model",
		family: "litellm",
		version: "1.0.0",
		maxInputTokens: 1000,
		maxOutputTokens: 1000,
		capabilities: {},
	};

	test("detects reasoning effort from either capability field", () => {
		const base = { provider: "test", status: "ok" } satisfies LiteLLMProvider;
		assert.equal(supportsReasoningEffort({ ...base, supports_reasoning: true }), true);
		assert.equal(supportsReasoningEffort({ ...base, supported_openai_params: ["reasoning_effort"] }), true);
		assert.equal(supportsReasoningEffort({ ...base, supports_reasoning: false }), false);
	});

	test("adds the navigation configuration schema only to supported models", () => {
		const supported = withReasoningEffortConfiguration(modelInfo, true) as ConfigurableModelInfo;
		const unsupported = withReasoningEffortConfiguration(modelInfo, false) as ConfigurableModelInfo;
		const property = supported.configurationSchema?.properties?.reasoningEffort;

		assert.equal(property?.group, "navigation");
		assert.equal(property?.default, "default");
		assert.deepEqual(property?.enum, ["default", "none", "minimal", "low", "medium", "high", "xhigh"]);
		assert.equal(unsupported.configurationSchema, undefined);
	});

	test("applies a valid picker value over model parameters", () => {
		const params = applyReasoningEffortConfiguration({ reasoning_effort: "low", temperature: 0.5 }, {
			toolMode: vscode.LanguageModelChatToolMode.Auto,
			modelConfiguration: { reasoningEffort: "high" },
		} as vscode.ProvideLanguageModelChatResponseOptions);

		assert.deepEqual(params, { reasoning_effort: "high", temperature: 0.5 });
	});

	test("keeps model parameters for default or invalid picker values", () => {
		const configured = { reasoning_effort: "low" };
		const withDefault = applyReasoningEffortConfiguration(configured, {
			toolMode: vscode.LanguageModelChatToolMode.Auto,
			modelConfiguration: { reasoningEffort: "default" },
		} as vscode.ProvideLanguageModelChatResponseOptions);
		const withInvalid = applyReasoningEffortConfiguration(configured, {
			toolMode: vscode.LanguageModelChatToolMode.Auto,
			modelConfiguration: { reasoningEffort: "turbo" },
		} as vscode.ProvideLanguageModelChatResponseOptions);

		assert.deepEqual(withDefault, configured);
		assert.deepEqual(withInvalid, configured);
	});

	test("shows the picker only when every provider behind aggregate routes supports it", () => {
		const models: LiteLLMModelItem[] = [
			{
				id: "mixed-model",
				object: "model",
				created: 0,
				owned_by: "test",
				providers: [
					{ provider: "reasoning", status: "ok", supports_tools: true, supports_reasoning: true },
					{ provider: "standard", status: "ok", supports_tools: true, supports_reasoning: false },
				],
			},
		];
		const result = buildModelInfos(
			models,
			{ id: "server", label: "Server", baseUrl: "http://test", apiKey: "key" },
			1,
			() => {}
		);
		const byId = new Map(result.infos.map((info) => [info.id, info as ConfigurableModelInfo]));

		assert.ok(byId.get("mixed-model:reasoning")?.configurationSchema);
		assert.equal(byId.get("mixed-model:standard")?.configurationSchema, undefined);
		assert.equal(byId.get("mixed-model:cheapest")?.configurationSchema, undefined);
		assert.equal(byId.get("mixed-model:fastest")?.configurationSchema, undefined);
	});
});
