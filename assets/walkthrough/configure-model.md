## Configure per-model options

Models that support reasoning get an effort control in the model picker: select the model, then click the "Thinking Effort" label next to the model name in the chat input. Pick a level and it is sent with every request to that model; "Provider default" sends nothing, so the server's own default applies. The menu's levels follow your `models.capabilities` records and the server's per-level flags, defaulting to Off through Max; a model that still rejects a picked level answers with its own error message.

Free-form request parameters (temperature, top_p, stop sequences, and so on) are set per model in the `litellm-vscode-chat.models.parameters` setting instead.
