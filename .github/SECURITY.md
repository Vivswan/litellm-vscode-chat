# Security policy

## Supported versions

- Supported: the latest VS Code Marketplace release and the tip of `main`.
- The project is pre-1.0. Security fixes land on `main` and ship through the normal release flow.
- Keep security reports out of public issues, pull requests, and discussions.
- A small, volunteer-maintained project: acknowledgement and fixes are best-effort, with no fixed timeline.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/vivswan/litellm-vscode-chat/security/advisories/new) ("Report a vulnerability"). If that page is unavailable, contact [@Vivswan](https://github.com/vivswan) directly instead. A useful report includes:

- what an attacker can do (impact), and where trust is broken,
- reproduction steps or a proof of concept,
- the affected version or commit.

Never include real credentials in a report; redact everything that looks like a key.

## Security model and scope

`litellm-vscode-chat` is a VS Code extension that connects VS Code's Language Model Chat Provider API to user-configured LiteLLM servers.

- Servers (label, base URL, credentials) live in the `servers` user setting. It is machine-scoped, so a workspace cannot re-point a label at another host.
- Each entry's secret fields sit inline in that setting or, per entry, in VS Code SecretStorage.
- The dashboard receives where each secret lives, not its value. The edit form prefills only inline-stored fields, which are already plaintext in the settings file; SecretStorage values never render.
- The extension sends prompts, tool definitions, and supported attachment data to the LiteLLM server the user configured. Only configure servers you trust.
- The extension ships no provider API keys; model-provider credentials are managed by the user's LiteLLM deployment.
- Dependencies are pinned via the committed `bun.lock` and installed with `bun install --frozen-lockfile` in CI and setup scripts.
