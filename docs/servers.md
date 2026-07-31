# Servers

The extension connects to any number of LiteLLM servers at once and aggregates their models into one picker list. Servers are declared in a single setting; each entry's secrets can live inline in the settings file or in VS Code's encrypted secret storage.

## The servers setting

Servers are declared in the `litellm-vscode-chat.servers` setting. The [dashboard](dashboard.md)'s add/edit form writes the same setting, so both paths stay in step:

```jsonc
// user settings.json
"litellm-vscode-chat.servers": [
	{
		"label": "Production",
		"baseUrl": "https://litellm.example.com",
		"apiKey": "sk-..." // inline: visible in this file
	},
	{
		"label": "Local",
		"baseUrl": "http://localhost:4000"
		// no apiKey here: either the server needs none, or the key lives in
		// VS Code secret storage (dashboard form, or "LiteLLM: Set Server Secret")
	}
]
```

How the setting behaves:

- The extension syncs the entries to VS Code provider groups automatically, on activation and whenever the setting changes.
- The setting is machine-scoped: it lives in your user settings only, a workspace cannot override it (so a cloned repository can never re-point your servers at another host), and Settings Sync does not carry it to other machines.
- The `label` is the entry's identity. The provider group is named after it, so renaming an entry creates a new group; the old one stays until you remove it.
- Removing an entry stops the extension from managing that server, but VS Code offers no API to remove the group itself. The extension points you at the native Manage Language Models editor (Command Palette → "Manage LiteLLM Provider" → Manage Language Models), where group removal lives.

One host limitation cuts across all of this: VS Code's provider-group command can create groups but not update or remove them.

- When a declared entry's connection changes (URL or credentials), the extension cannot push the change into the existing group. The server row shows an error telling you to remove the group in the native editor and run Sync Models Now, which recreates it from the entry.
- For the same reason, an edit made natively to a declared group stays in place until that group is removed and re-synced.

## Entry fields

Each entry carries a label, a base URL, and optionally credentials and per-server model parameters. The dashboard's add/edit form covers the same fields.

| Setting key | Description |
|-------------|-------------|
| `label` | Names the server in the model picker; the entry's identity (see above) |
| `baseUrl` | The server's root URL, e.g. `http://localhost:4000`. The extension appends `/v1` itself, so leave any `/v1` suffix off; a pasted `.../v1` URL requests `/v1/v1/...` and fails |
| `apiKey` | Sent as an `Authorization` bearer plus an `X-API-Key` copy; leave out if the server needs none |
| `oauthTokenUrl` | The identity provider's token endpoint, e.g. `https://idp.example.com/oauth2/token` |
| `oauthClientId` | Client ID for the client-credentials grant; required together with the token URL |
| `oauthClientSecret` | Client secret; leave it out for public clients issued without one. Keep it in secret storage or write it inline |
| `oauthScopes` | Optional space-separated scopes to request with the token |
| `virtualKeyHeader` | Optional name of a custom header carrying a LiteLLM virtual key, e.g. `x-litellm-api-key`. Naming `Authorization` hands the virtual key that whole header, and no OAuth token is fetched for this server |
| `virtualKeyValue` | The virtual key itself; keep it in secret storage or write it inline |
| `modelParameters` | Request parameters applied only to this entry's requests; see [Model parameters](model-parameters.md#per-entry-parameters) |

## Secrets and secret storage

The secret fields (`apiKey`, `oauthClientSecret`, `virtualKeyValue`) are per-entry choices:

- Write a secret inline when a plaintext value in your settings file is acceptable.
- Or leave it out and store it in VS Code secret storage instead, through the dashboard form's "store securely" option or the "LiteLLM: Set Server Secret" command.
- An inline value takes precedence over a stored one.

What renders back into the dashboard:

- Values in secret storage never do; the form shows where a value lives, not what it is.
- Inline values do prefill the edit form (masked behind a Show toggle), since they already sit in plain text in your settings.json.

Where the extension keeps a non-secret identity for a credential (for example the change detectors that keep the sync state in step), it stores a fingerprint keyed by a random per-install secret rather than a plain hash, so those records reveal nothing about the credential - even a short, guessable API key - to anything that can read extension state but not secret storage.

When editing a saved entry:

