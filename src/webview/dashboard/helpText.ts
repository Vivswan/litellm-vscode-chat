/**
 * Every long-form help string the dashboard's "?" affordances show, in one
 * place. Plain string constants only - no runtime interpolation - so the
 * secret sweeps can trust that help text never carries server data, and a
 * single read-through reviews all of it. The claims here are sourced from the
 * setting descriptions and the transport/auth modules; when behavior changes
 * there, this file is the one to update.
 */

import type { BooleanSettingId, NumberSettingId } from "../../extension/dashboard/protocol";
import type { ServerFormField } from "../../extension/dashboard/serverForm";

export const HELP_SERVERS_SECTION =
	"The LiteLLM servers this extension asks for models. Declared rows live in the litellm-vscode-chat.servers " +
	"entry of your user settings and sync to a VS Code language-model provider group automatically; rows marked " +
	"external are VS Code-managed groups with no settings entry, and their Edit button adopts them into the " +
	"setting. Removing a row removes only the settings entry - the VS Code group itself is removed in the native " +
	"Manage Language Models editor.";

export const HELP_MODELS_SECTION =
	"Every model discovered across the configured servers, as it registers with Copilot Chat. Capabilities and " +
	"token limits are what the LiteLLM server reports and describe what a model can do; what it is asked to do is " +
	"configured separately, under Model parameters. Pricing is USD per million tokens as reported by the server. " +
	"Discovered lists are cached; run Sync models to ask the servers again immediately.";

export const HELP_SETTINGS_SECTION =
	"The extension's litellm-vscode-chat settings, also editable in the normal Settings editor. Edits here land in " +
	"your VS Code User settings, except that a value the workspace already sets is changed in the workspace. Reset " +
	"removes the value from the scope that sets it, so the next scope's value or the built-in default shows " +
	"through.";

export const HELP_MODEL_PARAMETERS_SECTION =
	"Request parameters from the litellm-vscode-chat.modelParameters setting, sent with chat requests to matching " +
	"models. Only parameters you set are sent - the extension never injects defaults - and options the chat client " +
	"sets at runtime override what is configured here. Matching is by model ID prefix and the most specific entry " +
	"wins; prefix an entry with a server's base URL to scope it to that one server.";

export const HELP_CUSTOM_HEADERS_SECTION =
	"HTTP headers from the litellm-vscode-chat.headers setting, added to every request this extension sends to " +
	"LiteLLM: model discovery and chat completions alike. Useful for API gateways that require headers such as " +
	"x-litellm-api-key. If a value is a secret, keep it in User settings rather than Workspace settings so it " +
	"cannot be committed with a project.";

/** The Add/Edit server form, one entry per field, keyed like SERVER_FORM_FIELD_LABELS. */
export const SERVER_FIELD_HELP: Record<ServerFormField, string> = {
	label:
		"The entry's identity: it names the VS Code provider group and appears in the model picker. Renaming a " +
		"saved entry creates a new group under the new name; the old group stays until you remove it in the native " +
		"Manage Language Models editor.",
	baseUrl:
		"The root URL of the LiteLLM server, e.g. http://localhost:4000 - an http(s) URL without a path to any " +
		"specific model. Model discovery and chat requests are sent relative to it.",
	apiKey:
		"Sent on every request to this server, as bearer auth in the Authorization header plus an X-API-Key header " +
		"for gateway compatibility. Leave it empty for servers that need no key or that authenticate through OAuth " +
		"below.",
	oauthTokenUrl:
		"The identity provider's OAuth 2.0 token endpoint. When set together with the client ID, the extension runs " +
		"the client-credentials flow: it exchanges the client credentials here for a short-lived bearer token, " +
		"sends that token in the Authorization header, and refreshes it before it expires.",
	oauthClientId:
		"The client identifier for the client-credentials exchange. OAuth needs it and the token URL together.",
	oauthClientSecret:
		"The client secret for the client-credentials exchange. Leave it empty when the identity provider issues " +
		"public clients without a secret.",
	oauthScopes:
		"Space-separated scopes sent with the token request, e.g. litellm.read litellm.write. Leave empty to omit " +
		"scopes and get the provider's defaults.",
	virtualKeyHeader:
		"The HTTP header that carries a gateway virtual key, e.g. x-litellm-api-key; header and value work as a " +
		"pair. Naming the Authorization header hands that header to the virtual key, and no OAuth token is fetched " +
		"or sent.",
	virtualKeyValue:
		"The key sent in the virtual key header on every request to this server. Stored like the API key: in VS " +
		"Code secret storage or inline in the settings file, whichever you choose below.",
};

