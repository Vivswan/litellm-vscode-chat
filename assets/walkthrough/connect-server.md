## Connect your LiteLLM server

VS Code stores language model providers in its Manage Language Models editor. Pick LiteLLM there and fill in:

- Base URL: your LiteLLM proxy address, for example `http://localhost:4000`
- API Key: leave empty if your server does not require one

Servers behind an identity provider can use the OAuth fields instead of a static key, and gateways that expect a virtual key have their own header fields.

Each server you add becomes its own group of models in the chat model picker.
