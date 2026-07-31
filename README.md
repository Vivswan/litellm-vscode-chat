# LiteLLM Provider for GitHub Copilot Chat

Use 100+ LLMs in VS Code with GitHub Copilot Chat powered by [LiteLLM](https://docs.litellm.ai).

## Features

- Access 100+ LLMs (OpenAI, Anthropic, Google, AWS, Azure, and more) through a unified API
- **Multi-server support**: Connect to multiple LiteLLM servers simultaneously and aggregate models
- Automatic provider selection with `cheapest` and `fastest` modes
- **Multimodal support**: Vision (images), PDF/document attachments, and text/JSON data
- Support for streaming, function calling, and thinking/reasoning tokens
- Broad model options pass-through (`response_format`, `reasoning_effort`, `seed`, and more)
- Self-hosted or cloud-based deployment options

## Requirements

- VS Code 1.129.0 or higher
- LiteLLM proxy running (self-hosted or cloud)
- LiteLLM API key (if required by your setup)

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
2. Open VS Code's chat interface
3. Click the model picker → "Manage Models..." → "LiteLLM"
4. Add a server: enter a label, base URL (e.g., `http://localhost:4000`), and API key
5. Select models to add

The extension also ships a walkthrough covering these steps: run "Welcome: Open Walkthrough..." from the Command Palette and pick "Get started with LiteLLM for Copilot Chat".

## Configuration

### Where to configure things

Configuration lives in two interchangeable places: the dashboard (a GUI over all of it) and plain VS Code settings. Per-model options and one-off actions have their own surfaces, listed below.

| What | Where | How to open |
|------|-------|-------------|
| Servers: label, base URL, API key, OAuth | Dashboard, or the `litellm-vscode-chat.servers` setting | Command Palette → "LiteLLM: Open Dashboard", or Settings → search "litellm-vscode-chat" |
| Per-model options (thinking effort) | Copilot Chat model picker | Select a LiteLLM model, then click the effort label next to the model name in the chat input |
| Global knobs (timeouts, caching, headers, `modelParameters`) | Dashboard or VS Code settings | Same as above |
| Actions (test connection, sync models, diagnostics, report issue) | Commands | Command Palette → type "LiteLLM", or the "Manage LiteLLM Provider" menu |

### Dashboard

"LiteLLM: Open Dashboard" opens one panel with everything on it: a status strip (overall connection state, server and model counts, last sync), the server list with an inline add/edit form, every discovered model with a filter box, token limits, pricing, and capability badges, and the extension's settings as editable form controls.

The dashboard is a view over the same stores the rest of the extension uses. Settings edits write to your VS Code settings (to the scope where the value is already set, otherwise to user settings), and the buttons run the same commands the Command Palette offers. Server edits write the `litellm-vscode-chat.servers` setting described below; for each secret field the form lets you choose between VS Code secret storage (the default) and an inline settings value. Secrets in secret storage never render back into the dashboard - for them the form shows where the value lives, not what it is. Inline values do prefill the edit form, masked behind a Show toggle: they already sit in plain text in your settings.json, so the form reveals nothing the Settings editor does not. Header values are settings, not secrets: they show up exactly as they do in the Settings editor, so keep secret headers in User scope rather than workspace scope.

Two settings are easier to edit here than in the Settings UI: `modelParameters` and `headers` are objects the native settings GUI cannot edit, so the dashboard gives them row editors. Model parameter values are JSON (`0.2`, `true`, `"text"`, `["stop"]`); invalid input is flagged and Apply stays disabled until every row parses. Because VS Code merges object settings across scopes, each editor works on one scope at a time (the one your edits write to) and lists entries from other scopes read only, so applying a change never copies user-scope values into workspace files.

### Server Management

The extension supports connecting to multiple LiteLLM servers at once. Models from all reachable servers are aggregated into one list.

Servers are declared in the `litellm-vscode-chat.servers` setting - an array of entries the extension syncs to VS Code provider groups automatically, on activation and whenever the setting changes. The setting is machine-scoped: it lives in your user settings only, a workspace cannot override it (so a cloned repository can never re-point your servers at another host), and Settings Sync does not carry it to other machines. The dashboard's add/edit form writes the same setting, so both paths stay in step:

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

The secret fields (`apiKey`, `oauthClientSecret`, `virtualKeyValue`) are per-entry choices: write them inline when a plaintext value in your settings file is acceptable, or leave them out and store them in VS Code secret storage instead - through the dashboard form's "store securely" option or the "LiteLLM: Set Server Secret" command. An inline value takes precedence over a stored one.

Two asymmetries to know about:

- The `label` is the entry's identity. The provider group is named after it, so renaming an entry creates a new group; the old one stays until you remove it.
- Removing an entry stops the extension from managing that server, but VS Code offers no API to remove the group itself. The extension points you at the native Manage Language Models editor (Command Palette → "Manage LiteLLM Provider" → Manage Language Models), where group removal lives.

Servers added directly in the native editor still work; the dashboard shows them marked "external" since they have no settings entry. An external row's Edit action adopts the server: it copies the group's connection details into a new `litellm-vscode-chat.servers` entry, so the server becomes editable like any declared one. You pick the entry's label and where each secret is stored (secret storage or inline in settings); the credential values are copied inside the extension and never pass through the dashboard page. Adoption does not remove the original group - VS Code has no API for that - so its models appear twice until you delete the group in the native editor. The dashboard reminds you of this after adopting.

One host limitation cuts across all of this: VS Code's provider-group command can create groups but not update or remove them. When a declared entry's connection changes (URL or credentials), the extension cannot push the change into the existing group; the server row shows an error telling you to remove the group in the native editor and run Sync Models Now, which recreates it from the entry. For the same reason, an edit made natively to a declared group stays in place until that group is removed and re-synced.

### OAuth Authentication (Optional)

Some LiteLLM gateways sit behind an identity provider and reject static API keys. For those, configure OAuth2 client-credentials authentication on the server entry: in the dashboard form the fields sit behind "OAuth and virtual key (optional)", and in the `litellm-vscode-chat.servers` setting they are per-entry keys. (For external servers managed in the native "Manage Language Models" editor, the same fields appear there.)

| Dashboard field | Setting key | Description |
|-----------------|-------------|-------------|
| OAuth token URL | `oauthTokenUrl` | The identity provider's token endpoint, e.g. `https://idp.example.com/oauth2/token` |
| OAuth client ID | `oauthClientId` | Client ID for the client-credentials grant; required together with the token URL |
| OAuth client secret | `oauthClientSecret` | Client secret; keep it in secret storage or write it inline |
| OAuth scopes | `oauthScopes` | Optional space-separated scopes to request with the token |
| Virtual key header | `virtualKeyHeader` | Optional name of a custom header carrying a LiteLLM virtual key, e.g. `x-litellm-api-key` |
| Virtual key value | `virtualKeyValue` | The virtual key itself; keep it in secret storage or write it inline |

When the token URL and client ID are both set, the extension exchanges the client credentials for a short-lived bearer token and sends it as the `Authorization` header on every request to that server, refreshing it shortly before it expires. A static API key configured on the same server keeps going out as the `X-API-Key` header alongside the bearer token, for gateways that check both. If the gateway additionally expects a virtual key, set both virtual key fields and the header is sent along with every request. The token exchange is bounded by the discovery timeout, and a rejected token is discarded so the next request fetches a fresh one.

### Token Limits (Automatic)

The extension automatically reads token limits from your LiteLLM server's model info. You can configure fallback defaults in VS Code settings:

**To access**: `Ctrl+,` / `Cmd+,` → Search "litellm-vscode-chat"

| Setting | Default | Description |
|---------|---------|-------------|
| `litellm-vscode-chat.defaultMaxOutputTokens` | `16000` | Max tokens per response (fallback) |
| `litellm-vscode-chat.defaultContextLength` | `128000` | Total context window (fallback) |
| `litellm-vscode-chat.defaultMaxInputTokens` | `null` | Max input tokens (auto-calculated if null) |

**Priority**: LiteLLM model info → Workspace settings → Defaults

### Custom Model Parameters (Optional)

Override default request parameters for specific models using the `modelParameters` setting. This is useful for models with specific requirements (like gpt-5 requiring `temperature: 1`) or to customize behavior per model.

**To configure**: Add to your `settings.json`:

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

**Supported parameters:**
- `max_tokens` - Maximum tokens in response
- `temperature` - Randomness (0.0-2.0)
- `top_p` - Nucleus sampling (0.0-1.0)
- `frequency_penalty` - Reduce repetition (-2.0 to 2.0)
- `presence_penalty` - Encourage new topics (-2.0 to 2.0)
- `stop` - Stop sequences (string or array)
- `response_format` - Structured output / JSON mode
- `reasoning_effort` - Thinking/reasoning control (for supported models)
- `seed` - Deterministic output
- And any other parameter supported by your LiteLLM and model provider backend

All non-reserved `modelParameters` keys are passed through to LiteLLM: the extension does not restrict which parameters you can set, and it never injects parameters you did not set. When you configure nothing, your model provider's own defaults apply. Keys starting with `_` are reserved for extension metadata and are never forwarded. Temperature stays free-form here on purpose: the model picker's Configure Model menu can only render fixed choices, so the extension does not add temperature presets there.

**Prefix matching**: Configuration keys use longest prefix matching. For example, `"gpt-4"` will match `"gpt-4-turbo:openai"`, `"gpt-4:azure"`, etc. More specific keys take precedence.

**Server-scoped parameters**: Prefix a key with the server's base URL and `/` to scope parameters to that server (write the base URL without any trailing slash). Server-scoped entries take priority over unscoped ones, and within a scope the longer model prefix wins:

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

Servers that VS Code manages as provider groups - everything the `servers` setting or the native editor creates - match by base URL. Servers that came from the pre-migration server list also still match by their old label (for example `Production/gpt-4`), as long as the label and its base URL map one-to-one (a label that pointed at several URLs, or a URL that carried several labels, loses label scoping); when both forms could match, the more precise model prefix wins no matter how long the server part of the key is. A server still in the legacy server list matches by label only.

**Parameter precedence**: Runtime options > model picker choices > user config. Any parameter left unset by all three falls through to your model provider's defaults (`max_tokens` is the exception: the extension always sends one - the output limit your server declares in model info, or at most 4096 when the server declares none).

### Reasoning Effort (Model Picker)

Models that advertise reasoning support (`supports_reasoning`, or `reasoning_effort` among their supported params) get an effort control in Copilot's model picker: select the model, then click the "Thinking Effort" label next to the model name in the chat input. (The Manage Language Models editor shows the same control as "Reasoning Effort".) Pick a level from Off through Extra High and VS Code remembers the choice for that model; every request then carries `reasoning_effort` accordingly ("Off" goes out as `reasoning_effort: "none"`, which turns thinking off on models that support that). Pick "Provider default" (the initial state) to send nothing and let your provider decide. A `reasoning_effort` in `modelOptions` at request time still wins over the picker.

The menu is the same for every reasoning model because LiteLLM reports which models take `reasoning_effort` but not which values each one accepts. If you pick a level your model rejects (say, Extra High on a model that stops at High), the request fails with the server's own error message; pick a different level and retry.

### Prompt Caching (Anthropic Claude)

The extension supports prompt caching for models that advertise this capability (currently Anthropic Claude models). It spends Anthropic's four cache breakpoints per request on the parts that stay identical across the turns of an agent session: the tool definitions, the system prompt, the first user message, and the last text-bearing message. Each turn then reuses the prefix the previous turn cached instead of re-paying full input price for the tools and the whole conversation history.

**To configure**: Add to your `settings.json`:

```json
{
  "litellm-vscode-chat.promptCaching.enabled": true
}
```

**How it works:**
- Automatically detects prompt caching support from LiteLLM's `/v1/model/info` endpoint
- Only affects models that explicitly support prompt caching (primarily Claude models)
- Adds `cache_control` breakpoints to the last tool definition, the system message, the first user message, and the last text-bearing message (a trailing tool-call-only or image-only message is skipped) - at most four per request, Anthropic's limit
- Uses Anthropic's ephemeral cache markers with no explicit TTL, so the cache lifetime is the provider's default (currently about 5 minutes for Anthropic); the extension does not set or extend this duration
- Disabled by default for models without support

**Benefits:**
- Reduced API costs (cached tokens are cheaper), most visibly in agent mode where tools and history dominate the request
- Faster response times (cached content doesn't need reprocessing)
- Transparent to the user (works automatically when supported)

### Request Timeouts

Configure timeout values for different types of requests. This is useful if you're experiencing timeout errors with long-running requests or slow network connections.

**To configure**: Add to your `settings.json`:

```json
{
  "litellm-vscode-chat.requestTimeout": 600000,
  "litellm-vscode-chat.discoveryTimeout": 60000
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `litellm-vscode-chat.requestTimeout` | `300000` (5 minutes) | Timeout for chat completion requests in milliseconds |
| `litellm-vscode-chat.discoveryTimeout` | `30000` (30 seconds) | Timeout for model discovery requests in milliseconds |

**When to increase timeouts:**
- Your requests are timing out with complex prompts or large context windows
- Your LiteLLM server is slow or has high latency
- You're using models that take a long time to generate responses (e.g., with extensive reasoning)

**Note**: Minimum timeout is 1000ms (1 second) for both settings.

### Model List Caching

VS Code re-resolves language model providers often, sometimes several times within a second. To avoid hammering your server's `/v1/model/info` endpoint, the extension caches each server's discovered model list for one hour by default. Failed lookups are never cached, and simultaneous refreshes share a single request.

```json
{
  "litellm-vscode-chat.discoveryCacheTtl": 3600000
}
```

Lower the value (milliseconds) if models change often on your server, or set it to `0` to fetch on every refresh. To pick up server-side changes right away, run **LiteLLM: Sync Models Now** from the Command Palette; **LiteLLM: Test Connection** also refreshes over the network.

### Custom HTTP Headers

You can attach custom headers to every LiteLLM request (both model discovery and chat completions). This is useful when your gateway expects non-standard auth headers like `x-litellm-api-key`.

**Security note**: Header values are stored in VS Code settings; if they include secrets, prefer **User** settings (not workspace) and avoid committing `.vscode/settings.json` to source control.
```json
{
  "litellm-vscode-chat.headers": {
    "x-litellm-api-key": "your-gateway-key",
    "x-routing-env": "prod"
  }
}
```

Custom headers are merged into every request. If an API key is configured in the server manager, extension-managed auth headers (`Authorization` and `X-API-Key`) still take precedence.

If a header value is secret (for example, API keys), set `litellm-vscode-chat.headers` in User settings instead of workspace settings to reduce the risk of committing secrets.

## Troubleshooting

### Local LiteLLM stack (Docker or Podman)

For local testing you can run a real LiteLLM proxy in Docker, backed by a fake OpenAI server. The fake serves six realistic models and takes its instructions from the chat input itself: a `%` command on the last line of your message picks the response shape, so one model can play every stream shape the extension handles. The sigil is `%` because the obvious choices are both intercepted before they reach the model: Copilot Chat claims `/`-prefixed input for its own slash commands, and agent CLIs like Claude Code run a leading `!` as a shell command, while no chat input surface claims `%`.

```bash
cp .env.example .env   # optional; only needed for real provider keys or port changes
bun run docker:up
```

Then add a server in the extension with base URL `http://localhost:4000` and API key `sk-test-1234`.

The model list is deliberately small and shaped like a real deployment (`src/test/fakeStack/models.ts`): `claude-opus-4-5` (everything on: reasoning, caching, tiered pricing, 1M context), `gpt-5.2` (a load-balanced pair), `gpt-5.2-mini` (the everyday target), `gpt-5.2-omni` (audio flags), `deepseek-r2` (reasoning without tools), and `llama-4-scout` (nothing declared). A seventh entry, `gpt-4-turbo`, is blocked in the config and must never appear in the picker - that absence is itself under test.

Pick any of them in the Copilot model picker and type a command as your message. `%help` lists everything; the ones you will reach for first:

```
%help                     list all commands and playback scenarios
%play:thinking-blocks     play a canned stream shape (the library lives in src/test/scenarios.ts)
%echo:any text            reply with exactly that text
%echon:one\ntwo           multi-line echo: \n decodes to a newline, \\ keeps a backslash
%text:200                 a deterministic 200-word paragraph
%think:5                  reasoning chunks, then a closing text
%tool:get_weather {}      call an offered tool, then summarize its result on the next turn
%image, %audio            byte-stable generated media carrying their own sha256
%params, %messages, %attachments, %tools   inspect what actually reached the backend
%cache, %deployment       cache_control marker positions; which upstream served the request
%error:429, %finish:length, %stream:50:100, %delay:2000   error, truncation, pacing shapes
%abort:3, %nodone:5, %stall:3:30000   transport failures: dropped socket, missing [DONE], silent stall
```

A message without a command gets a fixed reply pointing at `%help`. Everything is deterministic: the same conversation produces the same bytes.

The proxy config is generated at stack startup (`docker/.generated/litellm-config.yaml`, gitignored) from `src/test/fakeStack/models.ts`. With a real provider key set in `.env` or the environment, the generated config also routes `openai/*` or `anthropic/*` model names through the proxy to that provider - the intended way to eyeball real-provider behavior through the same stack - and turns on LiteLLM's `check_provider_endpoint`, which expands the wildcard into the provider's live catalog on `/v1/models` for direct API consumers of the proxy. The extension's picker reads `/v1/model/info`, where a wildcard route appears as its literal entry (`openai/*`). Without a key the wildcard route is not emitted at all, so there are no phantom catalog models and no misleading 401s. GitHub Copilot works differently (its API takes a device-flow login, not an API key): run `bun run copilot-login` once, and every stack start fetches your live Copilot catalog and emits a `github_copilot/<model>` route per model. Set `LITELLM_WILDCARD_ALL=1` to add a bare `*` passthrough for anything else LiteLLM can infer. The docker test suite always generates without these routes, so local keys never change test results.

Useful commands:

```bash
bun run test:docker    # run the docker test suites against the stack (starts and stops it)
bun run docker:logs    # follow container logs
bun run docker:down    # stop the stack and remove volumes
bun run generate-config  # print the generated LiteLLM config to stdout (never writes; startup writes the real file)
bun run copilot-login    # one-time GitHub device flow; stack starts then emit github_copilot/<model> routes
```

The stack also works with Podman: the scripts try `docker compose` first, then `podman compose`, and `COMPOSE_CMD` overrides the choice. The compose provider must support `up --wait`; Podman with the docker-compose provider does, while older `podman-compose` releases may not. On SELinux hosts, change the bind mounts in `docker-compose.yml` from `:ro` to `:ro,z`. Always start the stack through `bun run docker:up` (or `dev` / `test:docker`): those paths generate `docker/.generated/litellm-config.yaml` first. Invoking `docker compose up` directly is unsupported - without the generation step the read-only directory mount materializes empty and the litellm container exits on a missing config.

The host-fidelity suite runs against a built-in capture server as part of `bun run test`; to point it at the stack (or any live server) instead, opt in with `LITELLM_REAL_LIVE=1` and set its connection variables:

```bash
bun run compile && bun run bundle:dev && \
  LITELLM_REAL_LIVE=1 LITELLM_REAL_BASE_URL=http://localhost:4000 LITELLM_REAL_API_KEY=sk-test-1234 LITELLM_REAL_MODEL=gpt-5.2-mini \
  bunx vscode-test --config .vscode-test.mjs --label host-fidelity
```

On Windows PowerShell:

```powershell
bun run compile; bun run bundle:dev
$env:LITELLM_REAL_LIVE = "1"; $env:LITELLM_REAL_BASE_URL = "http://localhost:4000"
$env:LITELLM_REAL_API_KEY = "sk-test-1234"; $env:LITELLM_REAL_MODEL = "gpt-5.2-mini"
bunx vscode-test --config .vscode-test.mjs --label host-fidelity
```

Without `LITELLM_REAL_LIVE=1` the other `LITELLM_REAL_*` variables are ignored, so exporting them in your shell never turns a regular test run live.

### Status Bar Indicator

The LiteLLM status bar indicator (bottom right corner) shows your connection status:

| Icon | Status | Description |
|------|--------|-------------|
| `⚠ LiteLLM` | Not Configured | No servers configured - click to set up |
| `⟳ LiteLLM` | Loading | Fetching models from servers |
| `✓ LiteLLM (N)` | Connected | All servers reachable with N models available |
| `⚠ LiteLLM (N)` | Degraded | Some servers unreachable, N models from reachable servers |
| `✗ LiteLLM` | Error | All servers failed - click for diagnostics |

Click the status bar indicator at any time to view detailed diagnostics.

### Test Your Connection

After configuring the extension, verify your setup:

1. **Command Palette**: `Ctrl+Shift+P` / `Cmd+Shift+P` → "LiteLLM: Test Connection"
2. Or click "Test Connection" after saving configuration

This will:
- Attempt to connect to your LiteLLM server
- Show the number of models found
- Display detailed error messages if connection fails
- Update the status bar with results

### Diagnostic Tools

**View Diagnostics**
- **Command Palette**: `Ctrl+Shift+P` / `Cmd+Shift+P` → "LiteLLM: Show Diagnostics"
- Or click the status bar indicator

Shows:
- Configured servers with labels and URLs
- Per-server connection state, model count, and errors
- Overall connection status and total model count
- Last check timestamp
- Quick access to output channel

**Help & Feedback**
- **Command Palette**: `Ctrl+Shift+P` / `Cmd+Shift+P` → "LiteLLM: Help & Feedback"
- Also accessible from the diagnostics dialog

Quickly report bugs, request features, or open the documentation.

**Output Channel**

View detailed logs for debugging:
1. Open Output panel: `Ctrl+Shift+U` / `Cmd+Shift+U`
2. Select "LiteLLM" from the dropdown

The output channel logs:
- Configuration changes
- Model fetch attempts and results
- Error messages with full details
- Server response information

### Common Issues

**"No models appear in the model picker"**
- Check the status bar - it will show the actual state
- Click "Test Connection" to verify your setup
- Check the "LiteLLM" output channel for error details
- Verify your LiteLLM server is running and accessible

**"Server returned 0 models"**
- Your LiteLLM proxy is running but has no models configured
- Check your LiteLLM proxy configuration (`litellm_config.yaml`)
- Run `litellm --config your_config.yaml` to start the proxy with models

**"Authentication failed"**
- Your server requires an API key
- Run "Manage LiteLLM Provider" and edit the server to update its API key
- Verify the key is correct in your LiteLLM proxy configuration

**"Connection Error: Unable to connect"**
- Verify the base URL is correct (e.g., `http://localhost:4000`)
- Ensure your LiteLLM proxy is running
- Check firewall/network settings

## Development

```bash
git clone https://github.com/Vivswan/litellm-vscode-chat
cd litellm-vscode-chat
bun install
bun run compile
```

Press `F5` to launch the Extension Development Host.

| Command | Description |
|---------|-------------|
| `bun run compile` | Build |
| `bun run watch` | Watch mode |
| `bun run lint` | Lint |
| `bun run format` | Format |
| `bun run test` | Run tests |

## Acknowledgments

This extension is better because people took the time to report what broke and
build what was missing. Contributors are credited in
[ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md); going forward, commits landing
community code carry co-author trailers, and commits resolving community
reports credit the reporter in the subject, which release-please carries
into the [changelog](CHANGELOG.md).

## Resources

- [LiteLLM Documentation](https://docs.litellm.ai)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Report Issues](https://github.com/Vivswan/litellm-vscode-chat/issues)
