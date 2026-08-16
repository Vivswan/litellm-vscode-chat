# LiteLLM Provider for GitHub Copilot Chat

[![Marketplace](https://vsmarketplacebadges.dev/version/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
[![Installs](https://vsmarketplacebadges.dev/installs/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
[![Rating](https://vsmarketplacebadges.dev/rating-short/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat&ssr=false#review-details)
[![CI](https://github.com/Vivswan/litellm-vscode-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/litellm-vscode-chat/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Individual%20%26%20Small%20Org%201.0.0-blue)](LICENSE.md)

English | [简体中文](README.zh-cn.md) | [繁體中文](README.zh-tw.md)

Use 100+ LLMs in VS Code with GitHub Copilot Chat powered by [LiteLLM](https://docs.litellm.ai).

## Features

- Access 100+ LLMs (OpenAI, Anthropic, Google, AWS, Azure, and more) through a unified API
- Multi-server support: connect to multiple LiteLLM servers simultaneously and aggregate models
- Automatic provider selection with `cheapest` and `fastest` modes, on gateways that report tool-capable per-provider routes ([details](docs/models.md))
- Multimodal input (vision, PDF/document attachments, text/JSON data) and generated image/audio output
- Streaming, function calling, and thinking/reasoning tokens
- Broad model options pass-through (`response_format`, `reasoning_effort`, `seed`, and more)
- Per-model capability overrides and declared models: correct what a gateway reports, or register models it cannot list at all, with gaps auto-filled from the OpenRouter catalog ([details](docs/models.md#capabilities))
- A dashboard panel for servers, models, and settings, with plain VS Code settings behind it
- Settings export and import: move servers, model records, and (on explicit choice) stored secrets to another machine, with a one-command undo ([details](docs/settings.md#export-and-import))
- Self-hosted or cloud-based deployment options

## Requirements

- VS Code 1.129.0 or higher, with the GitHub Copilot Chat extension installed and signed in
- LiteLLM proxy running (self-hosted or cloud)
- LiteLLM API key (if required by your setup)

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
2. Open VS Code's chat interface (`Ctrl+Alt+I` / `Cmd+Ctrl+I`, or the chat icon in the title bar)
3. Click the model picker → "Manage Models..." → "LiteLLM"
4. Add a server: enter a label, base URL (e.g., `http://localhost:4000`), and API key
5. Select models to add
6. Back in chat, pick one of the new models in the model picker and send a message

You can equally declare the server as a setting (user settings.json); the dashboard's Add server form ("LiteLLM: Open Dashboard") writes the same entry:

```jsonc
"litellm-vscode-chat.servers": [
	{ "label": "Local", "baseUrl": "http://localhost:4000", "auth": { "apiKey": "sk-..." } }
]
```

The extension also ships a walkthrough covering these steps: run "Welcome: Open Walkthrough..." from the Command Palette and pick "Get started with LiteLLM for Copilot Chat".

## Documentation

- [Getting started](docs/getting-started.md) - first server, the walkthrough, commands, and where to configure things
- [Servers](docs/servers.md) - multiple servers, secrets and secret storage, OAuth, virtual keys, adopting external servers
- [Models and capabilities](docs/models.md) - what registers, capability gating, multimodal input and output, usage reporting
- [Model parameters](docs/models.md#parameters) - per-model request parameters, prefix matching, precedence, reasoning effort
- [Model capabilities](docs/models.md#capabilities) - capability overrides, declared models, the OpenRouter catalog, expected discovery failures
- [Settings](docs/settings.md) - every setting with its default: token limits, timeouts, caching, headers
- [Dashboard](docs/dashboard.md) - the panel's destinations, the server form, and the record editors
- [Troubleshooting](docs/troubleshooting.md) - diagnostics, issue reporting, common problems, privacy, uninstall cleanup, migration notes
- [Development](docs/development.md) - building from source and the local Docker test stack

## Development

```bash
git clone https://github.com/Vivswan/litellm-vscode-chat
cd litellm-vscode-chat
bun install
bun run compile
```

Press `F5` to launch the Extension Development Host. [Development](docs/development.md) covers the local LiteLLM stack and the test suites; [CONTRIBUTING.md](CONTRIBUTING.md) covers how to submit a change.

## Privacy

Your prompts and completions travel only between VS Code and the LiteLLM servers you configure. One default-on exception: about once a week the extension refreshes its bundled catalog of model capabilities from `https://openrouter.ai/api/v1/models`, a public, unauthenticated model list - the request carries no prompts, no usage, and nothing about you or your servers. Set `litellm-vscode-chat.models.openRouterCatalog` to `false` to turn the refresh and the automatic matching off; explicit `_openrouter_model` directives keep working offline from the bundled snapshot. Details in [Model capabilities](docs/models.md#the-openrouter-catalog) and [Privacy and data](docs/troubleshooting.md#privacy-and-data).

## Acknowledgments

This extension is better because people took the time to report what broke and build what was missing. Contributors are credited in [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md); commits landing community code carry co-author trailers, and commits resolving community reports credit the reporter in the subject, which release-please carries into the [changelog](CHANGELOG.md).

## Resources

- [Privacy and data](docs/troubleshooting.md#privacy-and-data)
- [LiteLLM Documentation](https://docs.litellm.ai)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Report Issues](https://github.com/Vivswan/litellm-vscode-chat/issues)
