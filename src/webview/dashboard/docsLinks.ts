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
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/servers.md#entry-fields";
export const DOCS_LINK_MODELS = "https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/models.md";
export const DOCS_LINK_PARAMS_INSPECTOR =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/dashboard.md#effective-parameters";
export const DOCS_LINK_SETTINGS = "https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/settings.md";
export const DOCS_LINK_MODEL_PARAMETERS =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/model-parameters.md";
export const DOCS_LINK_PARAMS_INACTIVE =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/troubleshooting.md#per-server-model-parameters-are-inactive";

/** The only values a docs anchor may carry; DocsLink's href is typed to it. */
export type DocsUrl =
	| typeof DOCS_LINK_SERVERS
	| typeof DOCS_LINK_GETTING_STARTED
	| typeof DOCS_LINK_SERVER_FORM
	| typeof DOCS_LINK_MODELS
	| typeof DOCS_LINK_PARAMS_INSPECTOR
	| typeof DOCS_LINK_SETTINGS
	| typeof DOCS_LINK_MODEL_PARAMETERS
	| typeof DOCS_LINK_PARAMS_INACTIVE;
