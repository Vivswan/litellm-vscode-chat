# Settings

English | [简体中文](zh-cn/settings.md) | [繁體中文](zh-tw/settings.md)

Every `litellm-vscode-chat.*` setting, with its default and what it does. Open them with `Ctrl+,` / `Cmd+,` and search "litellm-vscode-chat", or edit the same values as form controls on the [dashboard](dashboard.md)'s Settings tab. A dashboard row you have configured says where its value lives ("Modified in User settings") and, on number rows, the setting's built-in default; Reset removes the value from that scope, letting the next scope's value or the default show through.

## Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `litellm-vscode-chat.servers` | `[]` | The declared LiteLLM servers; see [Servers](servers.md) |
| `litellm-vscode-chat.defaultMaxOutputTokens` | `16000` | Deprecated, prefer `modelCapabilities`; max output tokens for models whose server declares none |
| `litellm-vscode-chat.defaultContextLength` | `128000` | Deprecated, prefer `modelCapabilities`; context window for models whose server declares none |
| `litellm-vscode-chat.defaultMaxInputTokens` | `null` | Deprecated, prefer `modelCapabilities`; max input tokens, overriding even server-declared limits |
| `litellm-vscode-chat.requestTimeout` | `300000` | Timeout for chat completion requests, in milliseconds (5 minutes) |
| `litellm-vscode-chat.discoveryTimeout` | `30000` | Timeout for model discovery requests, in milliseconds (30 seconds) |
| `litellm-vscode-chat.discoveryCacheTtl` | `3600000` | How long discovered model lists are reused, in milliseconds (1 hour) |
| `litellm-vscode-chat.modelParameters` | `{}` | Per-model request parameters; see [Model parameters](model-parameters.md) |
| `litellm-vscode-chat.modelCapabilities` | `{}` | Per-model capability overrides and `_declare` entries; see [Model capabilities](model-capabilities.md) |
| `litellm-vscode-chat.openRouterCatalog.enabled` | `true` | Fill missing model capabilities from the OpenRouter catalog, refreshed weekly; see [below](#the-openrouter-catalog) |
| `litellm-vscode-chat.headers` | `{}` | Custom HTTP headers added to every request |
| `litellm-vscode-chat.promptCaching.enabled` | `true` | Prompt caching on models that support it |
| `litellm-vscode-chat.maskApiKeyInput` | `true` | Mask the API key input field when configuring a server |

The sections below cover the settings whose behavior has more to it than one line.

## Token limits

The extension reads token limits from your LiteLLM server's model info, so most models need no configuration here. All three `default*` settings are deprecated in favor of [`modelCapabilities`](model-capabilities.md), which targets specific models and, unlike the fallbacks, also overrides limits a server does declare; they keep working, following two different rules.

**`defaultMaxOutputTokens` and `defaultContextLength` are fallbacks:**

- They apply only to models whose server declares no output limit or context length; model info wins whenever it is present.
- One cap to know: when a model's output limit came from `defaultMaxOutputTokens` rather than the server, requests to it carry at most 4096 tokens of `max_tokens` on the wire, whatever the setting says (the [max_tokens exception](model-parameters.md#the-pass-through-contract)). To send more to such a model, set `max_tokens` in [`modelParameters`](model-parameters.md).

**`defaultMaxInputTokens` is an override, not a fallback:**

- Left at `null` (the usual choice), the input budget is the server's declared input limit, or context length minus max output tokens when it declares none.
- Set it, and it pins the input limit for every model, outranking even server-declared ones.

The input budget is enforced before a request is sent, from a local token estimate; see [Troubleshooting](troubleshooting.md#common-issues) for the "Message exceeds token limit" error this produces.

## The OpenRouter catalog

`litellm-vscode-chat.openRouterCatalog.enabled` (default `true`) lets the extension fill capability gaps from a bundled snapshot of OpenRouter's public model catalog, refreshed about weekly from `openrouter.ai` - the one outbound request that does not go to a server you configured (public model metadata only; nothing about you or your servers is sent). Set it to `false` to stop the refresh and the automatic matching; explicit `_openrouter_model` directives keep working offline. Details and the privacy notes are in [Model capabilities](model-capabilities.md#the-openrouter-catalog).

## Request timeouts

```json
{
  "litellm-vscode-chat.requestTimeout": 600000,
  "litellm-vscode-chat.discoveryTimeout": 60000
}
```

- Both timeouts are hard bounds on the whole call, streaming and any retries included.
- Chat completions are never retried, so `requestTimeout` is the total time a request may take; model discovery requests are idempotent and retried on failure, all within `discoveryTimeout` (details in [Troubleshooting](troubleshooting.md#timeouts-and-retries)).
- Increase them when complex prompts or long reasoning runs get cut off, or when your server sits behind slow infrastructure.
- Minimum timeout is 1000ms (1 second) for both settings; lower values are clamped.

## Model list caching

```json
{
  "litellm-vscode-chat.discoveryCacheTtl": 3600000
}
```

VS Code re-resolves language model providers often, sometimes several times within a second. To avoid hammering your server's `/v1/model/info` endpoint, the extension caches each server's discovered model list for one hour by default.

- Failed lookups are never cached, and simultaneous refreshes share a single request.
- Lower the value (milliseconds) if models change often on your server, or set it to `0` to fetch on every refresh.
- To pick up server-side changes right away, run "LiteLLM: Sync Models Now" from the Command Palette; "LiteLLM: Test Connection" also refreshes over the network.

## Custom HTTP headers

`litellm-vscode-chat.headers` attaches custom headers to every LiteLLM request (both model discovery and chat completions). This is useful when your gateway expects non-standard auth headers like `x-litellm-api-key`:

```json
{
  "litellm-vscode-chat.headers": {
    "x-litellm-api-key": "your-gateway-key",
    "x-routing-env": "prod"
  }
}
```

- Custom headers are merged into every request; the extension-managed auth headers (`Authorization` and `X-API-Key`) still take precedence when an API key is configured on the server.
- Header values are ordinary settings, not secrets. If a value is secret, set it in User settings rather than workspace settings, so it cannot end up in a committed `.vscode/settings.json`.
- User settings travel with Settings Sync, so a secret value still replicates to every machine you sync (see [Multiple machines and Settings Sync](servers.md#multiple-machines-and-settings-sync)).
- For per-server keys, prefer the server entry's virtual key fields, which can live in secret storage and never sync; see [Servers](servers.md#secrets-and-secret-storage).

## Prompt caching

On models that advertise prompt caching support in LiteLLM's model info (currently Anthropic Claude models), the extension spends Anthropic's four cache breakpoints per request on the parts that stay identical across the turns of an agent session:

- the last tool definition
- the system prompt
- the first user message
- the last text-bearing message (a trailing tool-call-only or image-only message is skipped)

Each turn then reuses the prefix the previous turn cached instead of re-paying full input price for the tools and the whole conversation history. The savings show most in agent mode, where tools and history dominate the request.

Two limits to know:

- The markers are Anthropic's ephemeral cache markers with no explicit TTL, so the cache lifetime is the provider's default (currently about 5 minutes for Anthropic); the extension does not set or extend it.
- Models without declared support are never sent cache markers.

This is on by default; set `litellm-vscode-chat.promptCaching.enabled` to `false` to turn it off.
