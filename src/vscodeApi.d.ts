/**
 * Ambient augmentation of the "vscode" module with Language Model provider
 * API surface that exists at runtime for published extensions but is not in
 * the published @types/vscode typings (latest is 1.125). Every member below
 * was verified against the VS Code sources when it was added: the extension
 * host passes or reads them without an API-proposal gate
 * (src/vs/workbench/api/common/extHostLanguageModels.ts in the
 * microsoft/vscode repository).
 *
 * Declarations mirror their vscode.proposed.*.d.ts sources (chatProvider,
 * languageModelPricing) character for character so a future @types/vscode
 * release merges as identical declarations instead of silently diverging
 * under skipLibCheck. Delete each declaration (and this file, eventually)
 * once a published @types/vscode declares it.
 *
 * Do not add `capabilities.editTools` here: the host throws for extensions
 * that set it without the chatProvider proposal enabled. `priceCategory`,
 * `statusIcon`, and `warningText` are verified: the host copies them with no
 * proposal check in extHostLanguageModels.ts's $provideLanguageModelChatInfo
 * mapping and renders them vendor-agnostically (the model picker hover's
 * cost badge and warning banner in modelPickerHover.ts, the row icon and
 * ariaDescription in modelPickerItemPrimitives.ts). The pricing fields are
 * mirrored on the consumer-side LanguageModelChat too: the host copies them
 * onto the API object it hands selectChatModels() callers, equally ungated.
 * languageModelPricing's
 * `category` stays excluded deliberately: it renders fine (a hover tag), but
 * LiteLLM's model data cannot honestly populate a capability tier, so do not
 * add it.
 *
 * Watched APIs, currently out of reach (re-check when their gates move):
 * - capabilities.editTools: hard-gated, the host throws (see above) - a
 *   permanent exclusion for a Marketplace build.
 * - chatInputNotification / chatStatusItem: proposal-gated surfaces.
 * - Third-party prompt-cache breakpoints: the host hardcodes the vendor set
 *   (microsoft/vscode#313920).
 * - stateful_marker / context_management data parts: consumed ungated, but
 *   they carry Responses/Messages-style server state that the pinned
 *   /chat/completions transport cannot produce.
 */
declare module "vscode" {
	/**
	 * A JSON Schema describing configuration options for a language model.
	 * Enum properties render as submenu actions in the model picker's
	 * Configure Model menu; the host persists the user's choices and resolves
	 * them (schema defaults with user overrides on top) into
	 * `modelConfiguration` on every request.
	 */
	export type LanguageModelConfigurationSchema = {
		readonly properties?: {
			// biome-ignore lint/suspicious/noExplicitAny: mirrors the upstream declaration exactly
			readonly [key: string]: Record<string, any> & {
				/** Display labels for enum values; must match the enum's length and order. */
				readonly enumItemLabels?: string[];
				/** "navigation" promotes the property to a primary action in the picker. */
				readonly group?: string;
			};
		};
	};

	export interface LanguageModelChatInformation {
		/** Marks the model as served with user-supplied credentials (bring your own key). */
		readonly isBYOK?: boolean;
		/** Whether the model appears in the chat model picker; the host treats absent as selectable. */
		readonly isUserSelectable?: boolean;
		/** Per-model settings surfaced in the model picker; see LanguageModelConfigurationSchema. */
		readonly configurationSchema?: LanguageModelConfigurationSchema;

		/**
		 * Optional pricing label for this model, such as "Free", "$0.01/request", etc.
		 * This value is meant for display purposes and will be shown in the model management UI.
		 */
		readonly pricing?: string;

		/**
		 * Optional input cost in AI credits for this model.
		 * Displayed in the model management UI as the cost per million input tokens.
		 */
		readonly inputCost?: number;

		/**
		 * Optional output cost in AI credits for this model.
		 * Displayed in the model management UI as the cost per million output tokens.
		 */
		readonly outputCost?: number;

