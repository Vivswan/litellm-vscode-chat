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
("Report a vulnerability"). A useful report includes:

- what an attacker can do (impact), and where trust is broken,
- reproduction steps or a proof of concept,
- the affected version or commit.

Expect an acknowledgement within a few days, and a fix in the next release
once the report is confirmed. Please allow reasonable time for that fix
before any public disclosure.

Never include real credentials in a report; redact everything that looks like
a key.

<!-- Repository-specific security documentation (scope, threat model, review
     expectations for security-relevant changes) goes below this line. It
     survives template updates via three-way merge. -->

As a small, volunteer-maintained project we cannot commit to a fixed response
or remediation timeline; acknowledgement and fixes are best-effort.

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
