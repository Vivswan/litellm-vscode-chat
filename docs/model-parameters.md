# Model parameters

The extension never decides request parameters for you: beyond the fields it owns (model, messages, streaming plumbing, `max_tokens`, and tool wiring), only parameters you set somewhere reach LiteLLM, and they reach it unchanged. This page covers the places you can set them, the global `modelParameters` setting, per-entry parameters on a server, the model picker's per-model configuration, and how they combine when several match the same request.

## The pass-through contract

When you configure nothing, your model provider's own defaults apply: the extension injects no default temperature, no allow-list, nothing. All non-reserved parameter keys are passed through: the extension does not restrict which parameters you can set. Provider-owned fields (`model`, `messages`, `stream`, and friends) cannot be overridden, and keys starting with `_` are reserved for extension metadata and never forwarded.

The one documented exception is `max_tokens`: when nothing sets it, the extension sends the output limit your server declares in model info, or at most 4096 when the server declares none.

## The global setting

Override request parameters for specific models with the `litellm-vscode-chat.modelParameters` setting. This is useful for models with specific requirements (like gpt-5 requiring `temperature: 1`) or to customize behavior per model:

```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-5": {
      "temperature": 1
    },
    "gpt-4": {
      "max_tokens": 8000,
      "temperature": 0.8,
      "top_p": 0.9
    },
    "claude-opus": {
      "max_tokens": 16000,
      "temperature": 0.5
    }
  }
}
```

Common parameters: `max_tokens`, `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `stop`, `response_format`, `reasoning_effort`, `seed`, and any other parameter your LiteLLM deployment and model provider accept.

The native settings GUI cannot edit object settings, so the [dashboard](dashboard.md) gives this setting a row editor; you can also edit the JSON directly in settings.json.

## Prefix matching and server scoping

Configuration keys use longest prefix matching: `"gpt-4"` matches `"gpt-4-turbo:openai"`, `"gpt-4:azure"`, and so on, and a more specific key takes precedence over a shorter one. Prefixes match the model's exact ID as your server reports it, which the picker does not show; the [dashboard's models table](dashboard.md#models) has a per-row copy action for it.

Prefix a key with the server's base URL and `/` to scope it to that server (write the base URL without any trailing slash). Server-scoped entries take priority over unscoped ones, and within a scope the longer model prefix wins:

```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-4": {
      "temperature": 0.7
    },
    "https://litellm.example.com/gpt-4": {
      "temperature": 0.3
    },
    "http://localhost:4000/gpt-4": {
      "temperature": 0.9
    }
  }
}
```

Server scoping matches by base URL for every server: entries in the `servers` setting, servers added in the native editor, and legacy servers all identify a server by where it points.

Keys scoped by a pre-migration server label (for example `Production/gpt-4`) no longer match; per-entry `modelParameters` is the replacement, and the extension rewrote user-settings keys automatically during the provider-group migration. See [Troubleshooting](troubleshooting.md#label-scoped-parameter-keys-were-migrated) for what the migration did and which keys you must move by hand.

## Per-entry parameters

When two `litellm-vscode-chat.servers` entries point at the same base URL (for example one per virtual key), base-URL scoping applies to both alike. To target exactly one of them, put `modelParameters` on that entry instead:

```jsonc
// user settings.json
"litellm-vscode-chat.servers": [
	{
		"label": "Team A",
		"baseUrl": "https://litellm.example.com",
		"virtualKeyHeader": "x-litellm-api-key",
		"modelParameters": {
			"gpt-4": { "temperature": 0.2 }
		}
	},
	{
		"label": "Team B",
		"baseUrl": "https://litellm.example.com",
		"virtualKeyHeader": "x-litellm-api-key"
	}
]
```

Entry keys are plain model-ID prefixes (longest match wins; no base-URL scoping, since the entry already names its server). Where an entry parameter and a global one match the same model, the entry's value wins for that key and the global setting still supplies the rest.

A request picks up an entry's parameters only when the provider group it runs through matches the entry on both label and base URL. External groups managed only in the native editor, and stale groups left behind by a label or `baseUrl` edit, get only the global setting; the dashboard flags this as a ["params inactive" notice](troubleshooting.md#per-server-model-parameters-are-inactive).

## Reasoning effort in the model picker

Models that advertise reasoning support (`supports_reasoning`, or `reasoning_effort` among their supported params) get an effort control in Copilot's model picker: select the model, then click the "Thinking Effort" label next to the model name in the chat input. (The Manage Language Models editor shows the same control as "Reasoning Effort".) Pick a level from Off through Extra High and VS Code remembers the choice for that model; every request then carries `reasoning_effort` accordingly ("Off" goes out as `reasoning_effort: "none"`, which turns thinking off on models that support that). Pick "Provider default" (the initial state) to send nothing and let your provider decide.

The menu is the same for every reasoning model because LiteLLM reports which models take `reasoning_effort` but not which values each one accepts. If you pick a level your model rejects (say, Extra High on a model that stops at High), the request fails with the server's own error message; pick a different level and retry.

Temperature stays free-form in `modelParameters` on purpose: the picker's Configure Model menu can only render fixed choices, so the extension does not add temperature presets there.

## Precedence

When several sources set the same parameter for one request:

Runtime options > model picker choices > entry `modelParameters` > global `modelParameters`.

Runtime options are what the chat client (Copilot, or another extension calling the model) sets on the request itself. Any parameter left unset by all four falls through to your model provider's defaults, with the `max_tokens` exception described above.
