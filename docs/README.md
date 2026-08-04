# LiteLLM Provider for GitHub Copilot Chat: documentation

English | [简体中文](zh-cn/README.md) | [繁體中文](zh-tw/README.md)

## Getting started

- [Getting started](getting-started.md) - install, the first server, the walkthrough, and where each kind of configuration lives.

## Using the extension

- [Servers](servers.md) - the `servers` setting, entry fields, secrets and secret storage, OAuth client credentials, virtual keys, and adopting servers added outside the extension.
- [Model parameters](model-parameters.md) - the request pass-through contract, the `modelParameters` setting, prefix matching and server scoping, per-entry parameters, reasoning effort, and precedence.
- [Model capabilities](model-capabilities.md) - correcting what discovery reports, declaring models discovery cannot list, the OpenRouter catalog and its privacy switch, and expected discovery failures.
- [Dashboard](dashboard.md) - the panel's layout, the server list and form, the models table, and the settings editors.

## Reference

- [Settings](settings.md) - every setting with its default: token limits, timeouts, model list caching, custom headers, prompt caching.
- [Models and capabilities](models.md) - what registers from a server's model info, which capability gates what, multimodal input and output, thinking, sources, and token usage reporting.
- [Commands](getting-started.md#commands) - every Command Palette command in one table.

## Help

- [Troubleshooting](troubleshooting.md) - the status bar and diagnostic tools, issue reporting and what it collects, privacy and data flow, timeout and retry semantics, common problems, uninstall cleanup, and migration notes.

## Contributing

- [Development](development.md) - building from source and the local Docker stack for testing against a real LiteLLM proxy.
