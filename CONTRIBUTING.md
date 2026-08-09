# Contributing to litellm-vscode-chat

Thanks for contributing! This document covers the conventions every change
in this repository goes through.

CI, settings, and standards files here (including this document above the
marker at the bottom) are managed by
[Vivswan/repo-platform](https://github.com/vivswan/repo-platform);
local edits to managed files are replaced on the next template sync.

## Pull requests

- Changes land through pull requests and are squash-merged; the PR title
  becomes the commit subject on the default branch.
- The PR title and every pushed commit subject must be a
  [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/),
  for example `feat: add X` or `fix(parser): handle Y`. Releases are
  versioned from these subjects.
- By opening a pull request, or offering code in an issue or review for
  inclusion, you agree to the Contributions section of the
  [LICENSE](LICENSE), which licenses that code to the licensor -
  including for relicensing under any terms - unless you conspicuously
  say otherwise when you submit it.

## CI

- CI gates on a single status check, `all-green`, which needs every
  gating CI job (the convention is documented in
  [repo-platform's all-green guide](https://github.com/vivswan/repo-platform/blob/main/docs/all-green.md)).
- Repository-specific checks live in `.github/workflows/checks.yml`; run
  the commands it lists locally before pushing.
- A typography gate enforces plain ASCII punctuation: no curly quotes,
  em-dashes, or invisible unicode.

## Security

Never report vulnerabilities in issues or pull requests - see
[SECURITY.md](SECURITY.md) for the private reporting route.

## Code of conduct

Participation in this project is governed by the
[code of conduct](CODE_OF_CONDUCT.md).

<!-- Repository-specific contributing documentation (dev setup, build and
     test commands, review expectations) goes below this line. It survives
     template updates via three-way merge. -->
<!-- repo-platform:local-section -->