export const HELP_SECRET_STORAGE =
	"Where the saved value lives. Secret storage is VS Code's encrypted store: the value stays out of every " +
	"settings file and never renders in this dashboard. Settings writes it in plain text into the " +
	"litellm-vscode-chat.servers entry in settings.json, visible to anything that reads that file. When you edit " +
	"the entry later, only inline (settings) values are loaded back into the form, since the file already shows " +
	"them; secure values stay put, and leaving a field empty keeps whatever is stored.";

export const HELP_MODEL_PARAMETER_PREFIX =
	"The model IDs this group applies to, matched by prefix with the longest match winning: for a gpt-4-turbo " +
	"model, a gpt-4-turbo entry beats a gpt-4 one. A bare prefix like gpt-4 applies on every server; to scope it " +
	"to one server, lead with that server's base URL - https://myproxy.example/v1/gpt-4 applies only to gpt-4 " +
	"models on https://myproxy.example/v1. A server-scoped entry beats an unscoped one.";

export const HELP_MODEL_PARAMETER_NAME =
	"The request body key as LiteLLM expects it, e.g. temperature, top_p, stop, or max_tokens. Only parameters " +
	"you set are sent. Provider-owned request fields - model, messages, stream, stream_options, tools, " +
	"tool_choice - cannot be overridden here, and keys starting with _ are skipped.";

export const HELP_MODEL_PARAMETER_VALUE =
	'Written as JSON, so the type survives the trip: 0.2 is a number, true a boolean, "text" a string (the ' +
	'quotes are required), ["END"] an array, and {"effort": "high"} an object. Anything that does not parse ' +
	"as JSON is flagged and blocks Apply.";

/**
 * Per-setting long-form help. Deliberately sparse: rows already render their
 * one-line descriptions, so a "?" appears only where a longer explanation
 * earns it.
 */
export const SETTING_ROW_HELP: Partial<Record<NumberSettingId | BooleanSettingId, string>> = {
	defaultMaxOutputTokens:
		"Applies to models whose server does not declare an output-token limit. When a request sets no max_tokens " +
		"of its own, the extension sends the model's declared maximum; if that maximum came from this default " +
		"rather than from the server, the sent value is capped at 4096.",
	defaultMaxInputTokens:
		"Normally left empty: the input budget is then derived as context length minus max output tokens. Set it " +
		"only to pin an explicit input limit for models whose server reports none.",
	requestTimeout:
		"A hard bound on the whole chat completion call, streaming included. Chat requests are never retried, so " +
		"hitting the bound surfaces as an error; increase it if long-running requests are being cut off.",
	discoveryCacheTtl:
		"Higher values avoid repeated discovery requests when VS Code re-resolves providers in bursts, but models " +
		"added or removed on the server take up to this long to appear; 0 asks the server on every refresh " +
		"(simultaneous refreshes still share one request). Run LiteLLM: Sync Models Now to refresh immediately " +
		"regardless of this setting.",
	"promptCaching.enabled":
		"For models that advertise prompt caching support (currently Anthropic Claude), places cache breakpoints " +
		"on the tool definitions, the system prompt, the first user message, and the last text-bearing message, so " +
		"agent sessions reuse the cached prefix instead of re-paying for the whole history every turn. Models " +
		"without caching support are unaffected.",
};
