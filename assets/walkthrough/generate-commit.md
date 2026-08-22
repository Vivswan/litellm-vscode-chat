## Generate commit messages

Two settings turn the feature on, both under the extension's settings:

- `litellm-vscode-chat.commitGeneration.enabled`: the opt-in; nothing is sent until you enable it
- `litellm-vscode-chat.commitGeneration.model`: the model that drafts the message, e.g. `{ "server": "Team proxy", "model": "gpt-4o-mini" }`

Once both are set, a sparkle button appears in the Source Control title bar (and the command palette gains "LiteLLM: Generate Commit Message"). It sends your staged diff - or the working-tree diff when nothing is staged - to the model and writes the drafted message into the commit box.

The instruction is yours to change: `litellm-vscode-chat.commitGeneration.prompt` replaces the built-in Conventional Commits instruction wholesale, and your last five commit subjects always ride along as style examples.
