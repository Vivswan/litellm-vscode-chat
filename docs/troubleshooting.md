# Troubleshooting

English | [简体中文](zh-cn/troubleshooting.md) | [繁體中文](zh-tw/troubleshooting.md)

This page is indexed by symptom: find what you are seeing, and each entry says what it means, how to fix it, and where the full story lives. The extension puts its state where you can see it - a status bar item for the connection, one for usage, the dashboard's Diagnostics section for details, and an output channel for the full log - so start there when nothing below matches.

## Status bar

Two items sit in the bottom-right corner. The left one is the **connection item** - it answers "can I chat right now?":

| Item | Status | Meaning |
|------|--------|---------|
| `$(warning) LiteLLM` | Not Configured | No servers configured - click to set up |
| `$(loading~spin) LiteLLM` | Loading | Fetching models from servers |
| `$(check) LiteLLM` | Connected | All servers reachable; the tooltip carries the model count |
| `$(warning) LiteLLM` | Degraded | Some servers failing (unreachable, or their provider-group sync failed); the tooltip says how many models are still available |
| `$(error) LiteLLM` | Error | All servers failed - the Diagnostics section has each server's error |

Clicking it opens the [dashboard](dashboard.md); the Diagnostics section has the per-server detail.

Next to it, the **usage item** answers "how close am I to a budget?" - a spend percentage for the worst server:

| It shows | Meaning |
|----------|---------|
| a plain percentage, e.g. `42%` | every server is under its alert thresholds |
| the percentage on a warning background | some server crossed the lowest threshold (default 80%) |
| the percentage on an error background | some server crossed the highest threshold (default 95%) |
| nothing | no budget data is fresh (the connection item already signals outages), usage features do not apply to your servers, or `usage.statusBar` hides it |

Clicking it opens the dashboard's [Servers page](dashboard.md#usage-on-the-servers-page), where each row carries its spend. How budgets, thresholds, and polling fit together is on the [Usage](usage.md#the-status-bar) page. (With a single configured threshold, that threshold is both the lowest and the highest, so crossing it goes straight to the error background.)

