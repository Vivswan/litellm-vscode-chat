/**
 * Every dashboard help string, as zero-argument functions returning one l10n.t literal:
 * lazy so strings resolve after the webview's l10n bootstrap, and provably static so
 * help text can never carry server data. The claims are sourced from the setting
 * descriptions and the transport/auth modules; when behavior changes there, THIS file
 * is the one to update.
 * Style: one or two short sentences, example-first; say the one thing that would surprise.
 */

import * as l10n from "@vscode/l10n";
import type { ServerFormField } from "../../dashboard/serverForm";
import type { BooleanSettingId, LanguageFilterMode, NumberSettingId } from "../../shared/config/settingSpec";

export function helpServersSection(): string {
	return l10n.t(
		"The LiteLLM servers this extension fetches models from, saved in the litellm-vscode-chat.servers user setting. Spend and budget read each key's own /key/info; spend tracking needs a database-backed proxy."
	);
}

export function helpModelsSection(): string {
	return l10n.t(
		"Every model your servers report, as registered with Copilot Chat. Lists are cached; run Sync models to ask the servers again now."
	);
}

export function helpParamsInspector(): string {
	return l10n.t(
		"What one request to this model carries, e.g. temperature 0.2 from your settings. Runtime options from the chat client override the forwarded values, except where a record forces one."
	);
}

export function helpSettingsSection(): string {
	return l10n.t(
		"The extension's settings, same as the Settings editor. Reset removes your value so the next scope's value or the built-in default shows through."
	);
}

export function helpFeaturesSection(): string {
	return l10n.t(
		"The extension's features beyond chat, e.g. inline completions, each with its own opt-in and model. Sections marked not active yet are registered ahead of their feature and take effect when it ships."
	);
}

export function helpImportExportGroup(): string {
	return l10n.t(
		"Move your setup to another machine: Export writes your settings to a JSON file, and Import merges such a file back. Export includes secrets only if you ask it to."
	);
}

export function helpConnectionSection(): string {
	return l10n.t(
		"Names one proxy and points at it, e.g. Production at http://localhost:4000. The name is what the model picker shows, and every model here comes from that one URL."
	);
}

export function helpDiscoverySection(): string {
	return l10n.t(
		"Only needed when the proxy cannot list its own models, or cannot report their info. Declared IDs register anyway; marked failures log quietly and skip retries."
	);
}

export function helpMcpSection(): string {
	return l10n.t(
		"Makes this server's own MCP tools available in chat, e.g. a proxy that exposes search or database tools. Credentials attach when a session starts, and only on this server's own origin."
	);
}

/** The endpoint row's own help: the empty-means-derived rule, which the hint states concretely per entry. */
export function helpMcpEndpoint(): string {
	return l10n.t(
		"Where this server serves MCP, for a proxy that does not serve it at the default path. Leave it empty unless yours moved it."
	);
}

export function helpAdoptionSection(): string {
	return l10n.t(
		"Writes this VS Code-managed group into the litellm-vscode-chat.servers setting so it becomes editable here. Its credentials are copied inside the extension and never pass through this page."
	);
}

