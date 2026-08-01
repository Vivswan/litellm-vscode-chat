## Configure per-model options

Models that support reasoning get an effort control in the model picker: select the model, then click the "Thinking Effort" label next to the model name in the chat input. Pick a level from Off through Extra High and it is sent with every request to that model; "Provider default" sends nothing, so the server's own default applies. Models that accept only some levels reject the others with their own error message.

Free-form request parameters (temperature, top_p, stop sequences, and so on) are set per model in the `litellm-vscode-chat.modelParameters` setting instead.
