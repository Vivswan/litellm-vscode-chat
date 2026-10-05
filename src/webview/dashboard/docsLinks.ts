/**
 * Every docs page the dashboard links out to: docsUrl calls with literal page and anchor arguments only - no
 * variable, not even another constant - so a read of this file plus shared/util/links.ts, whose docsUrl builds from
 * its own literal origin and which imports nothing but a type, proves link targets never carry server data.
 *
 * docsLinks.test.tsx resolves every page and anchor against docs/ under the site's heading-id rule, so a renamed page
 * or heading fails CI instead of serving 404s.
 */

import { type DOCS_GETTING_STARTED_URL, docsUrl, type SETUP_HINT_DOCS_URLS } from "../../shared/util/links";

export const DOCS_LINK_SERVERS = docsUrl("servers");
export const DOCS_LINK_SERVER_FORM = docsUrl("servers", "entry-reference");
export const DOCS_LINK_MODELS = docsUrl("models");
export const DOCS_LINK_PARAMS_INSPECTOR = docsUrl("dashboard", "effective-parameters");
export const DOCS_LINK_CAPS_INSPECTOR = docsUrl("dashboard", "effective-capabilities");
export const DOCS_LINK_SETTINGS = docsUrl("settings");
export const DOCS_LINK_DASHBOARD_FEATURES = docsUrl("dashboard", "features");
export const DOCS_LINK_MODEL_PARAMETERS = docsUrl("models", "parameters");
export const DOCS_LINK_MODEL_CAPABILITIES = docsUrl("models", "capabilities");
export const DOCS_LINK_PARAMS_INACTIVE = docsUrl("troubleshooting", "per-server-model-parameters-are-inactive");
export const DOCS_LINK_OPENAI_COMPATIBLE = docsUrl(
	"troubleshooting",
	"pointing-at-ollama-vllm-or-plain-openai-compatible-servers"
);
export const DOCS_LINK_USAGE = docsUrl("usage");
export const DOCS_LINK_RESOLVED_MODELS = docsUrl("dashboard", "resolved-models");
export const DOCS_LINK_MODEL_MATCHING = docsUrl("models", "model-matching");
export const DOCS_LINK_DECLARED_MODELS = docsUrl("servers", "declared-models");
export const DOCS_LINK_AUTHENTICATION = docsUrl("servers", "authentication");
export const DOCS_LINK_OPENROUTER_CATALOG = docsUrl("models", "the-openrouter-catalog");
export const DOCS_LINK_SETTINGS_MIGRATION = docsUrl("settings", "renamed-and-removed-settings");

/**
 * The only values a docs anchor may carry; DocsLink's href is typed to it. The getting-started link and the
 * setup-hint headings join by reading the host's constants, so a destination re-pointed there re-points the
 * dashboard with it.
 */
export type DocsUrl =
	| typeof DOCS_GETTING_STARTED_URL
	| (typeof SETUP_HINT_DOCS_URLS)[keyof typeof SETUP_HINT_DOCS_URLS]
	| typeof DOCS_LINK_SERVERS
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