		/**
		 * Optional cache cost in AI credits for this model.
		 * Displayed in the model management UI as the cost per million cached tokens.
		 */
		readonly cacheCost?: number;

		/**
		 * Optional cache write cost in AI credits for this model.
		 * Displayed in the model management UI as the cost per million cache-write tokens.
		 */
		readonly cacheWriteCost?: number;

		/**
		 * Optional long-context input cost in AI credits for this model.
		 * Present only when long-context pricing differs from default pricing.
		 * Displayed in the model picker hover as the cost per million input tokens
		 * when the prompt exceeds the default context window.
		 */
		readonly longContextInputCost?: number;

		/**
		 * Optional long-context output cost in AI credits for this model.
		 * Present only when long-context pricing differs from default pricing.
		 */
		readonly longContextOutputCost?: number;

		/**
		 * Optional long-context cache cost in AI credits for this model.
		 * Present only when long-context pricing differs from default pricing.
		 */
		readonly longContextCacheCost?: number;

		/**
		 * Optional long-context cache write cost in AI credits for this model.
		 * Present only when long-context pricing differs from default pricing.
		 */
		readonly longContextCacheWriteCost?: number;

		/**
		 * Optional relative pricing category for this model (e.g. "low", "medium", "high", "very_high").
		 * Displayed in the model picker as a visual indicator of relative cost.
		 */
		readonly priceCategory?: string;

		readonly statusIcon?: ThemeIcon;

		/**
		 * Optional warning text to display in the model picker hover as a warning banner.
		 * The keys are warning categories (e.g. "data_retention") and the values are markdown strings.
		 * Unlike degradation warnings, this does not produce a warning icon in the picker list.
		 */
		readonly warningText?: Record<string, string>;
	}

	export interface LanguageModelChat {
		/**
		 * Optional pricing label for this model, such as "Free", "$0.01/request", etc.
		 * This value is provided by the model provider and is meant for display purposes only.
		 */
		readonly pricing?: string;

		/**
		 * Optional input cost in AI credits for this model.
		 */
		readonly inputCost?: number;

		/**
		 * Optional output cost in AI credits for this model.
		 */
		readonly outputCost?: number;

		/**
		 * Optional cache cost in AI credits for this model.
		 */
		readonly cacheCost?: number;

		/**
		 * Optional cache write cost in AI credits for this model.
		 */
		readonly cacheWriteCost?: number;

		/**
		 * Optional long-context input cost in AI credits for this model.
		 * Present only when long-context pricing differs from default pricing.
		 */
		readonly longContextInputCost?: number;

		/**
		 * Optional long-context output cost in AI credits for this model.
		 * Present only when long-context pricing differs from default pricing.
		 */
		readonly longContextOutputCost?: number;

		/**
		 * Optional long-context cache cost in AI credits for this model.
		 * Present only when long-context pricing differs from default pricing.
		 */
		readonly longContextCacheCost?: number;

		/**
		 * Optional long-context cache write cost in AI credits for this model.
		 * Present only when long-context pricing differs from default pricing.
		 */
		readonly longContextCacheWriteCost?: number;

		/**
		 * Optional relative pricing category for this model (e.g. "low", "medium", "high", "very_high").
		 * Displayed in the model picker as a visual indicator of relative cost.
		 */
		readonly priceCategory?: string;
	}

	export interface PrepareLanguageModelChatModelOptions {
		/** The provider group's configuration, passed by the host on per-group refreshes. */
		readonly configuration?: {
			// biome-ignore lint/suspicious/noExplicitAny: mirrors the upstream declaration exactly
			readonly [key: string]: any;
		};
	}

	export interface ProvideLanguageModelChatResponseOptions {
		/** Identifier of the extension that initiated the request, or "core" for the editor itself. */
		readonly requestInitiator: string;
		/** Resolved per-model configuration values (configurationSchema defaults plus user choices). */
		readonly modelConfiguration?: {
			// biome-ignore lint/suspicious/noExplicitAny: mirrors the upstream declaration exactly
			readonly [key: string]: any;
		};
	}
}
