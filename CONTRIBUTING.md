# Contributing to litellm-vscode-chat

Thanks for contributing! This document covers the conventions every change in this repository goes through.

CI, settings, and standards files here arrive from the fleet sync; a file whose header says it is managed is replaced on the next sync, so change it at its source, not here.

## Pull requests

- Changes land through pull requests and are squash-merged; the PR title becomes the commit subject on the default branch.
- The PR title and every pushed commit subject must be a [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/), for example `feat: add X` or `fix(parser): handle Y`. Releases are versioned from these subjects.
- Opening a pull request, or offering code in an issue or review for inclusion, means you agree to the Contributions section of the [LICENSE.md](LICENSE.md). It licenses that code to the licensor, including for relicensing under any terms, unless you conspicuously say otherwise when you submit it.

## CI

- CI gates on the `all-green` status check - the CI workflow's own `all-green` job, which needs every gating job and fails unless each result is success or skipped, with at least one success.
- Repository-specific checks live in `.github/workflows/checks.yml`; run the commands it lists locally before pushing.
- `.github/workflows/nightly.yml` re-runs the gate's test jobs every night with one thing moved ahead at a time: VS Code Insiders, or LiteLLM's rolling `main-stable` image. A red night files a `nightly-failure` issue; its header comment says what each job's red points at.
- A typography gate enforces plain ASCII punctuation: no curly quotes, em-dashes, or invisible unicode.

## Security

Never report vulnerabilities in issues or pull requests - see [SECURITY.md](.github/SECURITY.md) for the private reporting route.

## Code of conduct

Participation in this project is governed by the [Contributor Covenant](https://github.com/Vivswan/.github/blob/main/CODE_OF_CONDUCT.md) that applies to all of Vivswan's repositories.

## Prerequisites

- [Bun](https://bun.sh): package manager and runtime
- VS Code: required by the extension test harness

## Setup

One script on every OS; it installs the pinned dependencies (`--verify` also compiles and lints, `--full` also tests):

```bash
git clone https://github.com/<your-fork>/litellm-vscode-chat.git
cd litellm-vscode-chat
bun run setup-env
```

## Running checks

From the project directory:

```bash
bun run lint         # Biome formatting, lint, and import-order check, then ESLint (bun run format applies Biome fixes)
bun run compile      # compile TypeScript
bun run typecheck    # type-check all four tsconfig projects (compile builds only the root one)
bun run test         # run the VS Code extension tests
bun run format       # apply Biome formatting, import order, and safe lint fixes
```

The Husky pre-commit hook (`.husky/pre-commit`) only checks and never writes: the `node_modules` guard, `bun run check:static`, and the bun test tree. A refused check names its fix command when one exists; stage the result and commit again.

- formatting, lint, import order: `bun run format`
- generated manifest blocks: `bun run manifest:generate`
- settings docs: `bun run docs:settings`
- l10n bundle: `bun run l10n:extract`

The VS Code host suite is CI's on every push; `bun run check` runs everything locally.

## Code style

Conventions live in [AGENTS.md](AGENTS.md). In short:

- Biome enforces formatting and TypeScript lint rules.
- Keep changes focused and avoid unrelated fixes.

## Submitting a pull request

1. Fork the repo and create a branch for your change.
2. Make sure the checks under "Running checks" pass locally.
3. Open a PR. The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) prefills the body's shape and carries the rules for the title and each section.
4. A title that credits a community author, `(#N, thanks @login)`, needs that login's row in [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md).

Two gates refuse what the local checks never see:

- **Commit subjects:** `fix(a,b): Handle Y` fails twice, on the comma scope (one scope or none, spelled `[A-Za-z0-9._/-]`) and on the Sentence-case description. The gate reads the title and every commit on the branch.
- **Typography:** the gate under "CI" reads the eligible files in the checkout, not the PR body.
