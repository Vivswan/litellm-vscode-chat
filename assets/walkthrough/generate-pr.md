## Generate pull request descriptions

Two settings turn the feature on, both under the extension's settings:

- `litellm-vscode-chat.prGeneration.enabled`: the opt-in; nothing is sent until you enable it, apart from the dashboard's explicit "Test model" button
- `litellm-vscode-chat.prGeneration.model`: the model that drafts the description, e.g. `{ "server": "Team proxy", "model": "gpt-4o-mini" }`

Once both are set, the command palette gains "LiteLLM: Generate Pull Request Description". It compares your branch against the branch it would be merged into, sends the commit messages and the patches to the model, and copies the drafted title and description to your clipboard.

With the GitHub Pull Requests extension installed, the feature also registers as "Generate with LiteLLM" in its Create Pull Request view, so the generate button there fills the title and description in place.
