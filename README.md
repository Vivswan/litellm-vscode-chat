# LiteLLM Provider for GitHub Copilot Chat

Use 100+ LLMs in VS Code with GitHub Copilot Chat powered by [LiteLLM](https://docs.litellm.ai).

## Features

- Access 100+ LLMs (OpenAI, Anthropic, Google, AWS, Azure, and more) through a unified API
- Automatic provider selection with `cheapest` and `fastest` modes
- Support for streaming, function calling, and vision models
- Self-hosted or cloud-based deployment options

## Requirements

- VS Code 1.108.0 or higher
- LiteLLM proxy running (self-hosted or cloud)
- LiteLLM API key (if required by your setup)

## Quick Start

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
2. Open VS Code's chat interface
3. Click the model picker → "Manage Models..." → "LiteLLM"
4. Enter your LiteLLM base URL (e.g., `http://localhost:4000`)
5. Enter your API key (if required)
6. Select models to add

## Configuration

### Connection Settings

To update your base URL or API key:
- **Command Palette**: `Ctrl+Shift+P` / `Cmd+Shift+P` → "Manage LiteLLM Provider"
- **Model Picker**: Chat interface → Model picker → "Manage Models..." → "LiteLLM"

Credentials are stored securely in VS Code's secret storage.

### Token Limits

The extension uses token limits from LiteLLM model info when available. You can configure fallback defaults in VS Code settings:

**To access**: `Ctrl+,` / `Cmd+,` → Search "litellm-vscode-chat"

| Setting | Default | Description |
|---------|---------|-------------|
| `litellm-vscode-chat.defaultMaxOutputTokens` | `16000` | Max tokens per response |
| `litellm-vscode-chat.defaultContextLength` | `128000` | Total context window |
| `litellm-vscode-chat.defaultMaxInputTokens` | `null` | Max input tokens (auto-calculated if null) |

**Priority**: LiteLLM model info → Workspace settings → Defaults

## Development

```bash
git clone https://github.com/Vivswan/litellm-vscode-chat
cd litellm-vscode-chat
npm install
npm run compile
```
 
Press `F5` to launch the Extension Development Host.

| Command | Description |
|---------|-------------|
| `npm run compile` | Build |
| `npm run watch` | Watch mode |
| `npm run lint` | Lint |
| `npm run format` | Format |
| `npm test` | Run tests |

## Resources

- [LiteLLM Documentation](https://docs.litellm.ai)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Report Issues](https://github.com/Vivswan/litellm-vscode-chat/issues)
