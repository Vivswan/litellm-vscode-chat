# Security policy

## Supported versions

Only the latest release is supported. For this extension, that means the latest VS Code Marketplace release; the tip of `main` is supported too. The project is pre-1.0, so security fixes land on `main` and go out through the normal release flow. Keep security reports out of public pull requests and discussions as well as issues.

As a small, volunteer-maintained project we cannot commit to a fixed response or remediation timeline; acknowledgement and fixes are best-effort.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/vivswan/litellm-vscode-chat/security/advisories/new) ("Report a vulnerability"). If that page is unavailable, contact [@Vivswan](https://github.com/vivswan) directly instead. A useful report includes:

- what an attacker can do (impact), and where trust is broken,
- reproduction steps or a proof of concept,
- the affected version or commit.

Never include real credentials in a report; redact everything that looks like a key.

## Security model and scope

`litellm-vscode-chat` is a VS Code extension that connects VS Code's Language Model Chat Provider API to user-configured LiteLLM servers.

- Servers (label, base URL, credentials) live in the `servers` user setting, which is machine-scoped so a workspace cannot re-point a label at another host. Each entry's secret fields may sit inline in that setting or, per entry, in VS Code SecretStorage. The dashboard's state carries where each secret lives, not its value; the one value path to the dashboard is the edit form's prefill of inline-stored fields, which are already plaintext in the settings file, and SecretStorage values never render.
- The extension sends prompts, tool definitions, and supported attachment data to the LiteLLM server the user configured. Only configure servers you trust.
- The extension ships no provider API keys; model-provider credentials are managed by the user's LiteLLM deployment.
- Dependencies are pinned via the committed `bun.lock` and installed with `bun install --frozen-lockfile` in CI and setup scripts.
