## Configure per-model options

Models that support reasoning get an effort control in the model picker: select the model, then click the "Thinking Effort" label next to the model name in the chat input. Low, Medium, or High is sent with every request to that model; "Provider default" sends nothing, so the server's own default applies. The Manage Language Models editor shows the same control as "Reasoning Effort".

Free-form request parameters (temperature, top_p, stop sequences, and so on) are set per model in the `litellm-vscode-chat.modelParameters` setting instead.
