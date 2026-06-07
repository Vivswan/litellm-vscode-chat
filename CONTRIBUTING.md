# Contributing to litellm-vscode-chat

Thanks for your interest in improving `litellm-vscode-chat`! This guide covers how to set up the project, run checks, and submit a pull request.

## Prerequisites

- [Bun](https://bun.sh) — package manager and runtime
- VS Code — required by the extension test harness

## Setup

On macOS, Linux, or any shell with Bash available:

```bash
git clone https://github.com/<your-fork>/litellm-vscode-chat.git
cd litellm-vscode-chat
bun run setup-env
```

On Windows without Bash, use PowerShell instead:

```powershell
git clone https://github.com/<your-fork>/litellm-vscode-chat.git
cd litellm-vscode-chat
./scripts/setup-env.ps1
```

## Running checks

From the project directory:

```bash
bun run lint:actions # lint GitHub Actions workflows
bun run lint         # run ESLint
bun run compile      # compile TypeScript
bun run test         # run the VS Code extension tests
bun run format       # format files with Prettier
```

A Husky pre-commit hook runs formatting, workflow linting, source linting, and tests when dependencies are installed.

## Code style

Conventions live in [AGENTS.md](AGENTS.md). In short:

- Prettier enforces formatting.
- ESLint enforces TypeScript lint rules.
- Keep changes focused and avoid unrelated fixes.

## Submitting a pull request

1. Fork the repo and create a branch for your change.
2. Make sure `bun run lint:actions`, `bun run lint`, `bun run compile`, and `bun run test` pass.
3. Use a Conventional Commit PR title such as `fix: handle model timeout` or `feat: add server diagnostics`; release-please uses squash commit messages to choose versions.
4. Open a PR. Merges to `main` are squash-only.

## Security

Please do not report security vulnerabilities through public issues. See [SECURITY.md](SECURITY.md) for how to disclose them responsibly.
