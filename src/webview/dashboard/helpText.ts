/**
 * Every help string the dashboard's "?" affordances show, in one place. Plain
 * string constants only - no runtime interpolation - so the secret sweeps can
 * trust that help text never carries server data, and a single read-through
 * reviews all of it. The claims here are sourced from the setting
 * descriptions and the transport/auth modules; when behavior changes there,
 * this file is the one to update.
 *
 * Style: one or two short sentences, leading with an example where one helps.
 * Say what the field is for and the one thing that would surprise; the
 * setting descriptions and the docs/ pages carry the full story.
 */

import type { BooleanSettingId, NumberSettingId } from "../../extension/dashboard/protocol";
import type { ServerFormField } from "../../extension/dashboard/serverForm";

export const HELP_SERVERS_SECTION =
	"The LiteLLM servers this extension fetches models from, saved in the litellm-vscode-chat.servers user " +
	"setting. Edit on an external row adopts that VS Code-managed group into the setting.";

export const HELP_MODELS_SECTION =
	"Every model your servers report, as registered with Copilot Chat. Lists are cached; run Sync models to ask " +
	"the servers again now.";

export const HELP_PARAMS_INSPECTOR =
	"What one request to this model carries, e.g. temperature 0.2 from your settings. Runtime options from the " +
	"chat client can still override the forwarded values.";

export const HELP_SETTINGS_SECTION =
	"The extension's settings, same as the Settings editor. Reset removes your value so the next scope's value or " +
	"the built-in default shows through.";

export const HELP_MODEL_PARAMETERS_SECTION =
	"Request parameters sent to matching models, e.g. temperature 0.2 for every gpt-4 model. Only parameters you " +
	"set are sent; options the chat client sets at runtime win over these.";

export const HELP_CUSTOM_HEADERS_SECTION =
	"HTTP headers added to every request sent to LiteLLM, e.g. x-litellm-api-key for a gateway. Keep secret " +
	"values in User settings, not Workspace settings.";

/** The Add/Edit server form, one entry per field, keyed like SERVER_FORM_FIELD_LABELS. */
export const SERVER_FIELD_HELP: Record<ServerFormField, string> = {
	label:
		"Names this server in the model picker, e.g. Team proxy. Renaming a saved entry creates a new group under " +
		"the new name.",
	baseUrl:
		"The server's root URL, e.g. http://localhost:4000 - discovery and chat requests are sent relative to it, " +
		"so no model-specific path.",
	apiKey:
		"Sent on every request as Authorization bearer plus an X-API-Key copy; with OAuth below, the token takes " +
		"Authorization and the key rides only X-API-Key. Leave empty if the server needs none.",
	oauthTokenUrl:
		"The OAuth 2.0 token endpoint, e.g. https://login.example.com/oauth/token. With a client ID, the extension " +
		"fetches short-lived bearer tokens and refreshes them itself.",
	oauthClientId: "The OAuth client ID; works together with the token URL.",
	oauthClientSecret: "The OAuth client secret. Leave empty for public clients issued without one.",
	oauthScopes: "Space-separated, e.g. litellm.read litellm.write. Empty uses the provider's defaults.",
	virtualKeyHeader:
		"The header that carries a gateway virtual key, e.g. x-litellm-api-key; set the value below with it. " +
		"Naming Authorization hands it that whole header and no OAuth token is fetched.",
	virtualKeyValue: "The key sent in that header on every request to this server.",
	modelParameters:
		"Parameters sent only to this server's models, e.g. temperature 0.2. Runtime options and per-model picker " +
		"config win; these win over the global Model parameters setting.",
};

export const HELP_SECRET_STORAGE =
	"Secret storage keeps the value encrypted and out of settings.json; Settings writes it there in plain text. " +
	"When editing later, leave a secret field empty to keep what is stored.";

export const HELP_MODEL_PARAMETER_PREFIX =
	"Matches model IDs by prefix, longest winning: gpt-4 covers gpt-4-turbo. Lead with a base URL, e.g. " +
	"https://myproxy.example/v1/gpt-4, to scope to one server; scoped entries beat unscoped ones.";

export const HELP_ENTRY_MODEL_PARAMETER_PREFIX =
	"Matches model IDs by prefix, longest winning: gpt-4 covers gpt-4-turbo. Already scoped to this server, so " +
	"use plain model IDs; a base URL prefix here never matches.";

export const HELP_MODEL_PARAMETER_NAME =
	"The request body key, e.g. temperature, top_p, or stop. Provider-owned fields like model and messages " +
	"cannot be set, and keys starting with _ are skipped.";

export const HELP_MODEL_PARAMETER_VALUE =
	'JSON, so the type survives: 0.2, true, "text", ["END"], {"effort": "high"}. Values that do not parse block ' +
	"Apply.";

/**
 * Per-setting help. Deliberately sparse: rows already render their one-line
 * descriptions, so a "?" appears only where a longer explanation earns it.
 */
export const SETTING_ROW_HELP: Partial<Record<NumberSettingId | BooleanSettingId, string>> = {
	defaultMaxOutputTokens:
		"Used for models whose server declares no output limit; a request built from this default is capped at " +
		"4096 tokens.",
	defaultMaxInputTokens:
		"Usually left empty: the input budget is then context length minus max output tokens. Setting it pins the " +
		"input limit for every model, overriding even server-declared ones.",
	requestTimeout:
		"A hard bound on the whole chat call, streaming included. Requests are never retried, so raise it if long " +
		"runs get cut off.",
	discoveryCacheTtl:
		"How long discovered model lists are reused; 0 asks the server on every refresh. Sync Models Now always " +
		"refreshes immediately.",
	"promptCaching.enabled":
		"On models that support it (currently Anthropic Claude), reuses the cached prompt prefix between turns " +
		"instead of re-sending the whole history at full price.",
};
