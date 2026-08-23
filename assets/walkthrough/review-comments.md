## Get AI review comments

Two settings turn the feature on, both under the extension's settings:

- `litellm-vscode-chat.reviewComments.enabled`: the opt-in; nothing is sent until you enable it, apart from the dashboard's explicit "Test model" button
- `litellm-vscode-chat.reviewComments.model`: the model that writes the comments, e.g. `{ "server": "Team proxy", "model": "gpt-4o-mini" }`

Once both are set, two commands appear: "LiteLLM: Review Changes" reads every uncommitted change in a repository, one file at a time, and "LiteLLM: Review This File" reads the file you are looking at. Either way the findings arrive as comment threads on the lines they are about, the same UI a pull request review uses.

A thread is a conversation, not a verdict. Reply in it and the model answers in the same thread with the surrounding code in view; resolve the ones you have dealt with, delete the ones you disagree with. Reviewing the same file again replaces its model-written comments, so a second pass never stacks duplicates; threads you have spoken in are kept.
