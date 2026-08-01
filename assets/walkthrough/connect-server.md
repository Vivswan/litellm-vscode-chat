## Connect your LiteLLM server

The LiteLLM dashboard is where servers live. Add yours and fill in:

- Label: a unique name; the model picker groups your models under it
- Base URL: your LiteLLM proxy address, for example `http://localhost:4000`
- API Key: leave empty if your server does not require one

Servers behind an identity provider can use the OAuth fields instead of a static key, and gateways that expect a virtual key have their own header fields.

Each server you add becomes its own group of models in the chat model picker. Prefer plain files? The dashboard writes the `litellm-vscode-chat.servers` array in your user settings JSON; editing that array works just as well.
