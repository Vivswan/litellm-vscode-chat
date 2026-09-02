<!-- BEGIN REPO-PLATFORM MANAGED -->
# Contributing to litellm-vscode-chat

Thanks for contributing! This document covers the conventions every change in this repository goes through.

CI, settings, and standards files here (including this document between the BEGIN/END markers) are managed by [Vivswan/repo-platform](https://github.com/vivswan/repo-platform); local edits to managed files are replaced on the next template sync.

## Pull requests

- Changes land through pull requests and are squash-merged; the PR title becomes the commit subject on the default branch.
- The PR title and every pushed commit subject must be a [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/), for example `feat: add X` or `fix(parser): handle Y`. Releases are versioned from these subjects.
- By opening a pull request, or offering code in an issue or review for inclusion, you agree to the Contributions section of the [LICENSE.md](LICENSE.md), which licenses that code to the licensor - including for relicensing under any terms - unless you conspicuously say otherwise when you submit it.

## CI

- CI gates on the `all-green` status check - the CI workflow's own `all-green` job, which needs every gating job and fails unless each result is success or skipped, with at least one success (the convention is documented in [repo-platform's all-green guide](https://github.com/vivswan/repo-platform/blob/main/docs/all-green.md)).
- Repository-specific checks live in `.github/workflows/checks.yml`; run the commands it lists locally before pushing.
- A typography gate enforces plain ASCII punctuation: no curly quotes, em-dashes, or invisible unicode.

## Security

Never report vulnerabilities in issues or pull requests - see [SECURITY.md](SECURITY.md) for the private reporting route.

## Code of conduct

Participation in this project is governed by the [code of conduct](CODE_OF_CONDUCT.md).

<!-- Repository-specific contributing documentation (dev setup, build and
     test commands, review expectations) goes outside the BEGIN/END markers - below the END marker, or above BEGIN. It is this repository's own and survives template updates. -->
<!-- END REPO-PLATFORM MANAGED -->

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