- An emptied secret field keeps whatever is stored; it does not clear the secret.
- Deleting one is an explicit choice: the edit form shows a "Remove the stored ..." checkbox under each secret field that has a value.

Removing secrets before uninstalling the extension is covered in [Troubleshooting](troubleshooting.md#uninstalling-and-cleanup).

## Virtual keys

A virtual key is a key the LiteLLM proxy itself issues, scoped to a budget, a team, or a set of models (see [LiteLLM's virtual keys docs](https://docs.litellm.ai/docs/proxy/virtual_keys)).

- Most gateways take a virtual key as an ordinary bearer token, in which case it belongs in `apiKey` like any other key.
- The `virtualKeyHeader`/`virtualKeyValue` pair is only for gateways that expect the key in a custom header instead, such as `x-litellm-api-key`:

```jsonc
{
	"label": "Team A",
	"baseUrl": "https://litellm.example.com",
	"virtualKeyHeader": "x-litellm-api-key",
	"virtualKeyValue": "sk-..." // or keep it in secret storage instead
}
```

## OAuth client-credentials authentication

Some LiteLLM gateways sit behind an identity provider and reject static API keys. For those, configure OAuth2 client-credentials authentication on the server entry:

```jsonc
{
	"label": "Corp gateway",
	"baseUrl": "https://litellm.example.com",
	"oauthTokenUrl": "https://idp.example.com/oauth2/token",
	"oauthClientId": "my-client-id",
	"oauthClientSecret": "...", // omit for public clients; may live in secret storage
	"oauthScopes": "read write"  // optional, space-separated
}
```

In the dashboard form the same fields sit behind "OAuth and virtual key (optional)"; for external servers managed in the native "Manage Language Models" editor, they appear there.

What happens when the token URL and client ID are both set:

- The extension exchanges the client credentials for a short-lived bearer token and sends it as the `Authorization` header on every request to that server, refreshing it shortly before it expires.
- The client secret may be omitted for public clients issued without one.
- A static API key configured on the same server keeps going out as the `X-API-Key` header alongside the bearer token, for gateways that check both.
- If the gateway additionally expects a [virtual key](#virtual-keys), set both virtual key fields and that header is sent along with every request. The exception is naming `Authorization` as the virtual key header, which gives the virtual key that whole header and skips the OAuth token exchange for the server entirely.
- The token exchange is bounded by the discovery timeout, and a rejected token is discarded so the next request fetches a fresh one.

## Per-server model parameters

An entry can carry its own `modelParameters`: the same prefix-keyed record as the global `litellm-vscode-chat.modelParameters` setting, applied only to requests that go through this entry.

- Base-URL scoping cannot tell apart two entries pointing at the same host (say, one per virtual key), so this is how parameters target one of them.
- The dashboard's edit form has a matching "Model parameters for this server" section.
- See [Model parameters](model-parameters.md) for the matching and precedence rules, and a worked example.

## External servers and adoption

Servers added directly in the native Manage Language Models editor still work; the dashboard shows them marked "external" since they have no settings entry. To adopt one into the setting:

1. Click Edit on the external row; that is the adopt action.
2. Pick the entry's label. The form prefills the group's current label, but renaming is usually worth it: an entry whose name an existing VS Code group still uses cannot sync until that group is removed in the native editor.
3. Pick where each secret is stored (secret storage or inline in settings). The credential values are copied inside the extension and never pass through the dashboard page.
4. Save: the group's connection details become a new `litellm-vscode-chat.servers` entry, and the server is editable like any declared one.
5. Delete the original group in the native editor. Adoption cannot remove it (VS Code has no API for that), so its models appear twice until you do; the dashboard reminds you of this after adopting.

## Multiple machines and Settings Sync

Servers and their credentials stay on the machine where you entered them:

- The `servers` setting is machine-scoped; Settings Sync never carries it.
- Values in VS Code secret storage do not sync either.
- On a second machine, re-add the servers and their keys.

Everything else arrives on its own: every other `litellm-vscode-chat.*` setting syncs normally, including timeouts, `modelParameters`, and `headers`. That last one cuts both ways: a gateway key placed in the [`headers` setting](settings.md#custom-http-headers) replicates to every machine you sync.
