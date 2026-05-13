/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 5

declare module "vscode" {
	/**
	 * Additional options that can be passed when sending a chat request.
	 */
	export interface ProvideLanguageModelChatResponseOptions {
		/**
		 * What extension initiated the request to the language model, or
		 * `undefined` if the request was initiated by other functionality in the editor.
		 */
		readonly requestInitiator?: string;

		/**
		 * Per-model configuration provided by the user. This contains values configured
		 * in the user's language models configuration file, validated against the model's
		 * {@linkcode LanguageModelChatInformation.configurationSchema configurationSchema}.
		 */
		readonly modelConfiguration?: {
			readonly [key: string]: any;
		};
	}

	/**
	 * Additional properties for language model chat information.
	 */
	export interface LanguageModelChatInformation {
		/**
		 * Whether the model requires authorization before use.
		 */
		requiresAuthorization?: true | { label: string };

		/**
		 * A numeric value for comparing model cost tiers.
		 */
		readonly multiplierNumeric?: number;

		/**
		 * Whether or not this will be selected by default in the model picker
		 * NOT BEING FINALIZED
		 */
		readonly isDefault?: boolean | { [K in ChatLocation]?: boolean };

		/**
		 * Whether or not the model will show up in the model picker immediately upon being made known via {@linkcode LanguageModelChatProvider.provideLanguageModelChatInformation}.
		 * This allows extensions to register models but not have them immediately visible until ready.
		 * Defaults to false.
		 */
		readonly isUserSelectable?: boolean;

		/**
		 * The category for grouping this model in the model picker. Models are organized
		 * in the picker by category first, then by name within each category.
		 */
		readonly category?: { label: string; order: number };

		readonly statusIcon?: ThemeIcon;

		/**
		 * An optional JSON schema describing the configuration options for this model.
		 * When set, users can specify per-model configuration in their language models
		 * configuration file. The configured values are merged into the request options
		 * when sending chat requests to this model.
		 */
		readonly configurationSchema?: LanguageModelConfigurationSchema;

		/**
		 * When set, this model is only shown in the model picker for the specified chat session type.
		 * Models with this property are excluded from the general model picker and only appear
		 * when the user is in a session matching this type.
		 *
		 * The value must match a `type` declared in a `chatSessions` extension contribution.
		 */
		readonly targetChatSessionType?: string;
	}

	export interface LanguageModelChatCapabilities {
		/**
		 * Whether the model supports tool calling (function calling).
		 * When true or a number, the model can use tools in chat requests.
		 * When a number, it indicates the maximum number of tools supported per request.
		 */
		readonly toolCalling?: boolean | number;
	}

	/**
	 * Union type for all possible language model response parts.
	 */
	export type LanguageModelResponsePart2 =
		| LanguageModelTextPart
		| LanguageModelToolCallPart
		| LanguageModelToolResultPart
		| LanguageModelDataPart
		| LanguageModelThinkingPart;

	/**
	 * A [JSON Schema](https://json-schema.org) describing configuration options for a language model.
	 * Each property in `properties` defines a configurable option using standard JSON Schema fields
	 * plus additional display hints.
	 */
	export type LanguageModelConfigurationSchema = {
		readonly properties?: {
			readonly [key: string]: Record<string, any> & {
				/**
				 * Human-readable labels for enum values, shown instead of the raw values.
				 * Must have the same length and order as `enum`.
				 */
				readonly enumItemLabels?: string[];
				/**
				 * The group this property belongs to. When set to `'navigation'`, the property
				 * is shown as a primary action in the model picker.
				 */
				readonly group?: string;
			};
		};
	};

	export interface LanguageModelChatProvider<T extends LanguageModelChatInformation = LanguageModelChatInformation> {
		provideLanguageModelChatInformation(
			options: PrepareLanguageModelChatModelOptions,
			token: CancellationToken
		): ProviderResult<T[]>;
		provideLanguageModelChatResponse(
			model: T,
			messages: readonly LanguageModelChatRequestMessage[],
			options: ProvideLanguageModelChatResponseOptions,
			progress: Progress<LanguageModelResponsePart2>,
			token: CancellationToken
		): Thenable<void>;
	}

	/**
	 * The list of options passed into {@linkcode LanguageModelChatProvider.provideLanguageModelChatInformation}
	 */
	export interface PrepareLanguageModelChatModelOptions {
		/**
		 * Configuration for the model. This is only present if the provider has declared that it requires configuration via the `configuration` property.
		 * The object adheres to the schema that the extension provided during declaration.
		 */
		readonly configuration?: {
			readonly [key: string]: any;
		};
	}

	export interface ChatRequest {
		/**
		 * Per-model configuration provided by the user. Contains resolved values based on the model's
		 * {@linkcode LanguageModelChatInformation.configurationSchema configurationSchema},
		 * with user overrides applied on top of schema defaults.
		 *
		 * This is the same data that is sent as {@linkcode ProvideLanguageModelChatResponseOptions.configuration}
		 * when the model is invoked via the language model API.
		 */
		readonly modelConfiguration?: { readonly [key: string]: any };
	}
}
