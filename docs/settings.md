# Settings

English | [简体中文](zh-cn/settings.md) | [繁體中文](zh-tw/settings.md)

The lookup reference for every `litellm-vscode-chat.*` setting and every server-entry property: name, default, one-paragraph behavior, and where the full story lives. To *learn* the concepts, read the pillar pages instead: [Servers](servers.md), [Models](models.md), [Usage](usage.md).

## How settings work

Two equivalent ways to edit everything:

- **Settings UI / settings.json** - `Ctrl+,` / `Cmd+,`, search "litellm-vscode-chat". The settings are grouped into sections (Servers, Models, Chat, Discovery, Usage, UI, Inline completions, Commit message generation).
- **The dashboard** - "LiteLLM: Open Dashboard", the Settings section. Same values as form controls with validation, units, and defaults inline; a configured row says where its value lives, and Reset clears that scope. See [Dashboard](dashboard.md).

| Fact | Detail |
|---|---|
| Scope | `servers` is machine-scoped: user settings only, never overridable by a workspace, never carried by Settings Sync. A `servers` value in a workspace's `.vscode/settings.json` is ignored by VS Code itself (the Settings editor says it can apply in user settings only). Every other setting behaves like a normal user/workspace setting and syncs normally. |
| Effect | Changes apply immediately - no reload. Model-affecting changes refresh the model list; usage changes rewire the poller; timeout changes apply to the next request. That includes the appearance settings: an open dashboard restyles itself the moment `ui.theme` or `ui.accent` changes, whether the change came from the dashboard's own picker or from settings.json. |
| Migration | Settings from older versions are renamed and restructured automatically on upgrade; see the [rename table](#renamed-and-removed-settings). Nothing needs re-entering. When a new-name setting already holds a value (say, Settings Sync delivered it from an upgraded machine first), the migration keeps it and just drops the old key - with one caveat for server-URL-scoped keys ([scope notes](#renamed-and-removed-settings)). |
| Unknown keys | A `litellm-vscode-chat.*` key the extension does not declare (a typo, say `chat.timout`) is ignored, and VS Code's settings editor marks it as an unknown setting in settings.json. The same goes for old names once [renamed](#renamed-and-removed-settings). |

## Export and import

Settings Sync deliberately skips the parts that matter most here - `servers` is machine-scoped and secret-storage values never sync - so moving a setup to another machine has its own pair of commands. The dashboard's Settings section carries them as the **Import & Export** buttons; command or button, the flow is the same.

- **"LiteLLM: Export Settings..."** writes every `litellm-vscode-chat.*` setting you have configured in user settings to a JSON file (default `~/litellm-settings.json`). A modal asks about secrets first: **Include Secrets** copies secret-storage values into their server entries so the file is complete - and carries those credentials in plaintext, so store and share it carefully - while **Exclude Secrets** strips every secret value, inline ones included, so the file carries no credentials (custom [header](servers.md#custom-headers) values are plain settings, not secrets, and stay; credentials are re-entered after importing).
- **"LiteLLM: Import Settings..."** merges such a file back. Nothing is written until you confirm a preview (which settings will be written, how many servers collide, how many secret values the file carries), and each server label that already exists asks what to do: **Overwrite** replaces the entry and its stored secrets in place - when that changes connection settings (base URL, credentials), the already-synced provider group cannot pick them up, so the server's dashboard row shows the reconnect steps ([lifecycle](servers.md#lifecycle-renames-removals-hidden-groups)), and the preview flags such overwrites up front - **Skip** leaves yours, **Import Renamed** adds the incoming entry under a new label. Non-colliding servers are appended, other settings are written whole, and secret values in the file go into VS Code secret storage, never your settings file. Importing a server replaces that label's stored secrets outright - a file without secrets leaves the imported entry uncredentialed rather than picking up values left behind by an earlier server of the same name. Dismissing any prompt aborts the whole import with nothing written.
- **"LiteLLM: Undo Last Settings Import"** restores settings and stored secrets to their pre-import state - wholesale, so edits made after the import to the affected keys are rolled back too; a confirmation stating when the snapshot was taken comes first. One slot: each import replaces it, and the import's own notification carries an **Undo Import** button that runs the same command.

The file is a versioned envelope (setting keys inside it drop the `litellm-vscode-chat.` prefix), so a file from a newer extension version is refused with an update hint rather than half-imported:

```jsonc
{
  "litellm-vscode-chat": 1,          // the format version and file discriminant
  "exportedBy": "0.4.5",             // informational only
  "settings": { "servers": [ /* ... */ ] }
}
```

## Reference

| Setting | Default | Behavior |
|---------|---------|-------------|
| `litellm-vscode-chat.servers` | `[]` | The declared LiteLLM servers; [entry properties below](#server-entry-properties), full story in [Servers](servers.md) |
| `litellm-vscode-chat.models.parameters` | `{}` | Request parameters per model, keyed by [matchers](models.md#model-matching). Only what you set is sent. Full story: [Models - Parameters](models.md#parameters) |
| `litellm-vscode-chat.models.capabilities` | `{}` | Capability overrides per model, keyed by [matchers](models.md#model-matching): token limits, vision, tools, reasoning, pricing - any `model_info` field, known or not; the vocabulary is open. Full story: [Models - Capabilities](models.md#capabilities) |
| `litellm-vscode-chat.models.openRouterCatalog` | `true` | Fill missing capabilities from a weekly-refreshed snapshot of OpenRouter's public catalog; manual refresh via "LiteLLM: Refresh OpenRouter Catalog". Details incl. privacy notes: [Models - Capabilities](models.md#capabilities) |
| `litellm-vscode-chat.chat.timeout` | `300000` | Hard time budget for one chat completion call, and for one commit-generation call, in milliseconds. Chat requests are never retried, so this is the total time one request may take, streaming included. Minimum 1000; lower values are clamped. Raise it for long reasoning runs or slow infrastructure |
| `litellm-vscode-chat.chat.maxToolsPerRequest` | `128` | How many tools one chat request may carry before the extension refuses it locally instead of sending it (most OpenAI-compatible servers enforce 128). Raising it past what your server or model accepts moves the failure server-side: the request is sent and the server rejects it. Minimum 1 |
| `litellm-vscode-chat.chat.additionalToolSchemaKeywords` | `[]` | Extra JSON-Schema keywords kept in tool input schemas, e.g. `["propertyNames"]`. Tool schemas are sanitized to a built-in keyword allowlist before sending; keywords listed here are kept too, values passed through unchanged. The built-in set always applies. A keyword your server or model does not accept can fail requests or degrade tool calling |
| `litellm-vscode-chat.chat.promptCaching` | `true` | Reuse provider-side prompt caches across the turns of a session on models that advertise support; [details below](#prompt-caching) |
| `litellm-vscode-chat.chat.tokenEstimation` | `"auto"` | How prompt sizes are estimated for the local token budget: `"auto"` (script-aware heuristic that loads the o200k_base tokenizer when the VS Code display language is not English, or when the chat contains enough text that plain character counting underestimates - CJK and other non-Latin scripts, emoji), `"heuristic"` (plain 4-characters-per-token, never loads tokenizer data, undercounts CJK roughly 4x), `"o200k_base"` or `"cl100k_base"` (always load that tokenizer). A loaded tokenizer keeps roughly 10-30 MB in memory while active; counting cost is negligible |
| `litellm-vscode-chat.discovery.timeout` | `30000` | Hard time budget for each model-discovery request, in milliseconds, its retries included. The model-info listing, the `/v1/models` fallback, and the OAuth token exchange each get a fresh budget, so a discovery pass may take up to their sum. Minimum 1000 |
| `litellm-vscode-chat.discovery.cacheTtl` | `3600000` | How long a discovered model list is reused, in milliseconds. VS Code re-resolves providers often (sometimes several times a second); the cache keeps that off your server. `0` fetches fresh every time (negative values clamp to `0`); failures are never cached; simultaneous refreshes share one request; "LiteLLM: Sync Models Now" bypasses it |
| `litellm-vscode-chat.discovery.staleServeWindow` | `600000` | How long a server that stops answering keeps serving its last known models flagged stale, counted from its last successful discovery, in milliseconds. Raise it for a server that sleeps or restarts for longer than ten minutes; `0` never serves stale models (a failed refresh empties that server's list at once). Details: [Models - Discovery](models.md#discovery) |
| `litellm-vscode-chat.usage.pollInterval` | `300000` | Background spend/budget polling cadence, in milliseconds. `0` = off: no background requests and no alerts; the dashboard fetches on open only when a fetch is due (no completed fetch this session, the last one older than five minutes, or a changed `servers` setting). Nonzero values below `30000` clamp up to 30 seconds. Full story: [Usage](usage.md) |
| `litellm-vscode-chat.usage.initialRefreshDelay` | `5000` | How long after extension startup the first usage poll runs, in milliseconds |
| `litellm-vscode-chat.usage.serversChangeRefreshDelay` | `2000` | How long after a `servers` change usage data refreshes, in milliseconds; long enough to coalesce a burst of settings.json keystrokes |
| `litellm-vscode-chat.usage.pollingOffFreshnessWindow` | `600000` | How long on-demand usage data counts as fresh while polling is off, in milliseconds (while polling is on, the window is twice the poll interval instead). `0` never counts it fresh, which hides the [status bar item](usage.md#the-status-bar) |
| `litellm-vscode-chat.usage.alertThresholds` | `[0.8, 0.95]` | Budget fractions that trigger a one-time alert each; every value in (0, 1]; empty list = alerts off. Full story: [Usage - Alerts](usage.md#alerts) |
| `litellm-vscode-chat.usage.statusBar` | `"always"` | The usage status bar item: `"always"`, `"alerts-only"`, `"off"`. Full story: [Usage - The status bar](usage.md#the-status-bar) |
| `litellm-vscode-chat.usage.currencySymbol` | `"$"` | Prefix on every spend and price figure, e.g. `"EUR "`. Display only: amounts are never converted - they render exactly as the server reports them; an empty string shows bare numbers |
| `litellm-vscode-chat.ui.maskSecretInputs` | `true` | Mask credential values while typing them into input-box prompts. The dashboard's secret fields always mask, each behind its own Show toggle, regardless of this setting |
| `litellm-vscode-chat.ui.theme` | `"auto"` | How the dashboard colors itself: `"auto"` follows your VS Code theme, `"light"` and `"dark"` hold still while the editor changes around them. [Appearance notes below](#appearance) |
| `litellm-vscode-chat.ui.accent` | `"blue"` | The dashboard's accent hue: `"blue"`, `"violet"`, `"teal"`, `"amber"`. It marks primary actions, selection, focus and links, and nothing else - status colors stay green, yellow and red. [Appearance notes below](#appearance) |
| `litellm-vscode-chat.inlineCompletions.enabled` | `false` | Opt-in for inline (ghost text) completions from a LiteLLM model, shipping with the inline completions feature. Off by default: nothing is registered and nothing is sent until enabled, and enabling without `inlineCompletions.model` keeps the feature idle |
| `litellm-vscode-chat.inlineCompletions.model` | `null` | The model that serves inline completions: `{ "server": "<entry label>", "model": "<raw model id>" }`, naming a `servers` entry and one of its model IDs. The model is always your explicit choice - never auto-picked; `null` keeps the feature idle |
| `litellm-vscode-chat.inlineCompletions.languageFilter` | `{"mode":"block","languages":[]}` | Where inline completions run: mode `"block"` runs them everywhere except the listed exact VS Code language IDs, `"allow"` only in the listed ones (an empty allow list runs nowhere), e.g. `{ "mode": "block", "languages": ["markdown", "plaintext"] }`. The default blocks nothing |
| `litellm-vscode-chat.commitGeneration.enabled` | `false` | Opt-in for commit message generation from a LiteLLM model, shipping with the commit generation feature. Off by default: the command stays hidden and nothing is sent until enabled, and enabling without `commitGeneration.model` keeps the feature idle |
| `litellm-vscode-chat.commitGeneration.model` | `null` | The model that drafts commit messages; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model` |
| `litellm-vscode-chat.commitGeneration.prompt` | `""` | Custom instruction for the generated commit message, replacing the built-in instruction wholesale. Empty uses the built-in (a Conventional Commits subject plus a short body). Model-facing text, sent as written |
| `litellm-vscode-chat.prGeneration.enabled` | `false` | Opt-in for PR title/description generation from a LiteLLM model. Registered ahead of the feature: the setting persists and takes effect when the feature ships |
| `litellm-vscode-chat.prGeneration.model` | `null` | The model that drafts PR descriptions; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model` |
| `litellm-vscode-chat.consultTool.enabled` | `false` | Opt-in for the consult tool, which lets a chat agent ask a second LiteLLM model for its opinion. Off by default: nothing is registered and nothing is sent until enabled, and enabling without `consultTool.model` keeps the tool unregistered. Once both are set the agent calls it on its own initiative |
| `litellm-vscode-chat.consultTool.model` | `null` | The model the consult tool asks; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model` |
| `litellm-vscode-chat.quickFix.enabled` | `false` | Opt-in for Fix/Explain quick fixes on diagnostics. Registered ahead of the feature: the setting persists and takes effect when the feature ships |
| `litellm-vscode-chat.quickFix.model` | `null` | The model behind the quick-fix fallback path; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model` |
| `litellm-vscode-chat.reviewComments.enabled` | `false` | Opt-in for AI review comments on your changes. Registered ahead of the feature: the setting persists and takes effect when the feature ships |
| `litellm-vscode-chat.reviewComments.model` | `null` | The model that writes review comments; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model` |
| `litellm-vscode-chat.chatParticipant.enabled` | `true` | The @litellm chat participant, answering with the chat request's own model (no model setting). On by default |

There is deliberately no global headers setting: custom HTTP headers describe how to talk to one server, so they live on the server entry ([`headers`](servers.md#custom-headers)) - machine-scoped and out of Settings Sync's reach, unlike a global setting.

## Server entry properties

Each entry of `litellm-vscode-chat.servers` (all optional except `label` and `baseUrl`); the full story for every row is in [Servers](servers.md):

| Property | Type | Behavior |
|---|---|---|
| `label` | string | The server's display name and identity (with `baseUrl`); unique across entries - a repeated label is skipped and reported, the first entry wins. See [lifecycle](servers.md#lifecycle-renames-removals-hidden-groups) for what renames do |
| `baseUrl` | string | The server's root URL; the extension appends `/v1` unless the URL already ends in a version segment (like `/v1` or `/v2`), which is used as-is - `apiVersion` overrides both. A path prefix is kept, a trailing slash is stripped |
| `apiVersion` | string | What to append to the base URL. Unset = auto (`/v1`, or a version already in the URL); `""` = append nothing; `"v2"` = append `/v2` |
| `auth` | object | Exactly one form of `apiKey`, `oauth`, `virtualKey` - ranked in that order for companions: `oauth` carries optional `apiKey`/`virtualKey` companions, `apiKey` an optional `virtualKey` companion, for gateways that check two headers. An ambiguous shape is reported as misconfigured and the entry is not used until fixed. Omit entirely for servers that need no credentials. Full story: [Servers - Authentication](servers.md#authentication) |
| `headers` | object | Custom HTTP headers on every request to this server (routing tags, tracing); extension-managed auth headers win conflicts. [Servers - Custom headers](servers.md#custom-headers) |
| `models.parameters` | record | Request parameters for this server only; same [matcher keys](models.md#model-matching) as the global setting, applied above it field by field |
| `models.capabilities` | record | Capability overrides for this server only; same mechanics |
| `discovery.declared` | string[] | Exact model IDs to register when discovery cannot list them; [Servers - Declared models](servers.md#declared-models) |
| `discovery.expectedFailures` | string[] | Discovery endpoints expected to fail here (`"modelListing"`, `"modelInfo"`): one attempt, info-level log, not an outage |
| `budget` | number | Manual budget in the server's billing currency, greater than 0; outranks the key's own `max_budget` for [usage alerts](usage.md#budgets); both are shown |
| `mcp` | `true` or object | Make this server's own MCP tools available in chat; `true` publishes `<baseUrl>/mcp`, `{ "url": "..." }` names another endpoint (credentialed only on the entry's own origin); [Servers - MCP tools](servers.md#mcp-tools) |

Secret-capable fields (`auth.apiKey`, `auth.oauth.clientSecret`, `auth.virtualKey.value`, the OAuth companions) can live in VS Code secret storage instead of the settings file: [Servers - Secrets](servers.md#secrets-and-secret-storage).

## Record directives

Inside a `models.parameters` or `models.capabilities` record (global or per-entry), keys starting with `_` are directives: instructions to the extension, never sent to the server. Unknown `_` keys are ignored; every other key is a field - both vocabularies are open ([capabilities](models.md#capability-fields)).

| Directive | Valid in | What it does |
|---|---|---|
| `"_force": true \| ["field", ...]` | `models.parameters` | Marks all/listed parameter fields as forced: they beat runtime options and the model picker's per-model configuration. Provider-owned fields (`model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`) cannot be forced - naming one is reported and skipped. Full story: [Models - Parameters](models.md#parameters) |
| `"_fallback": true \| ["field", ...]` | `models.capabilities` | Marks all/listed capability fields as fallbacks: they fill in below what the server reports instead of overriding it. A fallback-provided max output tokens counts as user-set (no 4096 cap). Full story: [Models - Capabilities](models.md#capabilities) |
| `"_openrouter_model": "vendor/id"` | `models.capabilities` | Pulls the named model's capability data - capabilities only, never pricing - from the OpenRouter catalog. Derived fields rank above what the server reports (the directive says the server's data is not to be trusted for this model) but below your explicit fields in the record. Works offline from the bundled snapshot. Full story: [Models - Capabilities](models.md#capabilities) |
| `"_inheritable": true \| ["field", ...]` | both records | Marks all/listed fields inheritable by more-specifically-matched models that do not say otherwise. Full story: [Models - Matching](models.md#which-record-applies) |
| `"_inherit_from": true \| false \| ["key", ...]` | both records | What this record inherits: everything that reaches it, nothing (`false` - also the barrier: nothing flows past a record that inherits nothing), or exactly the named records (bypassing barriers). Full story: [Models - Matching](models.md#which-record-applies) |
| `"_fim_template": "...{prefix}...{suffix}..."` | `models.parameters` | The fill-in-the-middle prompt for [inline completions](getting-started.md#get-inline-completions-from-a-litellm-model) on backends with no native handling of one: `{prefix}` and `{suffix}` are replaced with the text around your cursor, and the request carries the built prompt with no separate `suffix` field. A value missing either placeholder is ignored and the native prompt-and-suffix body is used. Inline completions are the only requests it shapes, and it is the only `models.parameters` field that reaches them - chat ignores it |

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "*": { "context_length": 128000, "_fallback": ["context_length"] },  // fill-in default, server wins when it reports
  "my-gw-r1": { "_openrouter_model": "deepseek/deepseek-r1" }          // borrow the catalog's data for this ID
},
"litellm-vscode-chat.models.parameters": {
  "*":      { "top_p": 0.9, "_inheritable": true },                    // inherited by every model unless it opts out
  "gpt-5*": { "temperature": 0.2, "_force": ["temperature"] }          // even chat tools cannot raise it
}
```

## Appearance

`ui.theme` and `ui.accent` decide how the dashboard looks. Two things are worth knowing:

- **High contrast always wins.** Under a VS Code high contrast theme, both settings go inert and the dashboard follows the editor exactly as `auto` does. A high contrast theme is an accessibility choice, and an appearance preference does not get to overrule it.
- **`auto` follows any theme; forcing one uses ours.** Under `auto` the dashboard reads your editor's own colors, so it belongs inside Solarized, Monokai or anything hand-rolled. Forcing `light` or `dark` swaps in our palette (VS Code's own Light Modern and Dark Modern), which is what makes the dashboard hold still while the editor changes.

Under `blue`, the accent follows your theme's button color, so an untouched install looks exactly as it always did. The other three are fixed hues, tuned per theme so they carry on a light surface as well as a dark one.

## Prompt caching

On models whose LiteLLM model info advertises prompt-caching support (currently Anthropic Claude models), the extension spends Anthropic's four cache breakpoints per request on the parts that stay identical across the turns of an agent session: the last tool definition, the system prompt, the first user message, and the last text-bearing message. Each turn then reuses the previous turn's cached prefix instead of re-paying full input price for tools and history - the savings show most in agent mode.

Two limits: the markers are the provider's ephemeral cache markers (Anthropic's default lifetime, about 5 minutes; the extension cannot extend it), and models without declared support are never sent markers. Set `chat.promptCaching` to `false` to turn the feature off.

## Renamed and removed settings

The one-time upgrade migration handles all of these automatically:

| Old | New |
|---|---|
| `requestTimeout` | `chat.timeout` |
| `promptCaching.enabled` | `chat.promptCaching` |
| `discoveryTimeout` | `discovery.timeout` |
| `discoveryCacheTtl` | `discovery.cacheTtl` |
| `modelParameters` | `models.parameters` |
| `modelCapabilities` | `models.capabilities` |
| `openRouterCatalog.enabled` | `models.openRouterCatalog` |
| `headers` (global) | each server entry's `headers`; copied into every declared entry, and the old value is parked behind a dashboard hint (see the scope notes below) |
| `maskApiKeyInput` | `ui.maskSecretInputs` |
| server entry flat fields (`apiKey`, `oauth*`, `virtualKey*`, ...) | the entry's `auth` / `models` / `discovery` objects ([Servers](servers.md#entry-reference)) |
| record keys as implicit prefixes | explicit matchers - `*` appended to existing keys ([Models - Matching](models.md#model-matching)) |
| server-URL-scoped keys in global records | moved into the matching server entry; unmatched ones left inert with a dashboard hint |
| `modelCapabilities` `_declare` directive | the entry's `discovery.declared` list ([Servers](servers.md#declared-models)) |
| `defaultContextLength`, `defaultMaxOutputTokens` | a `models.capabilities` `"*"` record with `_fallback` ([details](models.md#migrated-from-the-removed-default-settings)) |
| `defaultMaxInputTokens` | a `models.capabilities` `"*"` override |

Five scope and edge notes on the migration:

- The old global `headers` applied to every server - declared entries and [externally managed groups](servers.md#external-servers-and-adoption) alike. The new per-entry `headers` cannot reach a server that has no entry, so the migration copies the value into your declared entries only and parks the original; while an externally managed group exists, the dashboard's diagnostics point out that it no longer receives those headers - [adopting](servers.md#external-servers-and-adoption) the group into an entry is how they come back.

- One Settings Sync caveat: when another machine upgrades first, sync delivers the new-name records (and the old keys' deletion) before this machine migrates. The migration then keeps the synced value and drops the old record unprocessed - including any server-URL-scoped keys it held, whose destinations are this machine's own machine-scoped entries; the first machine consumed them into *its* entries, so here they are dropped rather than moved. On a multi-machine setup, copy URL-scoped keys into the matching server entries before upgrading the remaining machines.
- It rewrites user settings only. An old name set at workspace scope (a committed `.vscode/settings.json`, say) is left in place - counted in the log, never rewritten - and since the extension no longer reads the old names, it has no effect until you move it to the new name by hand.
- Stored secrets stay put: the entry restructure changes only settings text - secret-storage values keep their keys, and nothing needs re-entering.
- Afterwards the old names are ordinary unknown keys: VS Code's settings editor flags them and the extension ignores them, so a stray leftover is noise, not behavior.
