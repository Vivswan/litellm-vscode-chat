# Getting started

English | [简体中文](zh-cn/getting-started.md) | [繁體中文](zh-tw/getting-started.md)

Install the extension, point it at a LiteLLM proxy, and its models show up in GitHub Copilot Chat's model picker. This page walks that path once, end to end, then hands you five short recipes for the most common next steps.

## Requirements

- **VS Code 1.129.0 or higher**, with the GitHub Copilot Chat extension installed and signed in. This extension plugs into Copilot's chat view, so without it there is no chat interface and no model picker. If your Copilot seat comes from an organization (Copilot Business or Enterprise), the organization must also enable GitHub's "Bring your own language model key" policy - without it, Copilot hides models from provider extensions like this one even when every diagnostic reports connected.
- **A running LiteLLM proxy**, self-hosted or cloud. A LiteLLM proxy is one server that exposes many LLM providers behind a single OpenAI-compatible endpoint; if you do not have one, LiteLLM's own [proxy quickstart](https://docs.litellm.ai/docs/proxy/quick_start) gets a local one running in a few commands.
- **A LiteLLM API key**, if your proxy requires one: usually an `sk-...` value, either the proxy's master key from its config or a [virtual key](servers.md#authentication) issued by whoever runs the proxy.
  - If your company runs the server, ask its administrator.
  - Not sure whether yours needs one? The dashboard's Test connection reports an authentication error when it does.

The repository also ships a scriptable local proxy for trying things out; see [Development](development.md).

## Install and add a server

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat).
2. Run "LiteLLM: Open Dashboard" from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and click **Add server**.
3. Fill in the form:
   - **Label** - the name the model picker will show, e.g. `prod`.
   - **Base URL** - the server's root URL, e.g. `http://localhost:4000`. Leave any `/v1` suffix off; the extension appends it itself.
   - **Auth** - exactly one form: an API key (the common case), OAuth client credentials, or a key in a custom header. For a key, the form's "store securely" option puts it in VS Code [secret storage](servers.md#secrets-and-secret-storage) instead of your settings file - the default, and the right choice for anything you would not commit.
4. Click **Test connection**. It probes the draft exactly as entered and answers with the model count or the exact error, before anything is saved.
5. Click **Save**.

The form writes the `litellm-vscode-chat.servers` setting, so the same server in settings.json is one entry:

```jsonc
"litellm-vscode-chat.servers": [
  {
    "label": "prod",
    "baseUrl": "http://localhost:4000",
    "auth": { "apiKey": "sk-..." }   // or omit and store the key securely
  }
]
```