So: **red on the left** means requests cannot get through - work through [Common issues](#common-issues) below. **Red on the right** means requests get through fine but a budget is nearly spent - see [Usage: alerts](usage.md#alerts).

## Diagnostic tools

| Tool | What it gives you |
|------|-------------------|
| "LiteLLM: Test Connection" (Command Palette) | Verifies a server end to end: connects, reports the number of models found, shows detailed error messages on failure, and updates the status bar. The dashboard's Test connection button does the same for a draft entry before you save it |
| "LiteLLM: Show Diagnostics" | Opens the dashboard on its Diagnostics section: the overall status, the configured-server count, the last check timestamp, and one outcome line per server with its URL |
| The "LiteLLM" output channel | The full log: configuration changes, model fetch attempts and results, and errors with full details. Open the Output panel (`Ctrl+Shift+U` / `Cmd+Shift+U`) and select "LiteLLM" from the dropdown |
| The dashboard's inspectors | Per model, which source set every parameter and capability field - the tool for "why is this value what it is" questions ([Models: inspectors](models.md#inspectors)) |
| "LiteLLM: Help & Feedback" | Shortcuts for reporting bugs, requesting features, or opening the documentation |

## Common issues

### "The chat interface or 'Manage Models...' is missing"

This extension plugs into GitHub Copilot Chat; without it there is no chat view and no model picker.

- Install the GitHub Copilot Chat extension, sign in to GitHub, and make sure it is enabled.
- On an older VS Code, update it: the extension needs 1.129.0 or higher.
- In a window in Restricted Mode (an untrusted folder), VS Code disables this extension entirely: the LiteLLM commands, the status bar item, and the registered models all disappear until you trust the workspace.

### "Connection Error: Unable to connect"

Nothing answered at the base URL.

- Verify the base URL is correct (e.g., `http://localhost:4000`) and your LiteLLM proxy is running.
- A host under `.localhost` (like `http://www.localhost:8001`) usually does not resolve - use plain `localhost` (`http://localhost:8001`); the error suggests the corrected URL.
- A URL ending in `/v1` is fine: the extension appends `/v1` only when the URL does not already end in a version segment (like `/v1` or `/v2`); the per-server `apiVersion` field overrides both (empty string = append nothing).
- Check firewall, VPN, or proxy settings between VS Code and the server.

The [entry reference](servers.md#entry-reference) documents the base URL rules.

### "SSL Certificate Error"

VS Code could not establish a trusted HTTPS connection to the base URL; the extension has no setting to bypass certificate validation.

- "The SSL certificate for ... has expired": ask your LiteLLM server administrator to renew the certificate.
- Any other certificate problem reads "The server's SSL certificate couldn't be verified, so the connection was blocked", with a detail line (`SSL certificate error for ...`) naming the server and the TLS failure - a self-signed or internal-CA certificate, common on corporate deployments: add the CA to your operating system's trust store, or launch VS Code with `NODE_EXTRA_CA_CERTS` pointing at the CA bundle. The trust decision belongs to VS Code's runtime, not this extension.

### "Authentication failed"

The two 401 messages name different credentials:

- Plain **"Authentication failed: Your LiteLLM server requires an API key"** means the proxy rejected the extension's credential. Edit the server (dashboard, or the `servers` setting) and update it; verify the key against your LiteLLM proxy configuration. For an [external group](servers.md#external-servers-and-adoption) with no entry, the credential is owned by VS Code - update it through the model picker's "Manage LiteLLM Provider" flow, or adopt the group.
- **"Authentication failed upstream"** means the proxy accepted your key but could not authenticate to the model's upstream provider; updating the extension's key cannot help. Fix that provider's credentials on the LiteLLM server, or ask whoever runs it to.

Two setup mistakes look like auth failures:

- An entry whose `auth` object carries an ambiguous shape (say, `apiKey` and `oauth` side by side) is treated as misconfigured, and the dashboard's server row says so; no guessing between credentials happens. Keep exactly one form - a gateway that really checks two credentials at once wants the second one as a lower-ranked companion (inside `auth.oauth`, or a `virtualKey` beside `auth.apiKey`). See [Servers: authentication](servers.md#authentication).
- A gateway that expects the key in a custom header (e.g. `x-litellm-api-key`) rejects the standard bearer form; use `auth.virtualKey` with the header name it wants.

### "The server did not recognize this request" / "answered 404 - it responded, but does not serve the LiteLLM API"

Something answered at that address, but not a LiteLLM proxy - or not with this model. On a chat request the error shows the headline above with a detail line underneath (`Details: LiteLLM 404 ...`) that quotes what the server said.

- Check what is actually listening there - a web server, another service, or the wrong port (the LiteLLM proxy's default is 4000).
- A base URL ending in a version segment (like `/v1` or `/v2`) is used as-is; otherwise the extension appends `/v1`. A 404 therefore means the address is wrong some other way: a different path prefix, the wrong port, or a server that does not speak the LiteLLM API. The per-server `apiVersion` field forces a specific segment (empty string = append nothing).
- A 404 on a chat request from a previously working server usually means the model was removed from the proxy: run "LiteLLM: Sync Models Now" to refresh the model list. If every request fails with 404, check the base URL as above.

### Pointing at Ollama, vLLM, or plain OpenAI-compatible servers

The extension is built for LiteLLM proxies, so discovery asks for LiteLLM's `/v1/model/info` first (capabilities, pricing) and falls back to the plain OpenAI `/v1/models` listing. Servers that speak only part of that surface work - they just need the missing endpoint declared, so its failure stops counting as a problem. A declared endpoint still gets one probe per sync (a hanging one waits out `discovery.timeout` once), so lower that setting too if syncs feel slow. Three patterns:

- **No `/v1/model/info` (Ollama, vLLM, LM Studio, most OpenAI-compatible servers).** Models still appear through the fallback, but every fresh discovery pass pays for the doomed model-info probe first - on Ollama the request hangs until the discovery timeout, so raising `discovery.timeout` only makes it worse. The dashboard's server row says "its model-info probe never answers and waits out the discovery timeout on every sync. Declaring the failure expected marks that as normal for this server." (or names the missing endpoint, when the server answers 404/405 instead of hanging); its "Declare expected failure" button writes the declaration, or add it by hand:

```jsonc
"litellm-vscode-chat.servers": [
  {
    "label": "Ollama",
    "baseUrl": "http://localhost:11434",
    "discovery": { "expectedFailures": ["modelInfo"] }
  }
]
```

- **No `/v1/models` either, or no listing at all.** When the listing fails but the server otherwise answers, the error suggests the symmetric declaration - "The models listing failed, but this server answers. If it never serves the models listing, declare that on the ... entry" - and the server row offers the same one-click "Declare expected failure". Declare `"modelListing"` (or both categories) and name the models yourself in `discovery.declared`; the full recipe is at [Servers: discovery and expected failures](servers.md#discovery-and-expected-failures):

```jsonc
{
  "label": "my-gateway",
  "baseUrl": "https://gateway.example.com",
  "discovery": {
    "expectedFailures": ["modelListing", "modelInfo"],
    "declared": ["gpt-5", "deepseek-r1"]
  }
}
```

- **Neither endpoint is served.** When both endpoints time out, the error reads "Neither discovery endpoint answered at ... - this address does not look like a LiteLLM or OpenAI-compatible API"; when both answer that they do not serve the path, it reads "This server does not serve either discovery endpoint at ..." (a 404 on the models listing keeps the dedicated 404 message above instead). No declaration helps here: check the base URL and port (a LiteLLM proxy defaults to 4000, Ollama to 11434), and see the [404 entry above](#the-server-did-not-recognize-this-request--answered-404---it-responded-but-does-not-serve-the-litellm-api) for how the URL is resolved.

What a declaration changes, exactly: the named endpoint gets a single attempt per pass (no retries) and its failure is logged as expected instead of alarming - for the models listing that also stops the failure counting as an outage; a model-info failure was never one (discovery falls back regardless), so there the declaration mainly quiets the log and retires the dashboard's hint. Nothing else changes. And what you give up without `/v1/model/info` is metadata, not chat: capability and pricing fields do not arrive, so fill important ones through [`models.capabilities`](models.md#capabilities) (the OpenRouter catalog backfills well-known IDs automatically). The alternative that restores full metadata - and multi-provider routing - is running a LiteLLM proxy in front of the server and pointing the extension at that; [LiteLLM's own docs](https://docs.litellm.ai/docs/providers/ollama) cover fronting Ollama and friends.

### No models appear in the model picker

Check the status bar first - it names the failure class.

- The connection item shows an error or degraded state: discovery is failing; run "LiteLLM: Test Connection" and read the exact error, then match it to the entries above.
- Everything shows connected but a recently added model is missing: the discovered list is cached (`discovery.cacheTtl`, default 1 hour). Run "LiteLLM: Sync Models Now" to bypass the cache.
- The gateway cannot list models at all (no `/v1/models`): declare them on the entry with `discovery.declared`, and add `discovery.expectedFailures` beside it so the missing endpoints stop counting as an outage. Recipe: [Servers: declared models](servers.md#declared-models).
- A warning icon on models you did see before means a background refresh failed and the extension is serving the last known list flagged stale - see [Timeouts and retries](#timeouts-and-retries).
- Everything shows connected, yet nothing appears under your server's label, and your Copilot seat comes from an organization (Copilot Business or Enterprise): the organization's "Bring your own language model key" policy is disabled. The hiding happens inside Copilot, so the extension's own diagnostics all report success; ask your Copilot administrator to enable the policy, then reload VS Code.

### "The server answered but listed no models"

Your LiteLLM proxy is reachable but has no models configured (the log line reads `Servers returned 0 models`).

- Check your LiteLLM proxy configuration (`litellm_config.yaml`).
- Run `litellm --config your_config.yaml` to start the proxy with models.

### "My embedding or image-generation model is missing from the picker"

Models whose LiteLLM `model_info.mode` names a non-chat endpoint (`embedding`, `image_generation`, `audio_speech`, `audio_transcription`, `rerank`, `moderation`) are left out of the chat picker on purpose, since a chat request to them can only fail; models with no declared mode always register. Deployments the proxy has paused (`model_info.blocked`) are skipped too. See [Models: how models appear](models.md#how-models-appear).

### "A model will not take images, or never uses tools"

Capabilities gate what is offered and sent: images go only to models that declare vision support, tool-using requests only to models that declare tool calling. When a capable model's server-side declaration is missing or wrong, override it:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "qwen2.5-vl-72b": { "supports_vision": true }
}
```

On models without vision support the text still goes through and the images are dropped, with a note in the "LiteLLM" output channel. For well-known model IDs the OpenRouter catalog often fills these gaps automatically. See [Models: capabilities](models.md#capabilities).

### "This conversation looks too long for the model"

The extension rejects a request before sending it when its own token estimate exceeds the model's input budget; the detail line under the headline reads `Details: token limit exceeded before send: local estimate N tokens (messages + tools), input limit M`. The count is a local estimate (roughly four characters per token for text, flat figures per image, PDF, or audio clip), so it can differ from what the server would bill.

- Trim the conversation or drop attachments, or
- raise the budget when the real model takes more than the limit `M` says. The limit comes from the model's declared input limit (server report, catalog, or your overrides); correct it in `models.capabilities`:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "my-model": { "max_input_tokens": 100000 }   // or fix context_length
}
```

The key matches exactly; use `"*"` to set a floor for every model. (Older versions had `defaultContextLength` / `defaultMaxInputTokens` / `defaultMaxOutputTokens` settings for this; they are gone, migrated into a `"*"` record automatically.) See [Models: capabilities](models.md#capabilities).

### "A parameter I configured is not taking effect"

Do not guess - open the dashboard's Models section and check the model's parameters [inspector](models.md#inspectors): it shows every effective field and exactly which source set it. What it usually reveals:

- **The key does not match.** Keys are exact by default: `"gpt-5"` matches only `gpt-5`, not `gpt-5-turbo`. Family keys need the trailing `*`. See [model matching](models.md#model-matching).
- **A regex key anchors to the whole ID.** `"/gpt-5/"` matches only the literal ID `gpt-5`, not `my-gpt-5-deployment` - slash-wrapped patterns must match the entire model ID, not a substring of it. For a contains-match, write `"/.*gpt-5.*/"`. An invalid pattern (or any flag other than `i`) is reported in the dashboard and the key is ignored.
- **A broader key is not flowing in.** By default the most specific matching record wins wholesale - a `"*"` or `"gpt-5*"` value reaches a more specific match only when marked `_inheritable` (and no `_inherit_from: false` barrier sits between); a server entry's record beats the global setting field by field. Check the inheritance tree in the Diagnostics section, then see [Models - matching](models.md#which-record-applies).
- **Runtime options outrank you.** Options passed at request time (by Copilot or a chat tool) and the [picker's per-model configuration](models.md#the-picker) beat configured records. To pin a field regardless, mark it forced: `"gpt-5*": { "_force": ["temperature"], "temperature": 1 }`. See [Models: parameters](models.md#parameters).
- **Even a forced field needs its record to apply.** `_force` beats runtime options only when the record carrying it takes part in the model's resolution: when a more specific record wins and does not inherit the forced field, the force never reaches the request - the Diagnostics tree shows where it stopped. And provider-owned keys (`model`, `messages`, `stream`, ...) cannot be forced at all; such a `_force` is reported and ignored.
- **The entry's records may be inactive.** If the server's dashboard row says the entry's per-server configuration may not be applying, see [below](#per-server-model-parameters-are-inactive).

### "The model produced only reasoning output, which this version of VS Code could not display"

Your VS Code build lacks the thinking-part API, so streamed reasoning is dropped (with a note in the output channel), and a reply that contained nothing but reasoning fails with this error. Update VS Code to a version that supports thinking parts, or use a model that returns final text.

## Usage features are missing

The dashboard's server rows show no spend, no spend percentage appears, and no alerts fire. In likelihood order:

- **The server runs without a database.** LiteLLM serves spend data (`/key/info`) only when backed by a database; without one, the extension detects that once and hides all usage features for that server - an empty spend cell, by design, nothing to configure. Verify from a terminal: `curl -H "Authorization: Bearer sk-..." https://your-gateway/key/info` - an error page instead of JSON confirms it. If you add a database later, background polls will not notice on their own: run "LiteLLM: Refresh Usage Now" to re-check.
- **The key cannot read usage data.** A database-backed server that answers 401 or 403 on the usage endpoints shows no numbers, but it is not hidden: its row on the dashboard's Servers page carries a problem line reading "Usage is unavailable ...: this key isn't allowed to read its usage." with a detail naming the endpoint and status. The curl above then returns 401 or 403 instead of an error page; ask whoever issued the key to allow it to read its own `/key/info`, then use Refresh now - the extension does not re-check on its own.
- **Polling is off.** `usage.pollInterval: 0` disables background polling; the dashboard fetches on open only when a fetch is due (no completed fetch this session, the last one older than five minutes, or a changed `servers` setting - [the open cooldown](usage.md#the-usage-panel)), no alerts fire, and the status bar item shows on-demand data for ten minutes after a fetch, then hides. Run "LiteLLM: Refresh Usage Now" for an immediate fetch - it always re-lights the item.
- **Alerts are off.** An empty `usage.alertThresholds` list means no thresholds, so no alert notifications ever fire, and `"alerts-only"` status bar mode shows only when a server is over its whole budget (past 100% is the error tone regardless of thresholds).
- **The item is configured away.** `usage.statusBar: "off"` hides the item; `"alerts-only"` shows it only when a threshold is crossed or a budget is exceeded.
- **No budget anywhere.** Percentages need a budget: either the key's own LiteLLM `max_budget` or the entry's `budget` field. See [Usage: budgets](usage.md#budgets).

A related partial case: **spend shows, but no request counts**. The drawer's request count, success rate, and cache hit rate come from a second endpoint (`/user/daily/activity`); when the server does not serve it - or refuses it for your key - the open row shows spend and budget alone, with the reason stated in place of the missing numbers. Availability is detected per endpoint, so this is a normal shape on some setups, not an error.

The full feature is described on the [Usage](usage.md#the-usage-panel) page; the settings and their defaults are in the [reference](settings.md#reference).

## Timeouts and retries

What the two timeout settings bound, and what retries when:

- **Chat completions are never retried.** A completion may have side effects (spend, tool calls), so the extension surfaces a failure instead of silently paying for a second attempt. `chat.timeout` (default 5 minutes) is therefore the total time one request may take, streaming included; raise it if long reasoning runs get cut off.
- **Discovery retries.** Model discovery requests are idempotent GETs, retried up to twice on transient failures, with `discovery.timeout` (default 30 seconds) a hard bound on each request, retries included - per request, not per pass: the model-info listing, the `/v1/models` fallback, and any OAuth token exchange each get a fresh budget, so a pass may take up to their sum. Raise it for slow gateway infrastructure or a slow OAuth identity provider - the exchange spends its own budget, not the listing's - and the exchange is bounded by `discovery.timeout` on chat requests as well.
- **Expected failures do not retry.** An endpoint named in the entry's `discovery.expectedFailures` gets a single attempt and an info-level log line instead of a red error ([Servers](servers.md#entry-reference)).
- **Minimums.** Both timeouts clamp to at least 1000 ms.
- **The stale-list grace.** When a background refresh fails but the last successful discovery is within `discovery.staleServeWindow` (default ten minutes), the extension keeps serving the last known model list, flagged stale with a warning icon, instead of dropping your models mid-session. Raise the window for a server that sleeps longer; `0` turns the grace off.

Defaults and units for the settings are in the [reference](settings.md#reference).

## A slow or hammered server

VS Code re-resolves model providers often - sometimes several times per second - and `discovery.cacheTtl` (default 1 hour) is what keeps that from becoming a request storm on your gateway. If your server logs show the extension hitting `/v1/models` constantly, someone set the TTL to `0` (fetch fresh every time); raise it. The cache never stores failures, simultaneous refreshes share one request, and "LiteLLM: Sync Models Now" bypasses it on demand, so a long TTL costs you nothing but a manual sync after server-side model changes.

## Settings Sync surprises

- **"My servers did not follow me to a new machine."** By design: the `servers` setting is machine-scoped and Settings Sync never carries it, and secret storage does not sync either - servers and credentials stay on the machine where you entered them. Re-add them on the new machine. See [Servers: multiple machines](servers.md#multiple-machines-and-settings-sync).
- **"A fresh machine has my model settings, but no models."** The flip side of the same rule: Settings Sync delivers every global setting - `models.parameters`, `models.capabilities`, usage thresholds - but no `servers`, so there is nothing yet for the records to apply to. Re-add the servers and the synced records take effect on their own as matching models register. Anything that lives on an entry (credentials, per-server records, headers, the `budget` field) needs re-entering with it.
- **"A workspace cannot change my servers."** Also by design: `servers` accepts user-settings values only, so a cloned repository can never re-point your label at another host.
- **"Where should a credential live, then?"** In a server entry - and only there. The entry's [`auth` forms](servers.md#authentication) (which can use secret storage) and its per-entry `headers` object are both machine-scoped, so a key can neither replicate through Settings Sync nor land in a committed `.vscode/settings.json`. Every non-server setting (`models.parameters`, timeouts, usage thresholds) syncs normally and carries nothing credential-like.

## Leftover groups after removing or renaming a server

VS Code's provider-group API can create groups but never update or remove them, so removing a `servers` entry hides its group (the models leave the picker immediately) rather than deleting it, and renaming an entry leaves the old group behind as an "external" row. The permanent fix is always the same:

1. Open the models file - the notice's button, or `<profile>/User/chatLanguageModels.json` by hand.
2. Delete the named group's object from the JSON array. Quit or reload VS Code first if editing by hand: it holds the file in memory and can overwrite external edits.
3. Reload the window and run "LiteLLM: Sync Models Now".

A hidden group returns on its own when you re-add an entry with the same label and base URL, or through the dashboard's hidden-groups Unhide action. On a VS Code build in a language other than English, the extension may not recognize the host's name-conflict answer: the server row then shows a generic sync failure retried on every pass instead of the single actionable "provider group already uses this name" state - the fix is the same three steps. The full lifecycle - what each operation leaves behind and why - is at [Servers: lifecycle](servers.md#lifecycle-renames-removals-hidden-groups); external rows and adoption are [covered there too](servers.md#external-servers-and-adoption).

## Per-server model parameters are inactive

The dashboard puts a diagnostic line under a server's row - "may not be applying its per-server model parameters" - when the entry carries per-entry `models.parameters` but the VS Code provider group serving that server may not carry the entry's labeled identity. That happens when the group predates entry labels, or when a rename or base URL edit left a stale group behind; requests through such a group may get only the global `models.parameters` setting. The same line names every other affected surface too: an entry's `models.capabilities`, `discovery.declared`, and `discovery.expectedFailures`, its custom `headers`, and its `apiVersion` override (requests fall back to the auto rule); all have the same fixes.

Two ways to fix it:

- Delete the group's object from the models file (`<profile>/User/chatLanguageModels.json`), reload the window, and run "LiteLLM: Sync Models Now"; the extension recreates the group from the entry, this time carrying its identity.
- Or save the entry under a new label; a new group is created for it. The old group stays until you delete its object from the models file.

## Secret storage is unavailable

Two server-row messages mean VS Code's secret storage, not your server, is the problem:

- **"Reading this entry's stored secrets failed, so it was not synced. Run Sync Models Now to retry."** The read failed this pass; the entry is skipped, not failed permanently - the next pass (or "LiteLLM: Sync Models Now") reads again.
- **"VS Code secret storage could not be confirmed this session, so this entry was not synced. Syncing resumes on the next VS Code session."** The extension could not confirm its sync state would survive the session, so it syncs nothing rather than guess.

In both states the entry is only skipped for the pass: its live provider group keeps serving the last synced models, and nothing is lost. The usual cause is the operating system's keychain or keyring being unavailable - on Linux, a desktop session without a keyring service (gnome-keyring, KWallet) is the common case. Restore the keyring, restart VS Code, and run "LiteLLM: Sync Models Now".

## Settings from an older version

If a setting seems to have vanished after an upgrade, it was renamed or restructured: a one-time migration moves everything automatically - setting names into their new sections (`requestTimeout` to `chat.timeout`, `modelParameters` to `models.parameters`, and so on), flat server entries into the `auth`/`models`/`discovery` shape, the `default*` token settings into a `models.capabilities` `"*"` record, the `_declare` directive into the entry's `discovery.declared` list, and the old global `headers` setting into each entry's own `headers` object (a copy no entry can receive is left in place, inert, with a dashboard hint). Nothing needs re-entering; the [rename table](settings.md#renamed-and-removed-settings) maps every old name to its new home.

Two migration effects worth knowing when a matcher stops matching:

- Record keys used to be implicit prefixes; the migration appended `*` to every existing key, so old keys match exactly what they matched before. Only keys you write from now on are exact by default ([model matching](models.md#model-matching)).
- Server-URL-scoped keys in the global records moved into the matching server entry. A scoped key whose URL matches no entry is left in place - inert, since it can never match a model ID - and the dashboard flags it with a hint to move it into a server entry.

## Reporting an issue

The Report Issue action opens a GitHub issue prefilled with diagnostics:

- extension and VS Code versions, platform, and connection state
- whether an API key and base URL are configured: yes, no, or unknown when VS Code manages the credentials; never the values themselves
- the most recent error, and recent log lines

The extension's logs record classifications of what happened, never text derived from server responses, so the prefilled body cannot leak your prompts, completions, or credentials; still, the issue opens in your browser for review before you submit anything. When the diagnostics are too large for a URL, the full text goes to your clipboard (and a local file, when possible) instead, and the issue body says what was omitted.

## Privacy and data

Your prompts, attachments, and completions travel only between VS Code and the endpoints you configure:

- Chat and model-discovery requests go to your LiteLLM servers' base URLs.
- Commit message generation, on your explicit invocation only, sends the staged diff - or, when nothing is staged, the working-tree diff plus the paths of untracked files, never their contents - and your last five commit subjects to the LiteLLM server you configured for it ([Getting started](getting-started.md#generate-commit-messages-with-your-own-model)).
- Inline completions, while enabled with a model chosen, send the file content around your cursor (at most 8000 characters before it and 4000 after) to the LiteLLM server you configured for them, automatically as you type; the dashboard's "Test model" button sends one small fixed code snippet, never your files ([Getting started](getting-started.md#get-inline-completions-from-a-litellm-model)).
- The consult tool, while enabled with a model chosen, sends the question and background text a chat agent writes to the LiteLLM server you configured for it - on the agent's own initiative once you enable it, not on a per-request action from you. Nothing is attached automatically, but the agent is instructed to include the code and errors its question depends on, so workspace content it has read can travel in that text; what goes is the agent's choice, not a fixed set. The dashboard's "Test model" button sends one small fixed question instead ([Getting started](getting-started.md#let-an-agent-ask-a-second-model)).
- OAuth credentials go only to the token endpoint set on the server entry.
- One default-on exception: about once a week the extension refreshes its bundled OpenRouter model catalog from `https://openrouter.ai/api/v1/models` - a public, unauthenticated model list; the request carries no prompts, no usage, and nothing about you or your servers. Set `litellm-vscode-chat.models.openRouterCatalog` to `false` to stop all catalog network ([Models: capabilities](models.md#capabilities)).
- Usage polling calls only your own servers' spend endpoints, with the entry's own credentials.
- The extension has no telemetry and no backend of its own; nothing is sent to the publisher.
- The one other outbound surface is the [issue reporter](#reporting-an-issue), which prepares everything locally, carries environment details and the extension's own logs (versions, platform, connection state, error classifications and stacks - never prompt or response text, never key values), and opens in your browser for review before anything is submitted.

Where credentials are stored, and what syncs between machines, is covered in [Servers](servers.md#secrets-and-secret-storage).

## Uninstalling and cleanup

Uninstalling the extension does not remove two things, so clean them up first if you care about leftover credentials:

- Your `litellm-vscode-chat.*` settings stay in settings.json, including any inline credentials in the `servers` entries - the [`auth` objects](servers.md#authentication) and any per-entry `headers`. Remove them in the Settings editor or delete the lines from user settings.json.
- The VS Code provider groups the servers were synced to are host-owned and keep their own copies of the credentials until you remove them: delete their objects from `<profile>/User/chatLanguageModels.json` (quit or reload VS Code afterward).

Secrets kept in VS Code secret storage can be removed while the extension is still installed, through the edit form's "Remove the stored ..." checkboxes ([Servers](servers.md#secrets-and-secret-storage)); after uninstall, that storage belongs to VS Code's extension-data handling and is no longer reachable from the extension's own UI.
