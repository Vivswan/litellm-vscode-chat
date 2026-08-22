# LiteLLM Provider for GitHub Copilot Chat: documentation

English | [简体中文](zh-cn/README.md) | [繁體中文](zh-tw/README.md)

The extension connects GitHub Copilot Chat to any number of LiteLLM servers: their models appear in Copilot's model picker with streaming, tool calling, images, and reasoning, and the extension tracks each server's spend and budget as you go. Everything is configurable two equivalent ways - a dashboard panel and plain VS Code settings.

## I want to...

| Goal | Read |
|------|------|
| Set up my first server and send a chat | [Getting started](getting-started.md) |
| Add another server, or see every field an entry can carry | [Servers: entry reference](servers.md#entry-reference) |
| Keep an API key out of settings.json | [Servers: secrets and secret storage](servers.md#secrets-and-secret-storage) |
| Authenticate with OAuth, or a key in a custom header | [Servers: authentication](servers.md#authentication) |
| Attach extra HTTP headers to a server (tracing, routing tags) | [Servers: entry reference](servers.md#entry-reference) |
| Use a gateway that cannot list its models (no `/v1/models`) | [Servers: declared models](servers.md#declared-models) |
| Fix a wrong context length, or turn on vision for a model | [Models: capabilities](models.md#capabilities) |
| Set temperature (or any request parameter) for a model family | [Models: parameters](models.md#parameters) |
| Understand how `"gpt-5*"` and other matcher keys combine | [Models: model matching](models.md#model-matching) |
| Use a LiteLLM model for Copilot's commit messages, titles, and other background tasks | [Models: Copilot model slots](models.md#copilot-model-slots) |
| Set a spending budget and get warned before it runs out | [Usage: budgets](usage.md#budgets) and [alerts](usage.md#alerts) |
| See why a model's parameter or capability has the value it has | [Models: the inspectors](models.md#inspectors) |
| Figure out why something is red or yellow in the status bar | [Troubleshooting: status bar](troubleshooting.md#status-bar) |
| Take over a server that was added outside the extension | [Servers: external servers and adoption](servers.md#external-servers-and-adoption) |
| Set up a second machine, or understand what Settings Sync carries | [Servers: multiple machines and Settings Sync](servers.md#multiple-machines-and-settings-sync) |
| Look up any setting, its default, and what changed on upgrade | [Settings: reference](settings.md#reference) |
| Diagnose a failure, from a 401 to missing models | [Troubleshooting: common issues](troubleshooting.md#common-issues) |

## The pages

In reading order:

1. [Getting started](getting-started.md) - install, the first server, the first chat, and five short recipes for the most common next steps.
2. [Servers](servers.md) - the `servers` setting in full: entry fields, the three auth forms, secret storage, per-server model configuration, the sync lifecycle, adoption, and Settings Sync.
3. [Models](models.md) - how models appear in the picker, matcher keys and inheritance, capabilities, parameters, the per-model picker configuration, and the effective-values inspectors.
4. [Usage](usage.md) - spend and budget tracking: where budgets come from, alerts, the status bar item, and the dashboard's usage panel.
5. [Dashboard](dashboard.md) - a tour of the panel: the server list and form, the models list, the settings editors, and diagnostics.
6. [Settings](settings.md) - the complete reference: every setting, its default, and the rename table for configs from older versions.
7. [Troubleshooting](troubleshooting.md) - symptom-indexed: what you see, what it means, how to fix it.
8. [Development](development.md) - building from source and the local Docker stack for testing against a real LiteLLM proxy.
