
## Prerequisites

- [Bun](https://bun.sh): package manager and runtime
- VS Code: required by the extension test harness

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
bun run setup-env:pwsh
```

## Running checks

From the project directory:

```bash
bun run lint:actions # lint GitHub Actions workflows
bun run lint         # run Biome lint
bun run compile      # compile TypeScript
bun run typecheck    # type-check all four tsconfig projects (compile builds only the root one)
bun run test         # run the VS Code extension tests
bun run format       # format files with Biome
```

A Husky pre-commit hook runs formatting, workflow linting, a guard that `@types/vscode` does not outrun `engines.vscode`, source linting, `typecheck` over all four tsconfig projects, the localization gate (`l10n:check`), and the tests; it refuses the commit when dependencies are not installed.

## Code style

Conventions live in [AGENTS.md](AGENTS.md). In short:

- Biome enforces formatting and TypeScript lint rules.
- Keep changes focused and avoid unrelated fixes.

## Submitting a pull request

1. Fork the repo and create a branch for your change.
2. Make sure the checks under "Running checks" pass locally.
3. Open a PR with a Conventional Commit title (see "Pull requests" above).
