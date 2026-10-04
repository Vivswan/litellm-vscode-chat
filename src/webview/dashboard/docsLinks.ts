/**
 * Every docs page the dashboard links out to. Literal string constants only - no interpolation, even of other
 * constants - so a read of this file proves link targets never carry server data. The one outside source DocsUrl
 * admits is the host's setup-hint record in shared/util/links.ts, whose values are literals in a module that
 * imports nothing but a type. docsLinks.test.tsx resolves every path and anchor against docs/, so a renamed page
 * fails CI instead of serving 404s.
 */

import type { SETUP_HINT_DOCS_URLS } from "../../shared/util/links";

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
export const DOCS_LINK_DASHBOARD_FEATURES =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/dashboard.md#features";
export const DOCS_LINK_MODEL_PARAMETERS =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/models.md#parameters";
export const DOCS_LINK_MODEL_CAPABILITIES =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/models.md#capabilities";
export const DOCS_LINK_PARAMS_INACTIVE =
	"https://github.com/Vivswan/litellm-vscode-chat/blob/main/docs/troubleshooting.md#per-server-model-parameters-are-inactive";
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

/**
 * The only values a docs anchor may carry; DocsLink's href is typed to it. The setup-hint headings join by
 * reading the host's record, so a hint re-pointed there re-points the dashboard with it.
 */
export type DocsUrl =
	| (typeof SETUP_HINT_DOCS_URLS)[keyof typeof SETUP_HINT_DOCS_URLS]
	| typeof DOCS_LINK_SERVERS
	| typeof DOCS_LINK_GETTING_STARTED
	| typeof DOCS_LINK_SERVER_FORM
	| typeof DOCS_LINK_MODELS
	| typeof DOCS_LINK_PARAMS_INSPECTOR
	| typeof DOCS_LINK_CAPS_INSPECTOR
	| typeof DOCS_LINK_SETTINGS
	| typeof DOCS_LINK_DASHBOARD_FEATURES
	| typeof DOCS_LINK_MODEL_PARAMETERS
	| typeof DOCS_LINK_MODEL_CAPABILITIES
	| typeof DOCS_LINK_PARAMS_INACTIVE
	| typeof DOCS_LINK_OPENAI_COMPATIBLE
	| typeof DOCS_LINK_USAGE
	| typeof DOCS_LINK_RESOLVED_MODELS
	| typeof DOCS_LINK_MODEL_MATCHING
	| typeof DOCS_LINK_DECLARED_MODELS
	| typeof DOCS_LINK_AUTHENTICATION
	| typeof DOCS_LINK_OPENROUTER_CATALOG
	| typeof DOCS_LINK_SETTINGS_MIGRATION;
