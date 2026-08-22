## Inline completions

Two settings turn the feature on, both under the extension's settings:

- `litellm-vscode-chat.inlineCompletions.enabled`: the opt-in; nothing is registered and nothing is sent until you enable it
- `litellm-vscode-chat.inlineCompletions.model`: the model that writes the suggestions, e.g. `{ "server": "Team proxy", "model": "qwen2.5-coder-fim" }`

Pick a completions-capable model - one your LiteLLM server declares with `mode: completion`, which is also why it is absent from the chat model picker. Suggestions then appear as ghost text while you type, and the file content around your cursor goes to that server automatically as you go.

One more setting keeps it out of the wrong files: `inlineCompletions.languageFilter` takes a mode plus exact VS Code language IDs (block runs everywhere except the listed ones, allow only in them), and the "LiteLLM inline suggestions" row in the editor's `{}` language status menu toggles the current language for you.
