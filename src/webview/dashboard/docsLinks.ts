/**
 * Every docs page the dashboard links out to, in one place. Literal string
 * constants only - no template interpolation, not even of other constants -
 * so a read of this file proves link targets never carry server data
 * (mirroring helpText.ts), and docsLinks.test.tsx enforces that at the
 * source level. The base is the repository URL from package.json; the test
 * also resolves every path and anchor against the docs/ folder, so a renamed
 * page or reworded heading fails CI instead of serving 404s.
 */

export const DOCS_LINK_SERVERS = "https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/servers.md";
export const DOCS_LINK_GETTING_STARTED =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/getting-started.md";
export const DOCS_LINK_SERVER_FORM =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/servers.md#entry-reference";
export const DOCS_LINK_MODELS = "https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/models.md";
export const DOCS_LINK_PARAMS_INSPECTOR =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/dashboard.md#effective-parameters";
export const DOCS_LINK_CAPS_INSPECTOR =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/dashboard.md#effective-capabilities";
export const DOCS_LINK_SETTINGS = "https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/settings.md";
export const DOCS_LINK_MODEL_PARAMETERS =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/models.md#parameters";
export const DOCS_LINK_MODEL_CAPABILITIES =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/models.md#capabilities";
export const DOCS_LINK_PARAMS_INACTIVE =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/troubleshooting.md#per-server-model-parameters-are-inactive";
export const DOCS_LINK_CHECK_BASE_URL =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/troubleshooting.md#the-server-did-not-recognize-this-request--answered-404---it-responded-but-does-not-serve-the-litellm-api";
export const DOCS_LINK_PROXY_NOT_RUNNING =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/troubleshooting.md#connection-error-unable-to-connect";
export const DOCS_LINK_CONFIGURE_API_KEY =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/troubleshooting.md#authentication-failed";
export const DOCS_LINK_OPENAI_COMPATIBLE =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/troubleshooting.md#pointing-at-ollama-vllm-or-plain-openai-compatible-servers";
export const DOCS_LINK_USAGE = "https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/usage.md";
export const DOCS_LINK_RESOLVED_MODELS =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/dashboard.md#resolved-models";
export const DOCS_LINK_MODEL_MATCHING =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/models.md#model-matching";
export const DOCS_LINK_DECLARED_MODELS =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/servers.md#declared-models";
export const DOCS_LINK_AUTHENTICATION =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/servers.md#authentication";
export const DOCS_LINK_OPENROUTER_CATALOG =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/models.md#the-openrouter-catalog";
export const DOCS_LINK_SETTINGS_MIGRATION =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/settings.md#renamed-and-removed-settings";

/** The only values a docs anchor may carry; DocsLink's href is typed to it. */
export type DocsUrl =
	| typeof DOCS_LINK_SERVERS
	| typeof DOCS_LINK_GETTING_STARTED
	| typeof DOCS_LINK_SERVER_FORM
	| typeof DOCS_LINK_MODELS
	| typeof DOCS_LINK_PARAMS_INSPECTOR
	| typeof DOCS_LINK_CAPS_INSPECTOR
	| typeof DOCS_LINK_SETTINGS
	| typeof DOCS_LINK_MODEL_PARAMETERS
	| typeof DOCS_LINK_MODEL_CAPABILITIES
	| typeof DOCS_LINK_PARAMS_INACTIVE
	| typeof DOCS_LINK_CHECK_BASE_URL
	| typeof DOCS_LINK_PROXY_NOT_RUNNING
	| typeof DOCS_LINK_CONFIGURE_API_KEY
	| typeof DOCS_LINK_OPENAI_COMPATIBLE
	| typeof DOCS_LINK_USAGE
	| typeof DOCS_LINK_RESOLVED_MODELS
	| typeof DOCS_LINK_MODEL_MATCHING
	| typeof DOCS_LINK_DECLARED_MODELS
	| typeof DOCS_LINK_AUTHENTICATION
	| typeof DOCS_LINK_OPENROUTER_CATALOG
	| typeof DOCS_LINK_SETTINGS_MIGRATION;
