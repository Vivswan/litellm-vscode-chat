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

- VS Code 1.108.0 or higher
- LiteLLM proxy running (self-hosted or cloud)
- LiteLLM API key (if required by your setup)

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
2. Open VS Code's chat interface
3. Click the model picker → "Manage Models..." → "LiteLLM"
4. Add a server: enter a label, base URL (e.g., `http://localhost:4000`), and API key
5. Select models to add

## Configuration

### Server Management

The extension supports connecting to multiple LiteLLM servers at once. Models from all reachable servers are aggregated into one list.

To manage servers:
- **Command Palette**: `Ctrl+Shift+P` / `Cmd+Shift+P` → "Manage LiteLLM Provider"
- **Model Picker**: Chat interface → Model picker → "Manage Models..." → "LiteLLM"

From the server manager you can:
- **Add Server** — provide a unique label, base URL, and optional API key
- **Edit Server** — update label, URL, or API key
- **Remove Server** — delete a server and its stored credentials
- **Test All Servers** — verify connectivity to every configured server

If no servers are configured, the "Manage" command jumps straight to the add flow.

Credentials are stored securely in VS Code's secret storage. Server metadata (label, URL) is stored in global state.

**Upgrading from single-server**: Existing single-server configurations are automatically migrated into the server registry on first run.

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

All `modelParameters` keys are passed through to LiteLLM — the extension does not filter or restrict which parameters you can set. The reserved key `_replaceDefaults` is extension metadata and is never forwarded.

**Built-in defaults**: The extension applies `temperature: 0.7` by default. Some models (e.g., `gpt-5.5`) have built-in overrides that suppress the default temperature. User `modelParameters` entries merge on top of these defaults.

**`_replaceDefaults`**: Set `"_replaceDefaults": true` in a model entry to skip built-in request-parameter defaults for that model (for example, the default `temperature`) and use only the request parameters you supply from configuration:

```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-4": {
      "_replaceDefaults": true,
      "top_p": 0.9
    }
  }
}
```

**Prefix matching**: Configuration keys use longest prefix matching. For example, `"gpt-4"` will match `"gpt-4-turbo:openai"`, `"gpt-4:azure"`, etc. More specific keys take precedence.

**Server-scoped parameters**: In multi-server setups, prefix a key with the server label and `/` to scope parameters to a specific server. Server-scoped entries take priority over unscoped ones:

```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-4": {
      "temperature": 0.7
    },
    "Production/gpt-4": {
      "temperature": 0.3
    },
    "Dev/gpt-4": {
      "temperature": 0.9
    }
  }
}
```

**Parameter precedence**: Runtime options > User config > Defaults

### Prompt Caching (Anthropic Claude)

The extension supports prompt caching for models that advertise this capability (currently Anthropic Claude models). When active, it places up to Anthropic's maximum of **4 `cache_control` breakpoints** per request so that the entire cacheable prefix — tools, system prompt, first user message, and the rolling conversation history — is reused on every subsequent agent round-trip. In a long agent session this typically reduces input-token cost by **70–80%**.

Each breakpoint can use one of two cache lifetimes (TTL):

- **5m** — the default ephemeral cache (cheaper write, expires after 5 minutes of inactivity).
- **1h** — an extended cache (more expensive write, repaid after a single reuse beyond the 5-minute window). Ideal for the stable head of long agent sessions.

**To configure**: Add to your `settings.json`:

```json
{
  "litellm-vscode-chat.promptCaching.mode": "auto"
}
```

