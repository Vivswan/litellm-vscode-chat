# Troubleshooting

The extension puts its state where you can see it: a status bar item for the connection at a glance, a diagnostics view for the details, and an output channel for the full log. This page covers those tools, issue reporting and privacy, timeout and retry semantics, the common failure cases, cleanup when uninstalling, and notes on migrations from older versions.

## Status bar

The LiteLLM status bar item (bottom right corner) shows your connection status:

| Icon | Status | Description |
|------|--------|-------------|
| `⚠ LiteLLM` | Not Configured | No servers configured - click to set up |
| `⟳ LiteLLM` | Loading | Fetching models from servers |
| `✓ LiteLLM (N)` | Connected | All servers reachable with N models available |
| `⚠ LiteLLM (N)` | Degraded | Some servers unreachable, N models from reachable servers |
| `✗ LiteLLM` | Error | All servers failed - click for diagnostics |

Click it at any time to view detailed diagnostics.

## Diagnostic tools

| Tool | What it gives you |
|------|-------------------|
| "LiteLLM: Test Connection" (Command Palette) | Verifies a server end to end: connects, reports the number of models found, shows detailed error messages on failure, and updates the status bar |
| "LiteLLM: Show Diagnostics" (or clicking the status bar item) | The configured servers with labels and URLs, per-server connection state, model counts and errors, the overall status, the last check timestamp, and a shortcut to the output channel |
| The "LiteLLM" output channel | The full log: configuration changes, model fetch attempts and results, and errors with full details. Open the Output panel (`Ctrl+Shift+U` / `Cmd+Shift+U`) and select "LiteLLM" from the dropdown |
| "LiteLLM: Help & Feedback" (also reachable from the diagnostics dialog) | The shortcut for reporting bugs, requesting features, or opening the documentation |

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
- The extension has no telemetry and no backend of its own; nothing is sent to the publisher.
- The one other outbound surface is the [issue reporter](#reporting-an-issue), which prepares everything locally, carries environment details and the extension's own logs (versions, platform, connection state, error classifications and stacks - never prompt or response text, never key values), and opens in your browser for review before anything is submitted.

Where credentials are stored, and what syncs between machines, is covered in [Servers](servers.md#secrets-and-secret-storage).

## Timeouts and retries

The two timeout settings are hard bounds on the whole call, streaming and any retries included; see [Settings](settings.md#request-timeouts) for their defaults.

- Model discovery requests are idempotent GETs, so a failed one is retried (up to twice, with the whole call still bounded by `discoveryTimeout`).
- Chat completions are never retried: a completion may have side effects (spend, tool calls), so the extension surfaces the failure instead of silently paying for a second attempt. If long requests get cut off, raise `requestTimeout`.
- When a background model refresh fails but the last successful discovery is recent (under ten minutes old), the extension keeps serving the last known model list, flagged stale with a warning icon, instead of dropping your models mid-session.

## Common issues

**"The chat interface or 'Manage Models...' is missing"**
- This extension plugs into GitHub Copilot Chat; without it there is no chat view and no model picker
- Install the GitHub Copilot Chat extension, sign in to GitHub, and make sure it is enabled
- On an older VS Code, update it: the extension needs 1.129.0 or higher

**"No models appear in the model picker"**
- Check the status bar - it shows the actual state
- Run "LiteLLM: Test Connection" to verify your setup
- Check the "LiteLLM" output channel for error details
- Verify your LiteLLM server is running and accessible

**"Server returned 0 models"**
- Your LiteLLM proxy is running but has no models configured
- Check your LiteLLM proxy configuration (`litellm_config.yaml`)
- Run `litellm --config your_config.yaml` to start the proxy with models

**"My embedding or image-generation model is missing from the picker"**
- Models whose LiteLLM `model_info.mode` names a non-chat endpoint (`embedding`, `image_generation`, `audio_speech`, `audio_transcription`, `rerank`, `moderation`) are left out of the chat picker on purpose, since a chat request to them can only fail; models with no declared mode always register
- Deployments the proxy has paused (`model_info.blocked`) are skipped too
- See [Models and capabilities](models.md#what-registers)

**"Attached images never reach the model"**
- Images (attachments, and images replayed from earlier turns) are sent only to models that declare vision support (`supports_vision`) in LiteLLM's model info
- On other models the text goes through and the images are dropped, with a note in the "LiteLLM" output channel
- See [Models and capabilities](models.md#multimodal-input)

**"Authentication failed"**
- The two 401 messages name different credentials. Plain "Authentication failed: Your LiteLLM server requires an API key" means the proxy rejected the extension's key: run "Manage LiteLLM Provider" and edit the server to update it, and verify the key against your LiteLLM proxy configuration
- "Authentication failed upstream" means the proxy accepted your key but could not authenticate to the model's upstream provider; updating the extension's key cannot help. Fix that provider's credentials on the LiteLLM server, or ask whoever runs it to

**"Connection Error: Unable to connect"**
- Verify the base URL is correct (e.g., `http://localhost:4000`)
- If you pasted a URL ending in `/v1`, remove that suffix: the extension appends `/v1` itself, so a `/v1` base URL requests `/v1/v1/...` and fails
- Ensure your LiteLLM proxy is running
- Check firewall/network settings

**"Message exceeds token limit (estimated N tokens, limit M)"**
- The extension rejects a request before sending it when its own token estimate exceeds the model's input budget. The count is a local estimate (roughly four characters per token for text, flat figures per image, PDF, or audio clip), so it can differ from what the server would bill
- Trim the conversation or drop attachments, or raise the budget: the limit comes from the server's declared input limit, or from the [`defaultContextLength`/`defaultMaxInputTokens` settings](settings.md#token-limits) when the server declares none

**"The model produced only reasoning output, which this version of VS Code could not display"**
- Your VS Code build lacks the thinking-part API, so streamed reasoning is dropped (with a note in the output channel), and a reply that contained nothing but reasoning fails with this error
- Update VS Code to a version that supports thinking parts, or use a model that returns final text

## Per-server model parameters are inactive

The dashboard shows a "params inactive" badge (and a banner naming the affected entries) when a server entry declares per-entry `modelParameters` but the VS Code provider group serving that server does not carry the entry's labeled identity. That happens when the group predates entry labels, or when a rename or base URL edit left a stale group behind; requests through such a group get only the global `modelParameters` setting.

Two ways to fix it:

- Remove the group in the native editor (Command Palette → "Manage LiteLLM Provider" → Manage Language Models) and run "LiteLLM: Sync Models Now"; the extension recreates the group from the entry, this time carrying its identity.
- Or save the entry under a new label; a new group is created for it. The old group stays until you remove it in the native editor.

## Label-scoped parameter keys were migrated

Versions up to 0.3.1 supported scoping `modelParameters` keys by server label (`Production/gpt-4`). Label scoping is gone; the replacements are per-entry `modelParameters` on the matching `servers` entry and base-URL scoping (`https://litellm.example.com/gpt-4`); see [Model parameters](model-parameters.md).

The extension rewrote user-settings keys automatically, once per machine:

- A label-scoped key whose label matches a declared `servers` entry (at the same base URL) was copied into that entry's `modelParameters`, under the bare model prefix. Keys already present in the entry were not overwritten, and a migrated key you later delete from the entry stays deleted.
- Otherwise the parameters were copied to a base-URL-scoped key in the global setting, next to the original.

The original keys were kept in both cases: a key like `openai/gpt-4o` may be a bare model prefix rather than a label scope, and the two readings cannot be told apart, so the migration copies instead of moving. With label matching gone, the originals are simply bare-prefix keys again.

Label-scoped keys in workspace or folder settings are not touched (those files are shared; the extension logs how many it found instead). Move them by hand, either into the entry's `modelParameters` or to the `<baseUrl>/<model prefix>` form.

## Uninstalling and cleanup

Uninstalling the extension does not remove two things, so clean them up first if you care about leftover credentials:

- Your `litellm-vscode-chat.*` settings stay in settings.json, including any inline API keys, OAuth client secrets, or virtual keys in the `servers` entries and any gateway key in `headers`. Remove them in the Settings editor or delete the lines from user settings.json.
- The VS Code provider groups the servers were synced to are host-owned and keep appearing in the Manage Language Models editor (with their own copies of the credentials) until you remove them there: Command Palette → "Manage LiteLLM Provider" → Manage Language Models.

Secrets kept in VS Code secret storage can be removed while the extension is still installed, through the edit form's "Remove the stored ..." checkboxes ([Servers](servers.md#secrets-and-secret-storage)); after uninstall, that storage belongs to VS Code's extension-data handling and is no longer reachable from the extension's own UI.
