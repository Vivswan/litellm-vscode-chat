# Servers

English | [简体中文](zh-cn/servers.md) | [繁體中文](zh-tw/servers.md)

The extension connects to any number of LiteLLM servers at once and aggregates their models into one picker list. This page covers everything about a server: declaring it, authenticating to it, shaping its models, its lifecycle inside VS Code, and how its secrets are stored.

## How servers work

Three concepts carry everything else:

- **Entry** - one object in the `litellm-vscode-chat.servers` setting: the declarative truth about a server. The [dashboard](dashboard.md)'s add/edit form writes the same setting, so JSON editing and the form stay in step.
- **Provider group** - what VS Code itself holds for each server (in `<profile>/User/chatLanguageModels.json`, the "models file"). The extension syncs entries to groups automatically, on activation and on every settings change.
- **Identity** - an entry's `label` plus `baseUrl`. The group is named after the label, which is why renames and removals have the lifecycle quirks described [below](#lifecycle-renames-removals-hidden-groups).

The `servers` setting is machine-scoped: it lives in your user settings only, a workspace cannot override it (a cloned repository can never re-point your servers at another host), and Settings Sync does not carry it - servers and credentials stay on the machine where you entered them. To move them to another machine, use ["LiteLLM: Export Settings..."](settings.md#export-and-import), which can carry secret-storage values too.

Entries from older versions (flat `apiKey`, `oauth*`, `virtualKey*`, `modelParameters`, ... fields) are restructured automatically by a one-time migration. Secrets already in secret storage are untouched - the restructure changes only settings text, and nothing needs re-entering.

## Quick start

Minimal - a local proxy without auth:

```jsonc
"litellm-vscode-chat.servers": [
  { "label": "Local", "baseUrl": "http://localhost:4000" }
]
```

Typical - a hosted gateway with a key kept out of the settings file:

```jsonc
"litellm-vscode-chat.servers": [
  { "label": "prod", "baseUrl": "https://litellm.example.com" }
]
// then: dashboard -> edit "prod" -> API key -> Store in: "secret storage",
// or Command Palette -> "LiteLLM: Set Server Secret"
```

Save, and the server's models appear in the model picker within moments. The dashboard's **Test connection** button probes a draft exactly as entered - unsaved edits included, stored secrets read from wherever they live - with one discovery call, and reports the model count or the exact error, linking the matching [troubleshooting](troubleshooting.md#common-issues) section when the failure looks like a setup problem. It saves and syncs nothing.

One timing rule when the key comes after the entry: the provider group is created from the entry the moment it first syncs, credentials included, and VS Code cannot update an existing group - a key stored after that first sync reaches requests only once the group is recreated, and the server row shows the exact steps ([Lifecycle](#lifecycle-renames-removals-hidden-groups)). The dashboard's add form avoids this by storing the key before the entry first syncs.

## Entry reference

Every property an entry can carry:

| Property | Type | What it does |
|---|---|---|
| `label` | string, required | Names the server in the model picker; half of the entry's identity |
| `baseUrl` | string, required | The server's root URL. The extension appends `/v1` unless the URL already ends in a version segment (like `/v1` or `/v2`), which is used as-is; the `apiVersion` field overrides both |
| `apiVersion` | string | What to append to the base URL. Unset = auto (`/v1`, or a version already in the URL); `""` = append nothing; `"v2"` = append `/v2`. Like every per-entry field, it applies only through a provider group matching the entry's label and base URL; a stale group falls back to the auto rule, and the dashboard says so under the server's row |
| `auth` | object | Exactly one form of `apiKey`, `oauth`, `virtualKey`, optionally with lower-ranked companions ([below](#authentication)). Omit entirely for servers that need none. An ambiguous shape is reported and the entry is treated as misconfigured |
| `headers` | object | Custom HTTP headers on every request to this server ([below](#custom-headers)); extension-managed auth headers win conflicts |
| `models.parameters` | record | Request parameters for this server's models only; same [matcher keys](models.md#model-matching) as the global setting, applied above it field by field ([details](models.md#parameters)) |
| `models.capabilities` | record | Capability overrides for this server's models only; same mechanics ([details](models.md#capabilities)) |
| `discovery.declared` | string[] | Exact model IDs to register even when discovery cannot list them ([below](#declared-models)) |
| `discovery.expectedFailures` | string[] | Discovery endpoints this server is expected to fail: `"modelListing"` (`/v1/models`), `"modelInfo"` (`/v1/model/info`). Each gets a single attempt and an info-level log line instead of a red error ([below](#discovery-and-expected-failures)) |
| `budget` | number | Manual budget, in the server's billing currency, for [usage alerts](usage.md#budgets). Outranks the key's own `max_budget`; the dashboard shows both |
| `mcp` | `true` or object | Make this server's own MCP tools available in chat ([below](#mcp-tools)). `true` publishes `<baseUrl>/mcp`; `{ "url": "..." }` names another endpoint |

A complete entry:

```jsonc
{
  "label": "prod",
  "baseUrl": "https://gateway.internal",
  "auth": { "apiKey": "sk-..." },
  "headers": { "x-routing-env": "prod" },
  "models": {
    "parameters":   { "gpt-5*": { "temperature": 0.2 } },
    "capabilities": { "deepseek-r1": { "supports_reasoning": true, "context_length": 131072 } }
  },
  "discovery": {
    "expectedFailures": ["modelListing", "modelInfo"],
    "declared": ["deepseek-r1"]
  },
  "budget": 50,
  "mcp": true
}
```

Edge cases the table cannot show:

- Labels are unique across entries: an entry repeating an earlier entry's label is skipped and reported - the first entry wins. To point two entries at the same host, give them different labels; they are then two servers end to end - two picker groups, the models listed under each, and each entry's auth, headers, and `models` records applying only to its own group.
- An empty or whitespace-only `label` or `baseUrl` makes the entry unusable: skipped and reported. The JavaScript-reserved names `__proto__`, `constructor`, and `prototype` are rejected as labels.
- The base URL may carry a path (`https://intranet.example.com/litellm`, a gateway mounted under one); `/v1` is appended after it unless the path already ends in a version segment (like `/v1` or `/v2`), which is used as-is - the `apiVersion` field overrides both (empty string = append nothing). A trailing slash is harmless - it is stripped before the URL is compared or used.
- Plain `http` works and is the normal choice for a local proxy; over a network it carries your credentials unencrypted, so prefer `https` for anything remote.
- `budget` must be a number greater than 0 ([Usage - Budgets](usage.md#budgets)).
- `mcp` accepts `true`, `false` (the same as leaving it out), or an object. A `url` is taken as written, like `baseUrl`: the setting does not second-guess it, while the dashboard's form refuses one it can see is broken. An object carrying no usable `url` publishes the derived endpoint, like `true`.
- A momentarily malformed entry (a mid-edit settings.json, say) is skipped and reported, but never mistaken for a removal: its provider group is not hidden. [Removal](#lifecycle-renames-removals-hidden-groups) happens only when the label itself disappears from the setting.

## Authentication

Pick the form that matches what your gateway expects. Exactly one form per entry, and the forms rank `oauth` > `apiKey` > `virtualKey`: a form can carry a *companion* credential of lower rank for gateways that demand a second credential in a second header - `oauth` takes an `apiKey` and/or `virtualKey` companion (inside the `oauth` object), `apiKey` takes a `virtualKey` companion (beside it), and `virtualKey`, the lowest rank, takes none.

| Your gateway expects | Configure |
|---|---|
| a key as a bearer token (the common case, LiteLLM virtual keys included) | `auth.apiKey` |
| a key in a custom header (e.g. `x-litellm-api-key`) | `auth.virtualKey` |
| a bearer key **and** a key in a custom header | `auth.apiKey` + a `virtualKey` companion beside it |
| an OAuth2 client-credentials token | `auth.oauth` |
| an OAuth token **and** a LiteLLM key beside it | `auth.oauth` + its `apiKey` or `virtualKey` companion |

Two boundary cases:

- An auth form missing a required piece (an `oauth` without its `tokenUrl` or `clientId`) is a configuration error like setting two forms: reported, and the entry is not used until fixed. A form that is merely *waiting for its secret* (a `virtualKey` header with the value still unset, an `apiKey` stored nowhere yet) is different: the entry works, requests simply carry no credential, and the server's 401 tells you what is missing - the normal state between adding an entry and running "LiteLLM: Set Server Secret".

- **No `auth` at all** means no credential headers are sent - unless a [stored secret](#secrets-and-secret-storage) for the entry says otherwise; storage counts as part of the shape. There is no separate "keyless" mode to pick: a server that turns out to require a key answers 401 ("Authentication failed"), and adding the key to the entry is the fix.
- **An ambiguous `auth` shape** never makes the extension guess between credentials: `oauth` with anything else at the top level of `auth` (its companions belong *inside* the `oauth` object), or a key inside `auth` the extension does not recognize (a typo would otherwise silently mean "no credential"), is misconfigured - the dashboard's server row and its Configuration diagnostics name the offending key - and the entry is not used until fixed. Other entries are unaffected. `apiKey` beside `virtualKey` is *not* ambiguous: rank makes it the API-key form with a virtual-key companion.

### API key

```jsonc
"auth": { "apiKey": "sk-..." }   // or keep it in secret storage; see Secrets below
```

Sent as an `Authorization: Bearer` header plus an `X-API-Key` copy (some gateways read one, some the other).

A gateway that checks the bearer **and** a key in a custom header at once takes the second credential as a companion beside the key:

```jsonc
"auth": {
  "apiKey": "sk-...",
  "virtualKey": { "header": "x-litellm-api-key", "value": "sk-..." }  // optional companion: extra header
}
```

A companion naming `Authorization` or `X-API-Key` as its header takes that one header over from the API key.

### Virtual key in a custom header

A virtual key is a key the LiteLLM proxy itself issues, scoped to a budget, a team, or a set of models ([LiteLLM's docs](https://docs.litellm.ai/docs/proxy/virtual_keys)). Most gateways take it as an ordinary bearer token - use `auth.apiKey` for those. This form is for gateways that expect it in a custom header:

```jsonc
"auth": {
  "virtualKey": {
    "header": "x-litellm-api-key",
    "value": "sk-..."            // or keep it in secret storage
  }
}
```

Naming `Authorization` as the header hands the virtual key that whole header. The `header` is required and is plain settings text; the `value` is the secret-capable half, so an entry carrying only the header is the [secret-storage shape](#secrets-and-secret-storage) - the value is read from where it is stored.

### OAuth client credentials

For gateways behind an identity provider that reject static keys:

```jsonc
"auth": {
  "oauth": {
    "tokenUrl": "https://idp.example.com/oauth2/token",
    "clientId": "my-client-id",
    "clientSecret": "...",       // omit for public clients; may live in secret storage
    "scopes": "read write"       // optional, space-separated
  }
}
```

The extension exchanges the credentials for a short-lived bearer token, sends it as `Authorization` on every request to the server, and refreshes it shortly before expiry. On chat and discovery requests the exchange is bounded by `discovery.timeout` - it is auth plumbing, not a chat call, so a slow identity provider needs `discovery.timeout` raised, not `chat.timeout`; on chat requests the exchange also counts inside `chat.timeout`'s whole-call budget. Commit-generation and inline-completion calls instead bound the exchange by their own whole-call budget (`chat.timeout` and the fixed inline-completion timeout). A rejected token is discarded so the next request fetches a fresh one.

**Companions** - some corporate gateways check two credentials at once: the OAuth bearer proves you to the identity provider, while a LiteLLM key in a second header tells the proxy which budget or team to bill. Since `Authorization` is already taken by the bearer, the second credential rides its own header:

```jsonc
"auth": {
  "oauth": {
    "tokenUrl": "https://idp.example.com/oauth2/token",
    "clientId": "my-client-id",
    "apiKey": "sk-...",          // optional: also sent, as X-API-Key only
    "virtualKey": { "header": "x-litellm-api-key", "value": "sk-..." }  // optional: extra header
  }
}
```

A companion `virtualKey` naming `Authorization` as its header takes over that header and skips the OAuth exchange entirely.

## Custom headers

An entry's `headers` object attaches extra HTTP headers to every request to this server - discovery and chat alike. Its job is gateway plumbing: routing tags, tracing headers, additional gateway keys.

```jsonc
{
  "label": "prod",
  "baseUrl": "https://gateway.internal",
  "auth": { "apiKey": "sk-..." },
  "headers": { "x-routing-env": "prod", "x-trace-source": "vscode" }
}
```

- Extension-managed auth headers win conflicts: a custom header here loses to any header the entry's `auth` form sends - `Authorization`, `X-API-Key`, or a virtual key's named header, companion or not. Names compare case-insensitively, as HTTP headers do, so writing `authorization` changes nothing.
- Like every per-entry field, headers apply only through a provider group matching the entry's label and base URL: a stale group (a rename leftover, or one predating entry labels) sends requests without them ([Troubleshooting](troubleshooting.md#per-server-model-parameters-are-inactive)).
- Because headers live on the entry, they are machine-scoped and never travel with Settings Sync - a credential-like value here stays on this machine. (There is deliberately no global headers setting for exactly this reason.)
- Two header names differing only by case are one header (HTTP header names are case-insensitive): the first one in the object wins and the collision is reported as a configuration diagnostic.
- Header values are plain settings text, not secrets. A value that is truly secret belongs in an [`auth` form](#authentication), which can live in secret storage.

## MCP tools

A LiteLLM proxy can serve tools over the Model Context Protocol. An entry's `mcp` field offers them to chat, so the server you already configured for models is also the server your tools come from - one host, one set of credentials, one place to change them.

```jsonc
{
  "label": "prod",
  "baseUrl": "https://gateway.internal",
  "auth": { "apiKey": "sk-..." },
  "mcp": true
}
```

`true` publishes the endpoint derived from the base URL, appending `/mcp` to it as written (a base URL ending in `/v1` derives `/v1/mcp`). When the endpoint lives elsewhere, name it:

```jsonc
"mcp": { "url": "https://gateway.internal/tools/mcp" }
```

The dashboard's server form carries the same two controls, in its own **MCP** section; leaving the endpoint empty shows you the exact address it will publish.

- **Credentials attach when a session starts, never earlier.** VS Code asks for the published list eagerly, before any chat turn, and that list carries labels and URLs only. The entry's credentials - an API key, a virtual key, or a freshly exchanged OAuth token - are composed only when the editor is about to open a session, by the same rules a chat request to the same server follows, from the entry re-read at that moment: same label, same endpoint, same origin. Freshness is best effort rather than guaranteed: a rotation landing at that same moment can still open the session on the credentials it just replaced, and the refresh the editor offers next picks up the new ones.
- Rotating an entry's credentials tells the editor that its tools may now answer differently: the published version changes and VS Code offers to refresh them. Nothing about the credential itself is published - only a count of how many times it has changed.
- The opt-in is per entry, so two entries pointing at one host publish two MCP servers, each with its own label and its own credentials.
- **Credentials follow the entry's own origin.** A custom `url` on the same origin as `baseUrl` - any path, which is the case the field exists for - is authenticated like the derived endpoint. A `url` pointing at another origin is still published, but bare: the entry's key was paired with its base URL, and the extension will not forward it to a host nothing paired it with. If a server at another origin needs this key, give it its own entry.
- **A stored secret must still belong to this server.** Secrets in [secret storage](#secrets-and-secret-storage) remember which destination they were stored for. If you change an entry's `baseUrl` after storing one, its MCP server refuses to start until you store the secret again for the new URL - the same refusal the chat path already makes, applied here before anything is sent rather than after.
- Removing the field (or setting it to `false`) unpublishes the server.
- Tool results are ordinary chat content: what a tool returns goes to whichever model answers the turn.

## Per-server model configuration

The entry's `models` object shapes what this server's models look like and how they are called. Both fields mirror the global `models.*` settings - learn the record shape once, use it in both places.

### Parameters and capabilities

- `models.parameters` targets requests: it uses the same [matcher keys](models.md#model-matching) as the global `models.parameters` and applies **above** it, field by field. Entry records are the one place for server-specific configuration - global keys are model matchers only, with no server scoping.
- `models.capabilities` targets registration: token limits, vision, tool calling, reasoning - correcting or completing what discovery reports. Capabilities are source-agnostic: they apply identically whether a model was discovered or [declared](#declared-models).

The dashboard's edit form has matching "for this server" sections for both, with per-row validation and the same effective-values inspectors as the global editors.

### Declared models

When discovery cannot list a model - a gateway without `/v1/models`, a model the gateway hides - declare it and it registers anyway:

```jsonc
"discovery": { "declared": ["deepseek-r1", "qwen2.5-vl-72b"] }
```

- IDs are exact (no matchers): a declaration says "this model exists here". An empty `declared` list is the same as no list.
- A declared model is created only when discovery does not already list it; once the server starts listing it, the declaration goes inert and the server's data takes over.
- Whether the ID is listed is the only test - not why it is missing. A declared model registers whether the endpoint is expectedly absent, the discovery pass failed outright (the server row still reports that failure), or the server lists other models but hides this one.
- The switch between inert and active happens on a discovery pass: a server that starts (or stops) listing a declared ID mid-session changes nothing until the next refresh - discovered lists are cached ([`discovery.cacheTtl`](settings.md#reference)) - so run "LiteLLM: Sync Models Now" to see it immediately.
- Two entries may declare the same ID: each registers its own copy under its own server, exactly like a model two servers both serve.
- Declaring a model and describing it are separate steps: a declared model's capabilities come from `models.capabilities`, the OpenRouter catalog, and the built-in defaults, exactly like every other model's.
- Declaration is always per server. For a server added through VS Code's own model management (no entry), [adopt it](#external-servers-and-adoption) first.
- Like every per-entry field, declarations resolve through the entry's label-and-base-URL match: a stale group serving the server (a rename leftover, or one predating entry labels) registers no declared models. The fix is the same as for [inactive per-server parameters](troubleshooting.md#per-server-model-parameters-are-inactive).

### Discovery and expected failures

Discovery tries `/v1/model/info` (rich metadata) and falls back to `/v1/models` (bare list). Requests are idempotent and retried on transient failures within `discovery.timeout`.

If your gateway simply does not serve one or both endpoints, say so and the extension stops treating it as an outage:

```jsonc
"discovery": { "expectedFailures": ["modelListing", "modelInfo"] }
```

- Each named endpoint gets a single attempt (no retries) and an info-level log line instead of a red error; the server does not count as failing.
- "Expected" marks failure as unremarkable, not the endpoint as off-limits: a named endpoint that does answer is used normally - its data wins as usual, and any [declared](#declared-models) IDs it lists go inert. The single attempt is the one standing effect, succeed or fail.
- Unknown values in the list (anything but `"modelListing"` and `"modelInfo"`) are ignored and reported.
- Combined with `discovery.declared`, this is the recipe for a gateway with no discovery at all: declare the models, expect both failures, and the server behaves like a first-class citizen - the status bar, dashboard, and Test connection all report the declared models instead of errors.

## Secrets and secret storage

The secret-capable fields - `auth.apiKey`, `auth.oauth.clientSecret`, `auth.virtualKey.value`, and the companions' key/value (OAuth's or the API-key form's) - each offer a per-entry choice:

- **Inline** in settings.json, when a plaintext value in that file is acceptable.
- **VS Code secret storage** (encrypted, per-machine), via the dashboard form's "Store in:" choice - "secret storage" (the default for a new value; editing an entry whose key already sits inline opens on "settings (visible)") - or "LiteLLM: Set Server Secret". The entry then simply omits the field.
- An inline value takes precedence over a stored one.

A stored value has no marker in settings.json, so shape and storage combine: a stored `apiKey` activates the bearer whenever the entry's shape does not say otherwise - on an entry with no `auth` at all, on the API-key form, or beside a declared `virtualKey` (rank reads that as the API-key form with a companion). Under `oauth` it stays the companion: `Authorization` belongs to the OAuth bearer, and the stored key goes out as `X-API-Key` only. To stop sending a stored key, remove the stored value itself (the checkbox below) - deleting settings text alone does not reach it.

What renders back into the dashboard: stored values never do - the form shows where a value lives, not what it is. Inline values do prefill the edit form (masked behind a Show toggle), since they already sit in plain text in your settings.json.

A field can end up with both copies - a value put in secret storage first, then pasted inline later. Requests use the inline one, and the stored copy stays put: emptying the inline field falls back to the stored value rather than clearing it. To be rid of the stored copy, use the edit form's "Remove the stored ..." checkbox below.

When editing a saved entry:

- An emptied secret field keeps whatever is stored; it does not clear the secret.
- Deleting a stored secret is an explicit choice: the edit form shows a "Remove the stored ..." checkbox under each secret field that has a value.

Setting or rotating a stored secret counts as changing the entry's credentials: the already-synced group cannot pick it up, requests keep using the credentials the group was created with, and the server row shows the recreate steps ([Lifecycle](#lifecycle-renames-removals-hidden-groups)).

Where the extension needs a non-secret identity for a credential (the change detectors that keep sync state in step), it stores a fingerprint keyed by a random per-install secret rather than a plain hash - those records reveal nothing about the credential, even a short guessable key, to anything that can read extension state but not secret storage. And when VS Code's secret storage itself is unavailable (a Linux desktop without a keyring service, say), sync skips the entry for the pass and the server row says so - see [Troubleshooting](troubleshooting.md#secret-storage-is-unavailable).

Stored secrets belong to the entry's label alone - the base URL plays no part. Two consequences:

- A rename typed into settings.json leaves the values under the old label: the renamed entry serves whatever stored secrets sit under the new label instead (usually none, but hand-written edits are the one route that still finds a retired label's leftovers), until you set them again or re-save it from the dashboard, whose edit form moves the stored secrets to the new name for you.
- Re-pointing a familiar label at a different host is flagged instead of silently adopted - see [Changing a server's URL](#changing-a-servers-url). To hand a server nothing at all, remove the stored value first (the edit form's "Remove the stored ..." checkbox).

### Changing a server's URL

A stored secret remembers the address it was saved for. When an entry's `baseUrl` moves away from that address, the extension flags the mismatch instead of silently adopting the new pairing:

- **Editing in the dashboard**: Save asks before anything is written. "Use same key" re-pairs the stored key with the new URL, "Clear key" removes the stored value, and "Keep editing" cancels the save.
- **Editing settings.json by hand**: sync skips the entry and its dashboard row explains why, until you set the secret again (the dashboard's edit form or `LiteLLM: Set Server Secret`) or remove the stored value. Feature requests that resolve the entry directly (commit generation, inline completions, and the other one-shot features) keep sending the stored key meanwhile, so the server's own 401 is the other signal.
- **A settings import** never asks: overwriting an entry replaces its stored secrets outright, so a file that carries no replacement value for a stored secret field clears the stored value instead of pairing it with the imported configuration. Re-enter the key after the import - or run "LiteLLM: Undo Last Settings Import" - if you want it back.

Only stored values carry this pairing - an inline secret already sits in plain text in settings.json and never raises the question. The OAuth client secret is paired with the entry's token URL rather than the base URL, so moving the token URL is handled the same way. [MCP](#mcp-tools) keeps its stricter refusal until the pairing is fixed - either answer fixes it.

Removing an entry does not delete its stored secrets. Three routes will not reuse them: the dashboard's Add Server form, which shows no credentials, so the saved entry carries none of the leftovers and they are removed with it; a settings import, which reconciles every secret field of every label it lands, clearing the ones the imported file does not carry; and a dashboard rename onto the retired label, which wipes the leftovers and brings the renamed entry's own secrets instead. The Add Server form behaves the same way when the label is still in use - it warns that saving replaces the entry, and the replacement takes its stored credentials with it. One route still finds them: re-adding the entry by hand in settings.json. Remove the stored value first (the edit form's "Remove the stored ..." checkbox) when the old credential must not reach the new host. Removing all secrets before uninstalling is covered in [Troubleshooting](troubleshooting.md#uninstalling-and-cleanup).

## Lifecycle: renames, removals, hidden groups

One VS Code limitation explains this whole section: **the host API can create provider groups but never update or remove them.** The extension works around it honestly rather than pretending.

| You do | What happens |
|---|---|
| Add an entry | A provider group is created; models appear in the picker |
| Change an entry's URL or credentials | The existing group cannot be updated. The server row shows an error with the fix: delete the group's object from the models file, reload, run "LiteLLM: Sync Models Now" - the group is recreated from the entry. Until then, requests keep using the credentials the group was created with - a rotated key is not in effect |
| Rename an entry (`label`) | A new group is created under the new name; the old one stays behind. The extension's notice names it and opens the models file so its object can be deleted; the dashboard marks the leftover row "external" with the rename in its badge tip. A settings.json rename does not move the label's stored secrets - they stay under the old name ([Secrets](#secrets-and-secret-storage)); a dashboard rename carries them over |
| Remove an entry | The group cannot be removed, so the extension *hides* it: remembers the removal, answers the group with an empty model list (models leave the picker), and folds the row into the dashboard's "hidden groups" line with an Unhide action. The removal notice names the group and opens the models file for permanent deletion |
| Re-add an entry with the same label and base URL | Its hidden group comes back on its own |

The models file is `<profile>/User/chatLanguageModels.json` - a documented, user-editable JSON file. VS Code reads it at startup and holds it in memory, so quit or reload the window after editing; a live window can overwrite external edits.

## External servers and adoption

Servers whose groups were added outside this extension (VS Code's own model-management UI - the "Manage LiteLLM Provider" flow in the model picker - or another tool) still work; the dashboard shows them marked "external", since they have no settings entry. The badge's hover tip says where the row came from when the extension knows - the leftover of a removed entry (named), or of a rename (old and new labels).

An external row offers two actions:

- **Remove** hides the group, same as removing a declared entry; the follow-up notice opens the models file for permanent deletion.
- **Edit** adopts the group into the setting:

1. Click Edit on the external row - that is the adopt action.
2. Pick the entry's label. The form prefills the group's current label, but renaming is usually worth it: an entry whose name an existing group still uses cannot sync until that group's object is deleted from the models file.
3. Pick where each secret should live (secret storage or inline). The credential values are copied inside the extension and never pass through the dashboard page.
4. Save: the group's connection details become a new `servers` entry, editable like any declared one.
5. Delete the original group's object from the models file and reload (adoption cannot remove it); until then its models appear twice - the dashboard reminds you after adopting.

## Multiple machines and Settings Sync

- The `servers` setting is machine-scoped; Settings Sync never carries it. Values in secret storage do not sync either. On a second machine, re-add the servers and their secrets.
- Every other `litellm-vscode-chat.*` setting except the machine-overridable feature toggles and model picks ([scope](settings.md#how-settings-work)) syncs normally - including `models.parameters` and `models.capabilities`, so your model configuration follows you. On a machine where the servers are not (yet) re-added, those synced records simply have no models to match - they sit idle and take effect the moment a server does. Anything server-bound (credentials, custom headers, budgets) lives in entries and stays put by design.
