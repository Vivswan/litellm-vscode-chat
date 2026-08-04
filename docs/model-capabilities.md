# Model capabilities

English | [简体中文](zh-cn/model-capabilities.md) | [繁體中文](zh-tw/model-capabilities.md)

Discovery reads what each model can do from your LiteLLM server. When the server reports it wrong - or reports nothing at all - the `litellm-vscode-chat.modelCapabilities` setting corrects and extends it: fix a context length, turn vision on, or declare a model discovery cannot list.

```json
{
  "litellm-vscode-chat.modelCapabilities": {
    "gpt-4": { "context_length": 128000, "supports_vision": true },
    "my-gateway-model": { "max_output_tokens": 32000 }
  }
}
```

Capabilities describe what a model **can do**: they drive registration, token limits, and which attachments are sent. What a request **asks for** (temperature, `max_tokens`, and friends) is [Model parameters](model-parameters.md)' job; the two settings share their key syntax but never mix.

## Capability fields

| Field | Type | What it controls |
|-------|------|------------------|
| `context_length` | number | The model's context window |
| `max_input_tokens` | number | The input budget; when nothing sets it, context length minus max output tokens |
| `max_output_tokens` | number | The output limit, and the `max_tokens` fallback ([the pass-through exception](model-parameters.md#the-pass-through-contract)) |
| `supports_function_calling` | boolean | Tool-using requests (agent mode) |
| `supports_vision` | boolean | Whether image attachments are sent |
| `supports_reasoning` | boolean | The Thinking Effort control in the picker |
| `supports_audio_input` | boolean | Whether audio attachments are sent |

Unlike `modelParameters`, this vocabulary is closed: an unknown key is not forwarded anywhere, it is flagged in the dashboard's capability inspector. Number fields take positive integers; an invalid value is flagged too and the next-best source wins instead.

Keys match like model parameters do: longest model-ID prefix wins, `""` matches every model, and prefixing a key with a server's base URL and `/` scopes it to that server, where a scoped match replaces unscoped keys outright (see [prefix matching](model-parameters.md#prefix-matching-and-server-scoping)).

## Per-entry capabilities

A `litellm-vscode-chat.servers` entry can carry its own `modelCapabilities`, applied only to models served through that entry - the same shape without base-URL scoping, mirroring [per-entry parameters](model-parameters.md#per-entry-parameters):

```jsonc
// user settings.json
"litellm-vscode-chat.servers": [
	{
		"label": "Team A",
		"baseUrl": "https://litellm.example.com",
		"modelCapabilities": {
			"gpt-4": { "supports_vision": true }
		}
	}
]
```

Where an entry field and a global one match the same model, the entry's value wins key by key. The dashboard's server form has a matching "Model capabilities for this server" section.

## Declaring models discovery cannot list

Some gateways serve chat but expose no usable model listing. `"_declare": true` registers the key's exact model ID on its server even when discovery does not list it - typically together with [`expectedFailures`](#expected-discovery-failures) so the failing discovery is not treated as an outage:

```jsonc
// user settings.json
"litellm-vscode-chat.servers": [
	{
		"label": "Gateway",
		"baseUrl": "https://gateway.example.com",
		"apiKey": "sk-...",
		"expectedFailures": ["modelListing", "modelInfo"],
		"modelCapabilities": {
			"claude-sonnet-4": { "_declare": true, "context_length": 200000, "supports_vision": true }
		}
	}
]
```

- The key is the exact model ID to register; prefix matching never creates models.
- `_declare` needs a server it can name: an entry key, or a global key scoped by base URL (`https://gateway.example.com/claude-sonnet-4`). On an unscoped global key it is ignored.
- A declared ID the server also lists is inert - discovery's data is used, corrected by the record's other fields as usual.
- Declared models carry a "declared" badge in the [dashboard's models table](dashboard.md#models); removing the `_declare` removes the model immediately.

## Filling gaps from the OpenRouter catalog

The extension bundles a snapshot of [OpenRouter](https://openrouter.ai)'s public model catalog and can fill capability fields you did not set from it. `"_openrouter_model"` names the catalog entry explicitly:

```json
{
  "litellm-vscode-chat.modelCapabilities": {
    "my-alias": { "_openrouter_model": "anthropic/claude-sonnet-4" }
  }
}
```

- Catalog data fills only fields the matched records leave unset; your explicit fields always win.
- Fields derived this way rank above what the server reports - the directive says the server's data is not to be trusted for this model.
- An unknown catalog ID shows a warning in the capability inspector and the model falls back to the other sources; it is never an error.
- The dashboard's capability editor offers a search picker for the ID.

Without a directive, a model whose own ID matches a catalog entry exactly (or matches the part after the `vendor/` prefix, when only one entry does) still backfills from the catalog - but only as the weakest source above the built-in defaults, so it can never displace server-reported data or your settings.

## Precedence

Per field, the highest source that sets it wins:

1. Entry `modelCapabilities`
2. Global `modelCapabilities` (a base-URL-scoped match replaces unscoped keys)
3. Fields derived from `_openrouter_model`
4. What the server reports (absent for declared models; the deprecated `defaultMaxInputTokens` keeps outranking the server's input limit)
5. The deprecated `default*` settings, where explicitly set
6. An implicit OpenRouter catalog match
7. Built-in defaults: tools on, vision/audio/reasoning off, 128000 context, 16000 max output

Two consequences worth knowing:

- A `max_output_tokens` from levels 1-3 counts as user-declared and is sent as-is, as is a server limit every deployment of the model declared; any other winner - a merged limit some deployment left undeclared, a `default*` setting, a catalog match, or the floor - caps wire `max_tokens` at 4096 (see [the pass-through contract](model-parameters.md#the-pass-through-contract)).
- Pricing is never overridden: server-reported pricing always wins, and catalog pricing only fills in where the server reports none.

To see the resolved value and source for every field of a model - including what got shadowed - use the [dashboard's capability inspector](dashboard.md#effective-capabilities), the Caps action on each row of the models table.

## The OpenRouter catalog

Where the catalog data comes from, and the one network implication:

- The extension ships a snapshot of the catalog inside the VSIX and refreshes it about weekly from `https://openrouter.ai/api/v1/models` - a public, unauthenticated model list. The request carries no prompts, no usage, no account data, and nothing about your servers; the refreshed copy is cached in VS Code's global storage, and a failed refresh falls back silently to the cached or bundled snapshot.
- **Opting out**: set `litellm-vscode-chat.openRouterCatalog.enabled` to `false` to stop the periodic refresh (all catalog network) and the implicit matching. Explicit `_openrouter_model` directives keep working offline from the bundled or cached snapshot - they are your stated intent and need no network.

## Expected discovery failures

When a server is *expected* to fail discovery - a gateway that serves chat but has no model listing - the entry's `expectedFailures` field says so, so the extension stops treating those failures as outages:

```jsonc
{
	"label": "Gateway",
	"baseUrl": "https://gateway.example.com",
	"expectedFailures": ["modelListing", "modelInfo"]
}
```

- The two categories are `"modelListing"` (the `/models` listing) and `"modelInfo"` (the `/model/info` endpoint).
- A listed endpoint is still tried on every discovery pass - so models are picked up automatically if it starts working - but only once, without the usual retries.
- Its failure is logged as expected at info level and does not count against the server: with declared models the row stays Connected (with a note); with none it shows "Expected failure" and the dashboard points at `_declare`.
- The field exists on server entries only, since it must name a specific server.
