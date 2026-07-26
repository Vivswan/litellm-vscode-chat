/**
 * Ambient augmentation of the "vscode" module with Language Model provider
 * API surface that exists at runtime for published extensions but is not in
 * the published @types/vscode typings (latest is 1.125). Every member below
 * is verified against the VS Code source: the extension host passes or reads
 * them without an API-proposal gate
 * (src/vs/workbench/api/common/extHostLanguageModels.ts; a reference checkout
 * lives at .worktrees/vscode).
 *
 * Declarations mirror vscode.proposed.chatProvider.d.ts character for
 * character so a future @types/vscode release merges as identical
 * declarations instead of silently diverging under skipLibCheck. Delete each
 * declaration (and this file, eventually) once a published @types/vscode
 * declares it.
 *
 * Do not add `capabilities.editTools` here: the host throws for extensions
 * that set it without the chatProvider proposal enabled.
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
