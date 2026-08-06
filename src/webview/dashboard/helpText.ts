/**
 * Every help string the dashboard's "?" affordances show, in one place. Each
 * export is a zero-argument function returning one l10n.t literal with no
 * interpolation - lazy so the strings resolve after the webview's l10n
 * bootstrap, and provably static so the secret sweeps can trust that help
 * text never carries server data; a single read-through still reviews all of
 * it. The claims here are sourced from the setting descriptions and the
 * transport/auth modules; when behavior changes there, this file is the one
 * to update.
 *
 * Style: one or two short sentences, leading with an example where one helps.
 * Say what the field is for and the one thing that would surprise; the
 * setting descriptions and the docs/ pages carry the full story.
 */

import * as l10n from "@vscode/l10n";
import type { BooleanSettingId, NumberSettingId } from "../../extension/dashboard/protocol";
import type { ServerFormField } from "../../extension/dashboard/serverForm";

export function helpServersSection(): string {
	return l10n.t(
		"The LiteLLM servers this extension fetches models from, saved in the litellm-vscode-chat.servers user setting. Edit on an external row adopts that VS Code-managed group into the setting."
	);
}

export function helpModelsSection(): string {
	return l10n.t(
		"Every model your servers report, as registered with Copilot Chat. Lists are cached; run Sync models to ask the servers again now."
	);
}

export function helpParamsInspector(): string {
	return l10n.t(
		"What one request to this model carries, e.g. temperature 0.2 from your settings. Runtime options from the chat client override the forwarded values, except rows marked forced."
	);
}

export function helpSettingsSection(): string {
	return l10n.t(
		"The extension's settings, same as the Settings editor. Reset removes your value so the next scope's value or the built-in default shows through."
	);
}

export function helpModelParametersSection(): string {
	return l10n.t(
		"Request parameters sent to matching models, e.g. temperature 0.2 for every gpt-4 model. Only parameters you set are sent; runtime options win over these unless a field is forced with _force."
	);
}

export function helpCustomHeadersSection(): string {
	return l10n.t(
		"HTTP headers added to every request sent to LiteLLM, e.g. x-litellm-api-key for a gateway. Keep secret values in User settings, not Workspace settings."
	);
}

/** The Add/Edit server form's help, one entry per field, keyed like serverFormFieldLabel. */
export function serverFieldHelp(field: ServerFormField): string {
	switch (field) {
		case "label":
			return l10n.t(
				"Names this server in the model picker, e.g. Team proxy. Renaming a saved entry creates a new group under the new name."
			);
		case "baseUrl":
			return l10n.t(
				"The server's root URL, e.g. http://localhost:4000 - discovery and chat requests are sent relative to it, so no model-specific path."
			);
		case "apiKey":
			return l10n.t(
				"Sent on every request as Authorization bearer plus an X-API-Key copy; with OAuth below, the token takes Authorization and the key rides only X-API-Key. Leave empty if the server needs none."
			);
		case "oauthTokenUrl":
			return l10n.t(
				"The OAuth 2.0 token endpoint, e.g. https://login.example.com/oauth/token. With a client ID, the extension fetches short-lived bearer tokens and refreshes them itself."
			);
		case "oauthClientId":
			return l10n.t("The OAuth client ID; works together with the token URL.");
		case "oauthClientSecret":
			return l10n.t("The OAuth client secret. Leave empty for public clients issued without one.");
		case "oauthScopes":
			return l10n.t("Space-separated, e.g. litellm.read litellm.write. Empty uses the provider's defaults.");
		case "virtualKeyHeader":
			return l10n.t(
				"The header that carries a gateway virtual key, e.g. x-litellm-api-key; set the value below with it. Naming Authorization hands it that whole header and no OAuth token is fetched."
			);
		case "virtualKeyValue":
			return l10n.t("The key sent in that header on every request to this server.");
		case "modelParameters":
			return l10n.t(
				"Parameters sent only to this server's models, e.g. temperature 0.2. Runtime options and per-model picker config win unless a field is forced with _force; these win over the global Model parameters setting."
			);
		case "modelCapabilities":
			return l10n.t(
				"Correct or declare what this server's models can do, e.g. context_length 128000 for gpt-4 models. Add _declare true to create a model discovery does not list."
			);
		case "expectedFailures":
			return l10n.t(
				"Mark discovery endpoints this server is known to lack, e.g. the model list. Marked failures log quietly, skip retries, and never count as errors."
			);
	}
}

export function helpSecretStorage(): string {
	return l10n.t(
		"Secret storage keeps the value encrypted and out of settings.json; Settings writes it there in plain text. When editing later, leave a secret field empty to keep what is stored."
	);
}

export function helpModelParameterPrefix(): string {
	return l10n.t(
		"Matches model IDs by prefix, longest winning: gpt-4 covers gpt-4-turbo. Lead with a base URL, e.g. https://myproxy.example/v1/gpt-4, to scope to one server; scoped entries beat unscoped ones."
	);
}

