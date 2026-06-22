# Security Policy

## Supported Versions

Only the latest `main` branch and the latest VS Code Marketplace release are supported. This extension is pre-1.0, so security fixes land on `main` and are released through the normal release-please flow.

## Reporting a Vulnerability

Please report security issues privately through GitHub's private vulnerability reporting. Go to the repository's **Security** tab and choose **"Report a vulnerability"**, or use this link:

https://github.com/Vivswan/litellm-vscode-chat/security/advisories/new

Do **not** open public issues, pull requests, or discussions for security reports.

We aim to acknowledge new reports on a best-effort basis, typically within a few days. As a small, volunteer-maintained project we cannot commit to a fixed response or remediation timeline.

## Security Model / Scope

`litellm-vscode-chat` is a VS Code extension that connects VS Code's Language Model Chat Provider API to user-configured LiteLLM servers.

- **Secrets stay in VS Code storage.** LiteLLM API keys and OAuth2 client credentials are stored in VS Code SecretStorage. Server labels, base URLs, authentication methods, OAuth token URLs, and virtual-key header names are stored in VS Code global state.
- **User-controlled endpoints.** The extension sends prompts, tool definitions, and supported attachment data to the LiteLLM server configured by the user. Only configure servers you trust.
- **No bundled model provider credentials.** The extension does not ship provider API keys; model-provider credentials are managed by the user's LiteLLM deployment.
- **Supply-chain posture.** Dependencies are pinned via the committed `bun.lock` and installed with `bun install --frozen-lockfile` in CI and setup scripts.
