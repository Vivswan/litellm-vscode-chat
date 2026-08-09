# Troubleshooting

English | [简体中文](zh-cn/troubleshooting.md) | [繁體中文](zh-tw/troubleshooting.md)

This page is indexed by symptom: find what you are seeing, and each entry says what it means, how to fix it, and where the full story lives. The extension puts its state where you can see it - a status bar item for the connection, one for usage, the dashboard's Diagnostics tab for details, and an output channel for the full log - so start there when nothing below matches.

## Status bar

Two items sit in the bottom-right corner. The left one is the **connection item** - it answers "can I chat right now?":

| Item | Status | Meaning |
|------|--------|---------|
| `$(warning) LiteLLM` | Not Configured | No servers configured - click to set up |
| `$(loading~spin) LiteLLM` | Loading | Fetching models from servers |
| `$(check) LiteLLM` | Connected | All servers reachable; the tooltip carries the model count |
| `$(warning) LiteLLM` | Degraded | Some servers unreachable; the tooltip says how many models the reachable ones serve |
| `$(error) LiteLLM` | Error | All servers failed - the Diagnostics tab has each server's error |

Clicking it opens the [dashboard](dashboard.md); the Diagnostics tab has the per-server detail.

Next to it, the **usage item** answers "how close am I to a budget?" - a spend percentage for the worst server:

| It shows | Meaning |
|----------|---------|
| a plain percentage, e.g. `42%` | every server is under its alert thresholds |
| the percentage on a warning background | some server crossed the lowest threshold (default 80%) |
| the percentage on an error background | some server crossed the highest threshold (default 95%) |
| nothing | no budget data is fresh (the connection item already signals outages), usage features do not apply to your servers, or `usage.statusBar` hides it |

Clicking it opens the dashboard's [Usage section](dashboard.md#the-usage-section). How budgets, thresholds, and polling fit together is on the [Usage](usage.md#the-status-bar) page. (With a single configured threshold, that threshold is both the lowest and the highest, so crossing it goes straight to the error background.)