export function helpModelParametersSection(): string {
	return l10n.t(
		"Request parameters sent to matching models, e.g. temperature 0.2 for gpt-4*. Unlike the settings above, rows apply together via Apply; only parameters you set are sent, and runtime options win unless forced with _force."
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
				"The server's root URL, e.g. http://localhost:4000 - discovery and chat requests are sent relative to it, so no model-specific path. Trailing slashes are normalized."
			);
		case "apiVersion":
			// The "/v1" here is DEFAULT_API_VERSION spelled out (this module bans
			// interpolation); a webview drift guard fails when the constant moves.
			return l10n.t(
				"What to append to the base URL; leave on Auto unless your proxy pins a version. Auto adds /v1 or keeps a /v1 or /v2 already there; No version uses the URL as-is; Custom appends your segment, e.g. v2."
			);
		case "authForm":
			return l10n.t(
				"Pick how requests authenticate, e.g. a bearer API key. Exactly one form per entry; a gateway that checks a second credential takes it as a companion inside that form."
			);
		case "apiKey":
			return l10n.t(
				"Sent on every request as an Authorization bearer plus an X-API-Key copy. Leave empty if the server needs none, or to set the key later."
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
				"Correct or declare what this server's models can do, e.g. context_length 128000 for gpt-4 models. To create a model discovery does not list, add its ID to the entry's discovery.declared."
			);
		case "expectedFailures":
			return l10n.t(
				"Mark discovery endpoints this server is known to lack, e.g. the model list. Marked failures log quietly, skip retries, and never count as errors."
			);
		case "headers":
			return l10n.t(
				"Extra HTTP headers on every request to this server, e.g. x-routing-env: prod. Auth headers win conflicts, and values are plain settings text, not secrets."
			);
		case "declaredModels":
			return l10n.t(
				"Exact model IDs to register even when discovery cannot list them, e.g. deepseek-r1. A declaration goes inert once the server lists the ID."
			);
		case "budget":
			return l10n.t(
				"A manual budget, e.g. 50, in the server's own billing currency, driving usage alerts. Outranks the key's own max_budget; the server row's drawer shows both."
			);
		case "mcp":
			return l10n.t(
				"Publishes this server to chat as an MCP server, so its tools appear in the tool picker. Credentials go out only when a session starts."
			);
	}
}

/** The OAuth form's apiKey companion: same field, different wire behavior, so its own help. */
export function helpOauthCompanionApiKey(): string {
	return l10n.t(
		"Sent beside the OAuth bearer as X-API-Key only, e.g. a LiteLLM key naming the team to bill; Authorization stays with the token."
	);
}

export function helpSecretStorage(): string {
	return l10n.t(
		"Secret storage keeps the value encrypted and out of settings.json; Settings writes it there in plain text. When editing later, leave a secret field empty to keep what is stored."
	);
}

export function helpModelParameterPrefix(): string {
	return l10n.t(
		"Matches model IDs: gpt-4 exactly, gpt-4* for the family, /regex/ or * for broader sets; the most specific match wins. Server-specific records belong in the entry's models.parameters, not in URL-prefixed keys."
	);
}

export function helpEntryModelParameterPrefix(): string {
	return l10n.t(
		"Matches model IDs: gpt-4 exactly, gpt-4* for the family, /regex/ or * for broader sets; the most specific match wins. Already scoped to this server, so a base URL in the key never matches."
	);
}

export function helpModelParameterName(): string {
	return l10n.t(
		"The request body key, e.g. temperature, top_p, or stop. Provider-owned fields like model and messages cannot be set; keys starting with _ are directives - instructions to the extension, never sent."
	);
}

export function helpModelParameterValue(): string {
	return l10n.t(
		'JSON, so the type survives: 0.2, true, "text", ["END"], {"effort": "high"}. Values that do not parse block Apply.'
	);
}

export function helpCapabilityPrefix(): string {
	return l10n.t(
		"Matches model IDs: gpt-4 exactly, gpt-4* for the family, /regex/ or * for broader sets; the most specific match wins. Matching never creates models - declare missing IDs in the entry's discovery.declared."
	);
}

export function helpCapabilityName(): string {
	return l10n.t(
		"Any model_info field, e.g. context_length, supports_vision, or input_cost_per_token; unknown names apply as-is. _openrouter_model fills from the catalog, _fallback demotes below the server's report."
	);
}

