# Getting started

Install the extension, point it at a LiteLLM proxy, and its models show up in GitHub Copilot Chat's model picker. This page covers that first setup and where each kind of configuration lives afterwards.

## Requirements

- **VS Code 1.129.0 or higher**, with the GitHub Copilot Chat extension installed and signed in. This extension plugs into Copilot's chat view, so without it there is no chat interface and no model picker.
- **A running LiteLLM proxy**, self-hosted or cloud. A LiteLLM proxy is one server that exposes many LLM providers behind a single OpenAI-compatible endpoint; if you do not have one, LiteLLM's own [proxy quickstart](https://docs.litellm.ai/docs/proxy/quick_start) gets a local one running in a few commands.
- **A LiteLLM API key**, if your proxy requires one: usually an `sk-...` value, either the proxy's master key from its config or a [virtual key](servers.md#virtual-keys) issued by whoever runs the proxy.
  - If your company runs the server, ask its administrator.
  - Not sure whether yours needs one? "LiteLLM: Test Connection" reports an authentication error when it does.

The repository also ships a scriptable local proxy for trying things out; see [Development](development.md).

## First server

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
2. Open VS Code's chat interface: `Ctrl+Alt+I` / `Cmd+Ctrl+I`, or the chat icon in the title bar
3. Click the model picker → "Manage Models..." → "LiteLLM"
4. Add a server: enter a label, base URL (e.g., `http://localhost:4000`), and API key
5. Select models to add
6. Back in chat, open the model picker and choose one of the new models under your server's label, then send a message; Copilot stays on its default model until you pick one

The extension also ships a walkthrough covering these steps: run "Welcome: Open Walkthrough..." from the Command Palette and pick "Get started with LiteLLM for Copilot Chat".

You can equally start from the dashboard: run "LiteLLM: Open Dashboard" from the Command Palette and use its Add server form. The two paths store the server differently:

| Path | What it creates | What that gets you |
|------|-----------------|--------------------|
| Dashboard Add server form | A declared entry in the `litellm-vscode-chat.servers` setting | The more capable kind: editable from the dashboard, per-server [model parameters](model-parameters.md#per-entry-parameters) |
| Native Manage Models editor | A VS Code-managed group | Shown as "external" in the dashboard until you [adopt it](servers.md#external-servers-and-adoption) |

## Where to configure things

Configuration lives in two interchangeable places: the [dashboard](dashboard.md) (a GUI over all of it) and plain VS Code settings. Per-model options and one-off actions have their own surfaces:

| What | Where | How to open |
|------|-------|-------------|
| Servers: label, base URL, API key, OAuth | Dashboard, or the `litellm-vscode-chat.servers` setting | Command Palette → "LiteLLM: Open Dashboard", or Settings → search "litellm-vscode-chat" |
| Per-model options (thinking effort) | Copilot Chat model picker | Select a LiteLLM model, then click the effort label next to the model name in the chat input |
| Global knobs (timeouts, caching, headers, `modelParameters`) | Dashboard or VS Code settings | Same as above |
| Actions (test connection, sync models, diagnostics, report issue) | Commands | Command Palette → type "LiteLLM", or the "Manage LiteLLM Provider" menu |

## Commands

Everything the extension can do on demand is a Command Palette command (`Ctrl+Shift+P` / `Cmd+Shift+P`, then type "LiteLLM"):

| Command | What it does |
|---------|--------------|
| Manage LiteLLM Provider | The hub menu: manage servers and models, open the dashboard, run diagnostics |
| LiteLLM: Open Dashboard | The [dashboard](dashboard.md) panel: servers, models, and settings in one place |
| LiteLLM: Test Connection | Connects to each server and reports the model count or the exact error |
| LiteLLM: Sync Models Now | Refreshes the model lists immediately, bypassing the [discovery cache](settings.md#model-list-caching) |
| LiteLLM: Show Diagnostics | Opens the dashboard's [Diagnostics tab](dashboard.md#diagnostics): per-server connection state, model counts, errors, and the last check time |
| LiteLLM: Set Server Secret | Stores a server's API key, OAuth client secret, or virtual key in [secret storage](servers.md#secrets-and-secret-storage) |
| LiteLLM: Report Issue | Opens a prefilled GitHub issue; see [what it collects](troubleshooting.md#reporting-an-issue) |
| LiteLLM: Help & Feedback | Shortcuts to the documentation, bug reports, and feature requests |

## Checking the setup

The LiteLLM status bar item (bottom right) shows the connection state at a glance; run "LiteLLM: Test Connection" to verify a server end to end. If something is off, [Troubleshooting](troubleshooting.md) walks through the diagnostic tools and the common failure cases.

## Going further

- [Servers](servers.md) - multiple servers, secrets and secret storage, OAuth, virtual keys, and adopting servers added outside the extension
- [Models and capabilities](models.md) - what registers, capability gating, multimodal input and output, thinking, sources, and token usage
- [Model parameters](model-parameters.md) - sending request parameters like `temperature` or `reasoning_effort` per model, and how the extension decides what goes on the wire
- [Settings](settings.md) - every setting with its default: token limits, timeouts, caching, headers
- [Dashboard](dashboard.md) - what each part of the dashboard panel does
