# LiteLLM Provider for GitHub Copilot Chat

Use 100+ LLMs in VS Code with GitHub Copilot Chat powered by [LiteLLM](https://docs.litellm.ai)

## ⚡ Quick Start
1. Install the LiteLLM Copilot Chat extension [here](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat).
2. Open VS Code's chat interface.
3. Click the model picker and click "Manage Models...".
4. Select "LiteLLM" provider.
5. Provide your LiteLLM base URL (e.g., `http://localhost:4000` for self-hosted or your LiteLLM proxy URL).
6. Provide your LiteLLM API key (if required).
7. Choose the models you want to add to the model picker.

Each model entry also offers `cheapest` and `fastest` mode for each model. `fastest` selects the provider with highest throughput and `cheapest` selects the provider with lowest price per output token.

## ✨ Why use the LiteLLM provider in Copilot
* Access 100+ LLMs from OpenAI, Azure, Anthropic, Google, AWS, and more through a single unified API.
* Single API to switch between multiple providers.
* Built for high availability and low latency.
* Self-hosted or cloud-based options.
* Support for streaming, function calling, and vision models.

## Requirements
* VS Code 1.108.0 or higher.
* LiteLLM proxy running (self-hosted or cloud).
* Optional: LiteLLM API key depending on your setup.
**Need help getting started?**
* On first run, you'll see a welcome notification with setup options
* The status bar indicator shows your configuration state at all times
* Click the status bar item or use Command Palette to configure

## 🛠️ Development
```bash
git clone https://github.com/Vivswan/litellm-vscode-chat
cd litellm-vscode-chat
npm install
npm run compile
```
Press F5 to launch an Extension Development Host.

Common scripts:
* Build: `npm run compile`
* Watch: `npm run watch`
* Lint: `npm run lint`
* Format: `npm run format`

## 📚 Learn more
* LiteLLM documentation: https://docs.litellm.ai
* VS Code Chat Provider API: https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider

## Support

* Open issues: https://github.com/Vivswan/litellm-vscode-chat/issues