export function helpCapabilityValue(): string {
	return l10n.t(
		"Token counts are numbers, e.g. 128000; support flags true or false; costs per token, e.g. 0.000002, 0 meaning free. Your values beat what the server reports unless the row is marked fallback."
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

export function helpInheritableFlag(): string {
	return l10n.t(
		"Lets more specific matching records inherit this field, e.g. a * record's temperature reaching gpt-5.6. Unchecked, a more specific record replaces this record wholesale."
	);
}

export function helpInheritFromControl(): string {
	return l10n.t(
		'What this record inherits from broader matches: the default takes fields marked inheritable, "everything" takes the whole broader view, "nothing" makes it a barrier, and named keys take exactly those records.'
	);
}

export function helpModelCapabilitiesSection(): string {
	return l10n.t(
		"Corrects or completes what servers report for matching models, e.g. context_length 128000. Unlike the settings above, rows apply together via Apply; your values beat the server's unless a row is marked fallback."
	);
}

export function helpTokenEstimation(): string {
	return l10n.t(
		"Auto loads the o200k_base tokenizer where a plain character count underestimates, e.g. CJK text; a loaded tokenizer holds 10-30 MB in memory."
	);
}

export function helpToolSchemaKeywords(): string {
	return l10n.t(
		"The built-in set always applies; keywords your server rejects can fail requests. Unlisted keywords are stripped before sending."
	);
}

export function helpCurrencySymbol(): string {
	return l10n.t(
		"Display only - amounts are never converted; they render exactly as the server reports them, whatever its billing currency."
	);
}

export function helpUiTheme(): string {
	return l10n.t("Auto follows the editor's theme; high contrast themes always do, whichever option is picked here.");
}

export function helpUiAccent(): string {
	return l10n.t(
		"Status colors stay green, yellow and red whatever you pick, and high contrast themes keep their own accent."
	);
}

export function helpUsageStatusBar(): string {
	return l10n.t("The number shown is the worst fresh server's spend as a percentage of its budget, e.g. 80%.");
}

export function helpUsageThresholds(): string {
	return l10n.t("Enter a percentage or a fraction, e.g. 80% or 0.8; clear both fields to turn alerts off.");
}

/** The shared model-picker row's help; the same claim for both features. */
export function helpFeatureModel(): string {
	return l10n.t(
		"Names a servers entry and one of its model IDs, e.g. Team proxy and gpt-4o-mini. Only declared entries qualify - externally managed groups have no servers entry."
	);
}

export function helpCommitPrompt(): string {
	return l10n.t(
		'Replaces the built-in instruction wholesale, e.g. "One-line imperative subject, no body." Leave empty for the built-in.'
	);
}

/** The language filter's mode row help: what each mode does with the list below. */
export function helpLanguageFilterMode(): string {
	return l10n.t(
		"Block runs inline completions everywhere except the listed languages; Allow only runs them in the listed ones."
	);
}

/** The language filter's list row help, keyed by mode; both quote example IDs (short-example-led). */
export function helpLanguageFilterList(mode: LanguageFilterMode): string {
	return mode === "allow"
		? l10n.t("Exact VS Code language IDs, e.g. typescript, python. While the list is empty, completions run nowhere.")
		: l10n.t("Exact VS Code language IDs, e.g. markdown, plaintext. Leave empty to run everywhere.");
}

export function helpCapsInspector(): string {
	return l10n.t(
		"Where each effective capability comes from, e.g. context_length 128000 from your settings. Higher precedence levels beat server-reported values."
	);
}

export function helpConfigDiagnosticsSection(): string {
	return l10n.t(
		"Settings this extension could not use as written, e.g. a matcher key no model can match. Problems with a server itself show on that server's row."
	);
}

export function helpResolutionSection(): string {
	return l10n.t(
		"Which record set each value on each model, e.g. temperature 0.3 from your gpt-5* record. Read-only, and it never leaves this dashboard."
	);
}

export function helpDiagnosticsTools(): string {
	return l10n.t(
		"Evidence about this install, e.g. Copy diagnostics puts your connections and configuration problems on the clipboard as English text. Report a bug pre-fills a GitHub issue."
	);
}

/**
 * The settings rows that carry a "?", in row order; sparse on purpose - only where a longer
 * explanation earns it. Static ids (nothing localized), so the list may live at module level.
 */
export const SETTING_ROW_HELP_IDS: readonly (NumberSettingId | BooleanSettingId)[] = [
	"chat.timeout",
	"chat.maxToolsPerRequest",
	"discovery.timeout",
	"discovery.cacheTtl",
	"discovery.staleServeWindow",
	"usage.pollInterval",
	"chat.promptCaching",
	"models.openRouterCatalog",
	"inlineCompletions.enabled",
	"commitGeneration.enabled",
	"prGeneration.enabled",
	"consultTool.enabled",
	"chatParticipant.enabled",
];

/** Per-setting help for the ids in SETTING_ROW_HELP_IDS; undefined for rows whose description is enough. */
export function settingRowHelp(id: NumberSettingId | BooleanSettingId): string | undefined {
	switch (id) {
		case "chat.timeout":
			return l10n.t({
				message:
					"A hard bound on the whole chat, commit-message, or pull-request-description call, streaming included; type 5m, 90s, or plain ms. Requests are never retried, so raise it if long runs get cut off.",
				comment: ["Do not translate the suffixes ms/s/m/h; the parser accepts only these ASCII letters."],
			});
		case "chat.maxToolsPerRequest":
			return l10n.t(
				"A request carrying more, e.g. 200 tools against a 128 cap, is refused before sending. Most servers cap at 128."
			);
		case "discovery.timeout":
			return l10n.t({
				message:
					"Applies per call, and a discovery pass makes several - the model-info listing and the /models fallback each get a fresh budget - so one pass can take a multiple of this. Type 30s, 1m, or plain ms.",
				comment: ["Do not translate the suffixes ms/s/m/h; the parser accepts only these ASCII letters."],
			});
		case "discovery.cacheTtl":
			return l10n.t(
				"Sync Models Now always asks the servers immediately, whatever this says; type 1h, 30m, or 0 to refresh every time."
			);
		case "discovery.staleServeWindow":
			return l10n.t({
				message:
					"Counted from the last successful sync; held models wear a stale warning, e.g. 1h suits a homelab proxy that sleeps. Type 1h, 30m, or plain ms; 0 drops them at once.",
				comment: ["Do not translate the suffixes ms/s/m/h; the parser accepts only these ASCII letters."],
			});
		case "usage.pollInterval":
			return l10n.t({
				message:
					"0 stops only the background timer - Refresh Usage Now still fetches on demand, and opening the dashboard fetches when the numbers are older than this interval (or its 5m default at 0). Type 5m, 90s, or plain ms.",
				comment: ["Do not translate the suffixes ms/s/m/h; the parser accepts only these ASCII letters."],
			});
		case "chat.promptCaching":
			return l10n.t(
				"Applies only on models that advertise support, currently Anthropic Claude models (supports_prompt_caching); the reused prefix bills at the cache rate instead of full price."
			);
		case "models.openRouterCatalog":
			// The filter reads THIS tip and the live status, never the row's displaced static
			// description; the two keys translate independently, so never rely on identity.
			return l10n.t(
				"Fill missing model capabilities from the OpenRouter catalog, refreshed weekly. Off, only explicit _openrouter_model directives read the cached snapshot."
			);
		case "inlineCompletions.enabled":
			// The description states both gates; the tip carries the privacy fact.
			return l10n.t("Inline completions send nearby file text to your LiteLLM server as you type.");
		case "commitGeneration.enabled":
			return l10n.t(
				"Generating sends the diff, untracked file names, and your last five commit subjects to your LiteLLM server."
			);
		case "prGeneration.enabled":
			// Same shape as the commit tip: the description states both gates, the
			// tip says what leaves the machine.
			return l10n.t(
				"Generating sends the branch's commits and a patch per changed file to your LiteLLM server; from the GitHub Pull Requests view, your PR template and referenced issues go too, private ones included."
			);
		case "consultTool.enabled":
			// The description states both gates; the tip carries the fact the
			// description no longer spells out - WHO decides, and what leaves.
			return l10n.t(
				"The agent decides when to consult, sending the question and background it writes to your LiteLLM server."
			);
		case "chatParticipant.enabled":
			// Its own row has no model picker, so the tip carries the one fact that
			// explains both the cost and the privacy story: it is a chat turn.
			return l10n.t("Type @litellm in chat; it answers with the model the picker has selected, and bills like chat.");
		default:
			return undefined;
	}
}