Both routes are equivalent - edit whichever you prefer, the dashboard and the setting stay in step. Every entry field, the other auth forms, and where secrets can live are on the [Servers](servers.md#entry-reference) page.

The extension also ships a walkthrough covering these steps: run "Welcome: Open Walkthrough..." from the Command Palette and pick "Get started with LiteLLM for Copilot Chat".

> Servers can also be added through VS Code's own model management ("Manage Models..." in the model picker). Those work, but exist outside the `servers` setting - the dashboard marks them "external" until you [adopt them](servers.md#external-servers-and-adoption). Starting from the dashboard skips that detour.

## First chat

Within moments of saving, the server's models are registered:

1. Open VS Code's chat interface: `Ctrl+Alt+I` / `Cmd+Ctrl+I`, or the chat icon in the title bar.
2. Open the model picker and choose a model under your server's label - Copilot stays on its default model until you pick one.
3. Send a message.

The LiteLLM status bar item (bottom right) shows the connection state at a glance - a check mark (`$(check) LiteLLM`) means every server is reachable, and its tooltip carries the model count. If models do not appear or something shows red, [Troubleshooting](troubleshooting.md#common-issues) resolves the common cases.

## Where to next

Five recipes, in the order people usually need them. Each shows the whole fix; the linked page has the depth.

### Correct a capability the server reports wrong

Your gateway says a model has an 8k context window, but you know it takes 131072 tokens? Capabilities come from the server, and anything you set in `models.capabilities` overrides them:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "deepseek-r1": { "context_length": 131072, "supports_reasoning": true }
}
```

The key is exact: it matches only the model ID `deepseek-r1`, nothing else. Vision, tool calling, and token limits work the same way. Details: [Models: capabilities](models.md#capabilities).

### Tune request parameters for a model family

Parameters you set are sent with every request to the matching models - and only parameters you set; the extension injects no defaults of its own:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "*":       { "temperature": 0.7 },   // every model
  "gpt-5*":  { "temperature": 0.3 }    // the gpt-5 family runs cooler
}
```

A trailing `*` makes a key a family matcher. Every matching key applies, and for each individual field the most specific match wins - so `gpt-5-turbo` gets 0.3, `claude-4` gets 0.7. Details: [Models: parameters](models.md#parameters) and [model matching](models.md#model-matching).

### Connect a gateway that cannot list its models

Some gateways serve chat but no `/v1/models`. Declare the models on the entry, and tell discovery not to treat the missing endpoints as an outage:

```jsonc
{
  "label": "gateway",
  "baseUrl": "https://gateway.internal",
  "auth": { "apiKey": "sk-..." },
  "discovery": {
    "expectedFailures": ["modelListing", "modelInfo"],
    "declared": ["gpt-5", "claude-4-sonnet"]
  }
}
```

The declared models register as if discovery had found them, and the server stays green. Details: [Servers: declared models](servers.md#declared-models).

### Set a budget and get warned before it runs out

Give the entry a budget in USD; alerts and the status bar do the rest:

```jsonc
{ "label": "prod", "baseUrl": "https://litellm.example.com", "budget": 50 }
```

With the default `usage.alertThresholds` of `[0.8, 0.95]`, you get one notification at 80% of $50 and another at 95%, and the usage status bar item shows the spend percentage - plain while you are under, on a warning background past 80%, on an error background past 95%. If your key already carries a LiteLLM `max_budget`, that works without any entry field at all. One requirement: spend tracking needs a LiteLLM server backed by a database ([requirements](usage.md#requirements)); on a proxy without one, the usage surfaces stay hidden and the `budget` field changes nothing. Details: [Usage: budgets](usage.md#budgets) and [alerts](usage.md#alerts).

### See why a value is what it is

When several matcher keys, a server entry, and the picker all have opinions, guessing is the slow way. Open the dashboard's Models tab and expand a model's inspectors: they list every effective parameter and capability with the exact source that set it - which matcher key, which server entry, the server's own report, or the OpenRouter catalog. Details: [Models: the inspectors](models.md#inspectors).

## Commands

Everything the extension can do on demand is a Command Palette command (`Ctrl+Shift+P` / `Cmd+Shift+P`, then type "LiteLLM"):

| Command | What it does |
|---------|--------------|
| Manage LiteLLM Provider | The hub menu: manage servers and models, open the dashboard, run diagnostics |
| LiteLLM: Open Dashboard | The [dashboard](dashboard.md) panel: servers, models, usage, and settings in one place |
| LiteLLM: Test Connection | Connects to each server and reports the model count or the exact error |
| LiteLLM: Sync Models Now | Refreshes the model lists immediately, bypassing the discovery cache |
| LiteLLM: Show Diagnostics | Opens the dashboard's Diagnostics tab: per-server connection state, model counts, errors, and the last check time |
| LiteLLM: Set Server Secret | Stores a server's API key, OAuth client secret, or virtual key in [secret storage](servers.md#secrets-and-secret-storage) |
| LiteLLM: Refresh Usage Now | Fetches spend and budget data immediately, regardless of the polling interval |
| LiteLLM: Refresh OpenRouter Catalog | Refreshes the capability catalog on demand ([Models](models.md#capabilities)) |
| LiteLLM: Report Issue | Opens a prefilled GitHub issue; see [what it collects](troubleshooting.md#reporting-an-issue) |
| LiteLLM: Help & Feedback | Shortcuts to the documentation, bug reports, and feature requests |