So: **red on the left** means requests cannot get through - work through [Common issues](#common-issues) below. **Red on the right** means requests get through fine but a budget is nearly spent - see [Usage: alerts](usage.md#alerts).

## Diagnostic tools

| Tool | What it gives you |
|------|-------------------|
| "LiteLLM: Test Connection" (Command Palette) | Verifies a server end to end: connects, reports the number of models found, shows detailed error messages on failure, and updates the status bar. The dashboard's Test connection button does the same for a draft entry before you save it |
| "LiteLLM: Show Diagnostics" | Opens the dashboard on its Diagnostics tab: the overall status, the configured-server count, the last check timestamp, and one outcome line per server with its URL |
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
- If you pasted a URL ending in `/v1`, remove that suffix: the extension appends `/v1` itself, so a `/v1` base URL requests `/v1/v1/...` and fails.
- Check firewall, VPN, or proxy settings between VS Code and the server.

The [entry reference](servers.md#entry-reference) documents the base URL rules.

### "SSL Certificate Error"

VS Code could not establish a trusted HTTPS connection to the base URL; the extension has no setting to bypass certificate validation.

- "The SSL certificate for ... has expired": ask your LiteLLM server administrator to renew the certificate.
- Any other certificate problem reads "The server's SSL certificate couldn't be verified, so the connection was blocked", with a detail line starting `SSL certificate error for ...` naming the server and the TLS failure - a self-signed or internal-CA certificate, common on corporate deployments: add the CA to your operating system's trust store, or launch VS Code with `NODE_EXTRA_CA_CERTS` pointing at the CA bundle. The trust decision belongs to VS Code's runtime, not this extension.

### "Authentication failed"

The two 401 messages name different credentials:

- Plain **"Authentication failed: Your LiteLLM server requires an API key"** means the proxy rejected the extension's credential. Edit the server (dashboard, or the `servers` setting) and update it; verify the key against your LiteLLM proxy configuration. For an [external group](servers.md#external-servers-and-adoption) with no entry, the credential is owned by VS Code - update it through the model picker's "Manage LiteLLM Provider" flow, or adopt the group.
- **"Authentication failed upstream"** means the proxy accepted your key but could not authenticate to the model's upstream provider; updating the extension's key cannot help. Fix that provider's credentials on the LiteLLM server, or ask whoever runs it to.

Two setup mistakes look like auth failures:

- An entry whose `auth` object carries an ambiguous shape (say, `apiKey` and `oauth` side by side) is treated as misconfigured, and the dashboard's server row says so; no guessing between credentials happens. Keep exactly one form - a gateway that really checks two credentials at once wants the second one as a lower-ranked companion (inside `auth.oauth`, or a `virtualKey` beside `auth.apiKey`). See [Servers: authentication](servers.md#authentication).
- A gateway that expects the key in a custom header (e.g. `x-litellm-api-key`) rejects the standard bearer form; use `auth.virtualKey` with the header name it wants.

### "The server did not recognize this request" / "answered 404 - it responded, but does not serve the LiteLLM API"

Something answered at that address, but not a LiteLLM proxy - or not with this model. On a chat request the error shows the headline above with a detail line underneath that starts with `LiteLLM 404` and quotes what the server said.

- Check what is actually listening there - a web server, another service, or the wrong port (the LiteLLM proxy's default is 4000).
- The `/v1` trap applies here too: a base URL ending in `/v1` makes the extension request `/v1/v1/...`, which the proxy answers with 404. Remove the suffix; the extension appends `/v1` itself.
- A 404 on a chat request from a previously working server usually means the model was removed from the proxy: run "LiteLLM: Sync Models Now" to refresh the model list. If every request fails with 404, check the base URL as above.

### No models appear in the model picker

Check the status bar first - it names the failure class.

- The connection item shows an error or degraded state: discovery is failing; run "LiteLLM: Test Connection" and read the exact error, then match it to the entries above.
- Everything shows connected but a recently added model is missing: the discovered list is cached (`discovery.cacheTtl`, default 1 hour). Run "LiteLLM: Sync Models Now" to bypass the cache.
- The gateway cannot list models at all (no `/v1/models`): declare them on the entry with `discovery.declared`, and add `discovery.expectedFailures` beside it so the missing endpoints stop counting as an outage. Recipe: [Servers: declared models](servers.md#declared-models).
- A warning icon on models you did see before means a background refresh failed and the extension is serving the last known list flagged stale - see [Timeouts and retries](#timeouts-and-retries).
- Everything shows connected, yet nothing appears under your server's label, and your Copilot seat comes from an organization (Copilot Business or Enterprise): the organization's "Bring your own language model key" policy is disabled. The hiding happens inside Copilot, so the extension's own diagnostics all report success; ask your Copilot administrator to enable the policy, then reload VS Code.

### "Server returned 0 models"

Your LiteLLM proxy is running but has no models configured.

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

The extension rejects a request before sending it when its own token estimate exceeds the model's input budget; the detail line under the headline reads `token limit exceeded before send: local estimate N tokens (messages + tools), input limit M`. The count is a local estimate (roughly four characters per token for text, flat figures per image, PDF, or audio clip), so it can differ from what the server would bill.

- Trim the conversation or drop attachments, or
- raise the budget when the real model takes more than the limit `M` says. The limit comes from the model's declared input limit (server report, catalog, or your overrides); correct it in `models.capabilities`:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "my-model": { "max_input_tokens": 100000 }   // or fix context_length
}
```

The key matches exactly; use `"*"` to set a floor for every model. (Older versions had `defaultContextLength` / `defaultMaxInputTokens` / `defaultMaxOutputTokens` settings for this; they are gone, migrated into a `"*"` record automatically.) See [Models: capabilities](models.md#capabilities).

### "A parameter I configured is not taking effect"

Do not guess - open the dashboard's Models tab and check the model's parameters [inspector](models.md#inspectors): it shows every effective field and exactly which source set it. What it usually reveals:

- **The key does not match.** Keys are exact by default: `"gpt-5"` matches only `gpt-5`, not `gpt-5-turbo`. Family keys need the trailing `*`. See [model matching](models.md#model-matching).
- **A regex key anchors to the whole ID.** `"/gpt-5/"` matches only the literal ID `gpt-5`, not `my-gpt-5-deployment` - slash-wrapped patterns must match the entire model ID, not a substring of it. For a contains-match, write `"/.*gpt-5.*/"`. An invalid pattern (or any flag other than `i`) is reported in the dashboard and the key is ignored.
- **A broader key is not flowing in.** By default the most specific matching record wins wholesale - a `"*"` or `"gpt-5*"` value reaches a more specific match only when marked `_inheritable` (and no `_inherit_from: false` barrier sits between); a server entry's record beats the global setting field by field. Check the inheritance tree in the Diagnostics tab, then see [Models - matching](models.md#which-record-applies).
- **Runtime options outrank you.** Options passed at request time (by Copilot or a chat tool) and the [picker's per-model configuration](models.md#the-picker) beat configured records. To pin a field regardless, mark it forced: `"gpt-5*": { "_force": ["temperature"], "temperature": 1 }`. See [Models: parameters](models.md#parameters).
- **Even a forced field needs its record to apply.** `_force` beats runtime options only when the record carrying it takes part in the model's resolution: when a more specific record wins and does not inherit the forced field, the force never reaches the request - the Diagnostics tree shows where it stopped. And provider-owned keys (`model`, `messages`, `stream`, ...) cannot be forced at all; such a `_force` is reported and ignored.
- **The entry's records are inactive.** If the dashboard shows a "params inactive" badge on the server, see [below](#per-server-model-parameters-are-inactive).

### "The model produced only reasoning output, which this version of VS Code could not display"

Your VS Code build lacks the thinking-part API, so streamed reasoning is dropped (with a note in the output channel), and a reply that contained nothing but reasoning fails with this error. Update VS Code to a version that supports thinking parts, or use a model that returns final text.

## Usage features are missing

The dashboard has no Usage section for a server, no spend percentage appears, and no alerts fire. In likelihood order:

- **The server runs without a database.** LiteLLM serves spend data (`/key/info`) only when backed by a database; without one, the extension detects that once and hides all usage features for that server - by design, nothing to configure. Verify from a terminal: `curl -H "Authorization: Bearer sk-..." https://your-gateway/key/info` - an error page instead of JSON confirms it. If you add a database later, background polls will not notice on their own: run "LiteLLM: Refresh Usage Now" to re-check.
- **The key cannot read usage data.** A database-backed server that answers 401 or 403 on both usage endpoints hides the usage surfaces exactly like a missing database. The curl above then returns 401 or 403 instead of an error page; ask whoever issued the key to allow it to read its own `/key/info`. A server whose card is already visible says so on the card itself ("This key isn't allowed to read its spend."), with a detail line naming the endpoint and status - the curl is only needed for servers that never appeared.
- **Polling is off.** `usage.pollInterval: 0` disables background polling; the dashboard still fetches when opened, no alerts fire, and the status bar item shows on-demand data for ten minutes after a fetch, then hides. Run "LiteLLM: Refresh Usage Now" for an immediate fetch - it always re-lights the item.
- **Alerts are off.** An empty `usage.alertThresholds` list means no thresholds, so nothing ever fires and `"alerts-only"` status bar mode never shows.
- **The item is configured away.** `usage.statusBar: "off"` hides the item; `"alerts-only"` shows it only when a threshold is crossed.
- **No budget anywhere.** Percentages need a budget: either the key's own LiteLLM `max_budget` or the entry's `budget` field. See [Usage: budgets](usage.md#budgets).

A related partial case: **spend shows, but no request counts**. The card's request count, success rate, and cache hit rate come from a second endpoint (`/user/daily/activity`); when the server does not serve it - or refuses it for your key - the card shows spend and budget alone. Availability is detected per endpoint, so this is a normal shape on some setups, not an error.

The full feature is described on the [Usage](usage.md#the-usage-panel) page; the settings and their defaults are in the [reference](settings.md#reference).

## Timeouts and retries

What the two timeout settings bound, and what retries when:

- **Chat completions are never retried.** A completion may have side effects (spend, tool calls), so the extension surfaces a failure instead of silently paying for a second attempt. `chat.timeout` (default 5 minutes) is therefore the total time one request may take, streaming included; raise it if long reasoning runs get cut off.
- **Discovery retries.** Model discovery requests are idempotent GETs, retried up to twice on transient failures, with the whole pass - retries and any OAuth token exchange included - bounded by `discovery.timeout` (default 30 seconds). Raise it for slow gateway infrastructure; note that a slow OAuth identity provider spends from the same budget, and the exchange is bounded by `discovery.timeout` on chat requests as well.
- **Expected failures do not retry.** An endpoint named in the entry's `discovery.expectedFailures` gets a single attempt and an info-level log line instead of a red error ([Servers](servers.md#entry-reference)).
- **Minimums.** Both timeouts clamp to at least 1000 ms.
- **The stale-list grace.** When a background refresh fails but the last successful discovery is under ten minutes old, the extension keeps serving the last known model list, flagged stale with a warning icon, instead of dropping your models mid-session.

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

The dashboard shows a "params inactive" badge (and a banner naming the affected entries) when a server entry carries per-entry `models.parameters` but the VS Code provider group serving that server does not carry the entry's labeled identity. That happens when the group predates entry labels, or when a rename or base URL edit left a stale group behind; requests through such a group get only the global `models.parameters` setting. The twin "capabilities inactive" badge means the same thing for an entry's `models.capabilities`, `discovery.declared`, and `discovery.expectedFailures`, and an entry's custom `headers` get their own "headers inactive" badge; all have the same fixes.

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