export function helpEntryModelParameterPrefix(): string {
	return l10n.t(
		"Matches model IDs by prefix, longest winning: gpt-4 covers gpt-4-turbo. Already scoped to this server, so use plain model IDs; a base URL prefix here never matches."
	);
}

export function helpModelParameterName(): string {
	return l10n.t(
		"The request body key, e.g. temperature, top_p, or stop. Provider-owned fields like model and messages cannot be set, and keys starting with _ are skipped."
	);
}

export function helpModelParameterValue(): string {
	return l10n.t(
		'JSON, so the type survives: 0.2, true, "text", ["END"], {"effort": "high"}. Values that do not parse block Apply.'
	);
}

export function helpCapabilityPrefix(): string {
	return l10n.t(
		"Matches model IDs by prefix, longest winning: gpt-4 covers gpt-4-turbo. With _declare, use the exact model ID - prefixes never create models."
	);
}

export function helpCapabilityName(): string {
	return l10n.t(
		"A capability field like context_length or supports_vision, or a directive: _declare creates the model, _openrouter_model fills fields from the catalog, _fallback demotes fields below the server's report."
	);
}

export function helpCapabilityValue(): string {
	return l10n.t(
		"Numbers are token counts, e.g. 128000; support flags are true or false. Your values beat what the server reports unless the row is marked fallback."
	);
}

export function helpCatalogPicker(): string {
	return l10n.t(
		"Search the OpenRouter catalog by name or ID, e.g. gpt-4o. Picking an entry fills capability fields the row leaves unset."
	);
}

export function helpFallbackFlag(): string {
	return l10n.t(
		"Applies this value only when the server reports nothing, e.g. filling a missing context_length. Unchecked, your value overrides the server's."
	);
}

export function helpFallbackFlagDisabled(): string {
	return l10n.t(
		"Locked while _declare is on: the model it creates has no server value to fall back under. Models this prefix merely matches keep existing _fallback marks."
	);
}

export function helpForceFlag(): string {
	return l10n.t(
		"Sends this value even when the chat client or the model picker sets the same key, e.g. pinning temperature 0.2. Unchecked, runtime options win."
	);
}

export function helpForceFlagDisabled(): string {
	return l10n.t(
		"Cannot be forced: provider-owned fields like model and keys starting with _ always stay extension-owned."
	);
}

export function helpCapsInspector(): string {
	return l10n.t(
		"Where each effective capability comes from, e.g. context_length 128000 from your settings. Higher precedence levels beat server-reported values."
	);
}

/**
 * The settings rows that carry a "?", in row order. Deliberately sparse:
 * rows already render their one-line descriptions, so help appears only
 * where a longer explanation earns it. Static ids (nothing localized), so
 * the list may live at module level; settingRowHelp holds the strings.
 */
export const SETTING_ROW_HELP_IDS: readonly (NumberSettingId | BooleanSettingId)[] = [
	"defaultMaxOutputTokens",
	"defaultMaxInputTokens",
	"requestTimeout",
	"discoveryTimeout",
	"discoveryCacheTtl",
	"promptCaching.enabled",
];

/** Per-setting help for the ids in SETTING_ROW_HELP_IDS; undefined for rows whose description is enough. */
export function settingRowHelp(id: NumberSettingId | BooleanSettingId): string | undefined {
	switch (id) {
		case "defaultMaxOutputTokens":
			return l10n.t(
				"Used for models whose server declares no output limit; a request built from this default is capped at 4096 tokens."
			);
		case "defaultMaxInputTokens":
			return l10n.t(
				"Usually left empty: the input budget is then context length minus max output tokens. Setting it pins the input limit for every model, overriding even server-declared ones."
			);
		case "requestTimeout":
			return l10n.t({
				message:
					"A hard bound on the whole chat call, streaming included; type 5m, 90s, or plain ms. Requests are never retried, so raise it if long runs get cut off.",
				comment: ["Do not translate the suffixes ms/s/m/h; the parser accepts only these ASCII letters."],
			});
		case "discoveryTimeout":
			return l10n.t({
				message: "A hard bound on one model-list fetch; type 30s, 1m, or plain ms.",
				comment: ["Do not translate the suffixes ms/s/m/h; the parser accepts only these ASCII letters."],
			});
		case "discoveryCacheTtl":
			return l10n.t(
				"How long discovered model lists are reused, e.g. 1h or 0 to ask the server on every refresh. Sync Models Now always refreshes immediately."
			);
		case "promptCaching.enabled":
			return l10n.t(
				"On models that support it (currently Anthropic Claude), reuses the cached prompt prefix between turns instead of re-sending the whole history at full price."
			);
		default:
			return undefined;
	}
}
