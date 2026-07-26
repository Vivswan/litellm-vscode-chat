# Security policy

## Supported versions

Only the latest `main` branch and the latest VS Code Marketplace release are
supported. This extension is pre-1.0, so security fixes land on `main` and go
out through the normal release flow.

## Reporting a vulnerability

**Do not open public issues, pull requests, or discussions for security
reports.**

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/vivswan/litellm-vscode-chat/security/advisories/new)
("Report a vulnerability"). Include reproduction steps and the affected
version. You'll get an acknowledgement as soon as possible, and a fix ships in
the next release once confirmed. As a small, volunteer-maintained project we
cannot commit to a fixed response or remediation timeline.

Never include real credentials in a report; redact everything that looks like
a key.

## Security model and scope

`litellm-vscode-chat` is a VS Code extension that connects VS Code's Language
Model Chat Provider API to user-configured LiteLLM servers.

- LiteLLM API keys are stored in VS Code SecretStorage. Server labels and
  base URLs are stored in VS Code global state.
- The extension sends prompts, tool definitions, and supported attachment
  data to the LiteLLM server the user configured. Only configure servers you
  trust.
- The extension ships no provider API keys; model-provider credentials are
  managed by the user's LiteLLM deployment.
- Dependencies are pinned via the committed `bun.lock` and installed with
  `bun install --frozen-lockfile` in CI and setup scripts.