`mode` is the single high-level switch. The other three settings are optional fine-tuners.

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `promptCaching.mode` | `off` \| `chat` \| `agent` \| `auto` | `auto` | The caching strategy (see table below). |
| `promptCaching.tokenSizeAutoBreakpoint` | number (4000–16000) | `8000` | Deprecated compatibility setting; `auto` mode no longer uses this to choose TTLs. |
| `promptCaching.minCacheTokens` | number (256–4096) | `4096` | The minimum estimated block size for a breakpoint to be placed at all. Blocks below this floor are skipped (the provider won't cache a prefix shorter than its minimum). Applies in every mode. |
| `promptCaching.rollingLastMessage` | `always` \| `stableTurnsOnly` \| `never` | `stableTurnsOnly` | Where the rolling-last breakpoint is placed. Orthogonal to `mode` (which controls the TTL). |

**Modes:**

| Mode | Tools | System | First user | Rolling-last | Best for |
|---|---|---|---|---|---|
| `off` | — | — | — | — | Disabling caching entirely. |
| `chat` | 5m | 5m | 5m | 5m | Short, bursty interactive conversations. |
| `agent` | 1h | 1h | 1h | 5m | Long agent runs over a long wall-clock window. |
| `auto` *(default)* | 1h | 1h | 1h | 5m | A balanced default that needs no tuning. |

In all modes, an anchor smaller than `minCacheTokens` is silently skipped, and the rolling-last anchor's *placement* is governed by `rollingLastMessage`.

**Rolling-last placement (`rollingLastMessage`):**

| Value | Behaviour |
|---|---|
| `always` | Tag whatever the last message is — even a volatile tool result. Maximum coverage, most fragile. |
| `stableTurnsOnly` *(default)* | Skip the breakpoint when the last message is a tool result (`role: "tool"`) and tag the most recent stable turn instead. Avoids full cache misses caused by tool-result bytes that change between turns. |
| `never` | Place no rolling-last breakpoint; keep only the static head anchors. |

**How it works:**

Anthropic allows up to 4 `cache_control` breakpoints per request. The extension can place them on the four highest-value positions, in canonical order:

| Breakpoint | What is cached | Why it matters |
|---|---|---|
| **Last tool** | The entire tools array | Tools are large and static across an agent session |
| **System message** | The system prompt | Always present, never changes within a session |
| **First user message** | The original task + everything before it | Stable for the whole session; survives the TTL window even as later messages change |
| **Last stable message** | The full conversation prefix up to the current turn | Ensures each agent round-trip reuses all prior turns |

If VS Code splits the system prompt across multiple leading system messages, only the final leading system message is tagged, so the system prompt consumes one breakpoint. If a conversation has only a single user message the first-user and rolling-last breakpoints merge into one, keeping the total at or below 4.

**Gating:**
- Automatically detects prompt caching support from LiteLLM's `/v1/model/info` endpoint
- Only affects models that explicitly advertise `supports_prompt_caching: true` (primarily Claude models)
- Non-Anthropic models are unaffected even if a non-`off` mode is selected
- When `promptCaching.mode` is `off`, zero `cache_control` markers are emitted anywhere

**1h TTL caveat:** the extended (`1h`) cache tier requires your LiteLLM gateway to forward the extended-cache-ttl beta to the backend. If the gateway strips it, those anchors silently fall back to the standard 5-minute cache (harmless — never an error). The diagnostic log prints the resolved TTL per anchor so you can correlate against your gateway's cache behaviour.

**Benefits:**
- Reduced API costs (cached tokens are billed at ~10% of normal input price)
- Faster response times (cached content is not reprocessed)
- Transparent to the user — works automatically when the model supports it
- Particularly effective for Copilot agent mode where the tools array and conversation history grow large across many round-trips

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

## Troubleshooting

### Mock LiteLLM Server (Local)

For quick manual testing, you can run a tiny mock LiteLLM server that serves a static model list and canned chat replies.

```bash
node scripts/mock-litellm-server.js
```

Optional port override:

```bash
PORT=4001 node scripts/mock-litellm-server.js
```

Then set your base URL to `http://localhost:4000` (or the port you chose).

### Status Bar Indicator

The LiteLLM status bar indicator (bottom right corner) shows your connection status:

| Icon | Status | Description |
|------|--------|-------------|
| `⚠️ LiteLLM` | Not Configured | No servers configured - click to set up |
| `⟳ LiteLLM` | Loading | Fetching models from servers |
| `✓ LiteLLM (N)` | Connected | All servers reachable with N models available |
| `⚠️ LiteLLM (N)` | Degraded | Some servers unreachable, N models from reachable servers |
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

## Resources

- [LiteLLM Documentation](https://docs.litellm.ai)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Report Issues](https://github.com/Vivswan/litellm-vscode-chat/issues)
