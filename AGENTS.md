<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

Guidance for AI coding agents in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by the platform and replaced on every sync. This repository's own guidance goes below the END marker.

## Project

LiteLLM VSCode Chat: Use 100+ LLMs in VS Code with GitHub Copilot Chat powered by LiteLLM.

## Conventions

- PR titles and commit subjects are Conventional Commits; PRs are squash-merged, so the PR title becomes the commit subject.
- CI gates on the `all-green` check. This repository's own jobs go in the repo-owned `checks.yml` (tests, lint) and `post-green.yml` (green-gated work on main); `ci.yml` is managed.
- Plain ASCII punctuation only; the check-typography gate enforces it.

## Managed by the platform

- A file whose header says "managed by Vivswan/repo-platform" arrives by sync PR. Change it there, never here.
- Repository settings come from `.github/settings.local.yml` (this repository's own) merged with the fleet layers into the rendered `.github/settings.yml`. Edit the local file, never the rendered one or the GitHub UI.
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync applies a change. Contracts: the platform's docs/new-repo.md and docs/fleet-guidelines.md.

## Toolchain

- bun: `bun install`, `bun test`, `bun run <script>` (scripts in `package.json`)
- `.bun-version` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker; they are this repository's own and survive every sync. -->
<!-- END REPO-PLATFORM MANAGED -->

A VS Code extension that puts LiteLLM behind GitHub Copilot Chat through the Language Model Chat Provider API: streaming chat with tool calls, multimodal input, reasoning, and several LiteLLM servers at once. Code is the source of truth: this section holds only the rules and the decisions a reader could not recover from the code.

### Hard rules

- **Never launch VS Code or any GUI to verify.** Humans test with `F5` or `bun run dev`.
- **`bun run typecheck` after any TypeScript change.** It covers all four tsconfig projects; `compile` builds only the root one, and `lint:types` typechecks nothing despite its name.
- **The provider owns exactly `model`, `messages`, `stream`, `stream_options`, `max_tokens`, and `tools`/`tool_choice`** (`src/shared/config/parameterResolution.ts`). Nothing else is injected.
- **User records and runtime options reach LiteLLM unchanged.** Underscore keys are directives and are never sent.
- **Capabilities come from the server, parameters from the user.** The capability vocabulary is open and the user is right about their server (`src/shared/config/capabilityResolution.ts`).
- **Chat completions never retry; discovery GETs do.** Transport throws without logging, `src/provider/index.ts` is the provider's one logging boundary, and cancellation is `vscode.CancellationError`, never logged.
- **Logs carry classifications, never response-derived text.** They feed the public issue report. `console.*` is banned in `src/` outside tests, and a localized error that can reach a log carries an English mirror (`MirroredError`).
- **Secrets never cross the dashboard wire.** State pushes carry secret locations, not values; every Memento and SecretStorage key lives in `src/shared/config/storageKeys.ts`.
- **One l10n shape**: `import * as l10n from "@vscode/l10n"` and `l10n.t(...)`, resolved at call time, `{0}` interpolation. Logger output, the issue report, model-facing prompt text, and protocol terms stay English.
- **One concept, one pipeline.** A second classifier or parser where one exists is a finding.
- **Plain ASCII, no AI or tool attribution** in code, commits, or PRs.

### Decisions a reader would otherwise reverse

- **`servers` is declarative truth and the host's provider groups mirror it** (`src/extension/servers/serverSync/`). Host group commands are add-only (#316), so leftovers are hidden by tombstone, never deleted.
- **A silent refresh never throws.** On failure it serves the entry's declared models plus stale-flagged discovered ones inside `discovery.staleServeWindow` (`src/provider/catalog/groupDiscovery.ts`).
- **A 401 is never re-wrapped as a network error** (`src/provider/transport/errorMapping.ts`).
- **Catalog levels fill capabilities only, never pricing** (`src/provider/catalog/modelCatalog.ts`).
- **One-shot features take nothing from the records except `_fim_template`** (`src/extension/features/`). Features never import each other; `features/quickFixChatCommands.ts` is the one declared bridge.
- **Migrations are idempotent, state-detecting, and expire** (`src/extension/migrations/expiries.ts`). A passed expiry turns the build red until the migration is deleted.
- **The two `models.*` record settings are `restricted`; every `.enabled`, `.model`, and `models.openRouterCatalog` is machine-overridable** (`src/shared/config/settingSpec.ts`).
- **`docs/settings.md` and its zh-cn/zh-tw twins are generated** (`bun run docs:settings`); a new setting needs a prose entry in all three locales.
- **Fuzz findings are pinned, not fixed in place**: a fuzz-found failure gets a corpus entry in `src/test/fuzzCorpus.ts`.
- **Dashboard appearance is reviewed, not gated**: `check-overflow` and `check-geometry` gate fit and geometry; looks are judged against `docs/dashboard-visual-language.md`.
- **Tests are few but strong.** Flag shape-only tests, one-axis variants that should be one case table, and a deleted test with no successor.

### Releases

- release-please owns versioning; never bump `package.json`.
- A commit that resolves a community issue or PR credits the author in its subject, e.g. `fix: normalize base URL slashes (#53, thanks @Pandaplanes)`. Landed community code also gets a `Co-authored-by:` trailer and an `ACKNOWLEDGMENTS.md` row.
