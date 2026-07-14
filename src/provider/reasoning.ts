import type { LanguageModelChatInformation, ProvideLanguageModelChatResponseOptions } from "vscode";
import type { LiteLLMProvider } from "../types";

export const REASONING_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

interface LanguageModelConfigurationProperty {
	type: "string";
	title: string;
	enum: readonly ReasoningEffort[];
	enumItemLabels: readonly string[];
	enumDescriptions: readonly string[];
	default: ReasoningEffort;
	group: "navigation";
}

interface ConfigurableLanguageModelChatInformation extends LanguageModelChatInformation {
	readonly configurationSchema?: {
		readonly properties: {
			readonly reasoningEffort: LanguageModelConfigurationProperty;
		};
	};
}

interface ConfigurableChatResponseOptions extends ProvideLanguageModelChatResponseOptions {
	readonly modelConfiguration?: {
		readonly reasoningEffort?: unknown;
	};
}

const reasoningEffortSchema: ConfigurableLanguageModelChatInformation["configurationSchema"] = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Thinking Effort",
			enum: REASONING_EFFORTS,
			enumItemLabels: ["Default", "None", "Minimal", "Low", "Medium", "High", "Extra High"],
			enumDescriptions: [
				"Use modelParameters when configured, otherwise use the model or provider default.",
				"Disable reasoning.",
				"Use no more reasoning than necessary.",
				"Use low reasoning effort.",
				"Use medium reasoning effort.",
				"Use high reasoning effort.",
				"Use extra-high reasoning effort.",
			],
			default: "default",
			group: "navigation",
		},
	},
};

export function supportsReasoningEffort(provider: LiteLLMProvider): boolean {
	return (
		provider.supports_reasoning === true || provider.supported_openai_params?.includes("reasoning_effort") === true
	);
}

export function withReasoningEffortConfiguration(
	info: LanguageModelChatInformation,
	supported: boolean
): LanguageModelChatInformation {
	if (!supported) {
		return info;
	}
	return {
		...info,
		configurationSchema: reasoningEffortSchema,
	} as ConfigurableLanguageModelChatInformation;
}

export function applyReasoningEffortConfiguration(
	modelParameters: Record<string, unknown>,
	options: ProvideLanguageModelChatResponseOptions
): Record<string, unknown> {
	const value = (options as ConfigurableChatResponseOptions).modelConfiguration?.reasoningEffort;
	if (value === "default" || !REASONING_EFFORTS.includes(value as ReasoningEffort)) {
		return modelParameters;
	}
	return {
		...modelParameters,
		reasoning_effort: value,
	};
}
