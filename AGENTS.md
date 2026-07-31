# AGENTS.md

This file provides guidance to AI coding agents working in this repository.
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to this file, so edit only here.

## Project

LiteLLM VSCode Chat: Use 100+ LLMs in VS Code with GitHub Copilot Chat powered by LiteLLM.

## Toolchain

- Runtime and package manager: bun (`bun install`, `bun test`, `bun run <script>`)
- See `package.json` scripts for the available commands.

## Conventions

- PR titles and commit subjects must be Conventional Commits (`feat:`, `fix:`,
  `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR title becomes the
  commit subject and drives release-please versioning. CI validates both
  (the ci.yml pr-title job + validate-commit-names).
- CI gates on a single required check named `all-green` in the managed
  `.github/workflows/ci.yml`. This repository's own test/lint jobs belong in
  `.github/workflows/checks.yml` (repo-owned, called inside the gate); do not
  edit ci.yml, template sync overwrites it. The `release` job runs on top
  of the gate (`needs: all-green`); the release pipeline is repo-owned in
  `.github/workflows/release.yml` (pre/post-release jobs go there, around the
  managed release-please machinery).
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode). CI enforces this with the check-typography action; use plain ASCII
  punctuation.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform"
  arrive via sync PRs pushed by that repository. Do not edit them here;
  change them in Vivswan/repo-platform and let the next sync
  PR deliver the update.
- Repository settings (description, topics, labels, rulesets, merge policy)
  are applied from Vivswan/repo-platform: by the
  `settings/repos/` file named after this repository over there when one
  exists, otherwise by this repository's own `.github/settings.yml`. Do not
  change settings by hand in the GitHub UI; edit the settings file.
- Repo-owned escape hatches stay local: `.github/workflows/checks.yml` and
  `.github/workflows/release.yml`, `.gitignore`'s marked LOCAL section,
  `.typography-allow.local` (typography exemptions; the managed
  `.typography-allow` is overwritten by sync), and the repository-specific
  section below.
- Module selection is this repository's own: edit the `modules` list in
  `.repo-platform.yml` and the next sync PR applies the change.

## Repository-specific guidance

<!-- Add project-specific instructions below. This section survives template
     updates via three-way merge. -->

Keep shared project facts here; the code is the source of truth for
implementation detail.

### Project overview

A VS Code extension that integrates LiteLLM into GitHub Copilot Chat via the Language Model Chat Provider API: streaming chat with tool calling, multimodal input, thinking/reasoning, and multiple LiteLLM servers at once.

### Commands

```bash
bun run setup-env          # install dependencies (setup-env:pwsh on Windows PowerShell)
bun run compile            # tsc to out/ (tests run from here)
bun run bundle             # production bundles (bundle:dev for unminified)
bun run typecheck          # all three tsconfig projects
bun run lint               # Biome (lint:types, lint:knip, lint:actions for the others)
bun run test               # webview suite, then unit + activation-production + capture host-fidelity in the extension host (test:coverage adds the floor)
bun run test:docker        # docker suites + stream fuzzer against a real LiteLLM proxy (--only <labels> runs a subset)
bun run docker:up          # local LiteLLM proxy + fake OpenAI backend (docker:down, docker:logs)
bun run generate-config    # print the generated LiteLLM proxy config to stdout (stack startup writes the real file)
bun run dev                # Extension Development Host preconfigured against the fake stack
```

### Validation expectations for agents

- After TypeScript changes: `bun run compile`; when scripts/ changed, `bun run typecheck`.
- After source or test changes: `bun run lint`, `bun run lint:types`, `bun run lint:knip`, and the relevant tests. After workflow changes: `bun run lint:actions`.
- Never launch VS Code or any GUI for verification; humans test interactively (`F5` or `bun run dev`).

### Architecture

Four source trees with Biome-enforced layering: `src/extension/` (activation, commands, UI surfaces) may import the others; `src/provider/` (the `LanguageModelChatProvider` and transport) must not import the extension layer; `src/shared/` imports neither; `src/webview/` (the dashboard's Preact UI, own tsconfig, bundled separately to `dist/webview/dashboard.js`) may import only the dashboard protocol modules and talks to the extension over the panel's message protocol. Inside those trees: `src/provider/transport/` holds the wire-facing request, streaming, and error machinery, `src/provider/catalog/` holds discovery, registration, and model metadata (with `provider/config.ts` staying at the root as the extension-injection seam), `src/shared/conversion/` holds the VS Code-to-OpenAI message, tool, and token conversions, `src/shared/util/` and `src/shared/config/` hold the small helpers and the settings/commands/storage-keys declarations (everything else shared stays at the root), `src/extension/servers/` holds the server registry, server management, and the serverSync engine, and `src/extension/ui/` holds the command surfaces: commands, notifier, status bar, diagnostics, and the issue reporter (dashboard/ and migrations/ stay where they are). Helper scripts are grouped by role: `scripts/stack/` (compose wrapper, proxy config generation, the fake OpenAI backend), `scripts/dev/` (dev launcher, esbuild, third-party notices), `scripts/env/` (setup-env), and `scripts/ci/`, with `scripts/docker-test.ts` at the root as the docker-suite orchestrator; the compose file itself lives at `docker/docker-compose.yml`.

Two deliberate design contracts worth knowing before touching transport code: streaming parses the raw response body itself instead of using the SDK's stream parser, because the contract is log-and-skip on malformed SSE lines with observable aborts, and `parseChunk`'s leniency rules are pinned by tests. `console.*` is banned in `src/` outside tests; logs also feed the issue-report buffer that opens public GitHub issues, so log classifications, never response-derived text.

Storage migrations live in `src/extension/migrations/`: state-detecting and idempotent (each one reruns every activation and no-ops once its legacy state is gone), with all logic touching legacy identifiers quarantined there, while the keys themselves stay in `shared/config/storageKeys.ts`.

### Load-bearing invariants

- **Request pass-through.** Beyond the provider-owned request fields (`model`, `messages`, `stream`, `stream_options` with `include_usage`, `max_tokens`, and, when tools are in play, `tools`/`tool_choice`), the extension never injects a request parameter the user did not set: no default temperature, no allow-list. Provider-owned fields cannot be overridden; keys starting with `_` are skipped; everything else from `modelParameters` config and runtime `modelOptions` reaches LiteLLM unchanged. A declared server entry may carry its own `modelParameters` (same prefix-keyed shape, no server scoping), applied only to requests routed through that entry via its label on the attached group server; entry parameters count as user-set and override the global setting key by key. The host-resolved per-model configuration (Configure Model picks, e.g. reasoning effort) counts as user-set and is forwarded likewise, except only schema-declared properties go out (mapped to their wire keys). The full precedence chain is: runtime options > picker configuration > entry `modelParameters` > global `modelParameters`. One documented exception: when neither runtime options nor config set `max_tokens`, the request carries the model's declared max output tokens as-is, or `min(4096, model max output tokens)` when that number came from `defaultMaxOutputTokens`; a merged deployment's or aggregate's minimum counts as declared only if every contributor declared one.
- **Capabilities vs parameters.** Capabilities (what a model can do) are read from the LiteLLM API and drive registration and token constraints. Parameters (what we ask it to do) come only from user config, the model picker's per-model configuration, and runtime options. `modelParameters` uses longest-prefix matching with optional server scoping (base URL prefix).
- **Retries.** Discovery GETs retry (idempotent); chat completions never retry. The configured timeouts are hard whole-call bounds.
- **Error ownership.** Transport modules (`provider/catalog/discovery.ts`, `provider/transport/chatClient.ts`, `provider/transport/auth.ts`, `shared/validation.ts`) construct specific errors and throw without logging; the provider boundary (`src/provider/index.ts`) logs once. Cancellation surfaces as `vscode.CancellationError` and is never logged. Silent refreshes return an empty model list instead of throwing, except that a silent group refresh whose last successful discovery is under ten minutes old returns the group's last known models flagged stale (warning icon plus hover warning). 401s are never re-wrapped as network errors.
- **Storage.** Server URLs in `globalState`, API keys in SecretStorage, user options in `litellm-vscode-chat.*` settings; every Memento/SecretStorage key lives in `shared/config/storageKeys.ts`. Provider-group credentials are host-owned (declared in the `languageModelChatProviders` contribution) and never duplicated into extension storage. The one exception is the user-initiated adopt action, which copies a group's credentials into the new declared entry's storage; the host group keeps its own copy. The `servers` setting is declarative truth that `extension/servers/serverSync/` syncs to host provider groups; it is machine-scoped (user settings only, so workspaces cannot re-point a label at another host), and its secret fields may sit inline in the setting or, per entry, under the `serverSecrets` SecretStorage keys, with inline winning. The dashboard's state pushes carry secret locations, never values; the one value path to the webview is the edit form's on-demand prefill of inline-stored fields (already plaintext in the settings file), and secure-side values never render.
- **Multi-server IDs.** Servers live in VS Code-managed provider groups: the host calls the provider once per group with its configuration, and the resolved server rides on each returned model object (raw IDs; the host namespaces them). The legacy registry path still serves configuration-less refreshes until migration completes, and permanently in non-production mode, where the `litellm._test.*` commands and the host-fidelity suite depend on it.

### Repository conventions

- Biome formats and lints: tabs (width 2), semicolons, 120-char lines. Husky pre-commit runs format, lint, actionlint, scripts typecheck, and the unit and capture host-fidelity suites; it runs `biome check --write` repo-wide and aborts the commit when that modifies anything, so re-stage and commit again.
- release-please manages versioning and Marketplace publishing from Conventional Commit titles. Never bump `package.json` manually.
- A commit that resolves a community-reported issue or supersedes a community PR credits the author in its subject, e.g. `fix: normalize base URL slashes (#53, thanks @Pandaplanes)` - release-please copies the subject into the changelog, so the credit ships with the release. Commits that land or supersede community CODE also carry a human `Co-authored-by:` trailer and a row in `ACKNOWLEDGMENTS.md`.
- No AI/tool attribution in commits or PRs: no "Generated with", no "Co-Authored-By: Claude/Copilot/Codex" or similar. `Co-authored-by:` trailers for human community contributors are the one sanctioned use.

### Code review guidance

Prioritize correctness, security, regressions, missing tests, and violations of this document. Report concrete findings tied to the changed code; skip style Biome already enforces. Pay particular attention to streaming responses, tool-call pairing, multimodal conversion, token limits, request-field ownership, and secret handling (storage, logs, and the webview boundary).

### Testing

Tests mirror the source layout under `src/test/` and run in the extension host (`@vscode/test-electron`, Mocha tdd; entry points build the bundle first). Network mocking uses msw (`src/test/mocks/handlers.ts` documents its quirks), with `withFetch` for what msw cannot express. Property suites (fast-check) are seed-pinned and scale with `FUZZ_RUNS`. Docker suites drive the fake stack through its chat-input command grammar (`src/test/fakeStack/commands.ts`; `%play:<name>` selects a canned stream shape from `src/test/scenarios.ts`). The model catalog in `src/test/fakeStack/models.ts` is the source of truth for the proxy config, generated at stack startup (`docker/.generated/litellm-config.yaml`, gitignored; the test orchestrator always generates it without real-provider wildcard routes). Pin any fuzz-found failure in `src/test/fuzzCorpus.ts`. `COMPOSE_CMD` overrides docker/podman detection.

The one exception to the extension-host rule is the webview suite (`src/test/webview/`, `bun run test:webview`): bun test with happy-dom rendering the dashboard's Preact components directly. `bunfig.toml`'s `[test] root` confines bare `bun test` to that directory - the Mocha-tdd suites crash under bun's runner - and its preload registers the DOM plus the `acquireVsCodeApi` stub before any component import. The suite renders source `.tsx`, not the esbuild bundle; the packaged-file-list check's size floor on `dist/webview/dashboard.js` guards the bundling side.

### CI

Repo-owned jobs live in `checks.yml` inside the required all-green gate: the full `bun run test` pass (webview, unit, activation-production, and capture host-fidelity suites) on three OSes with a Linux coverage floor, the promoted docker-stack suite (docker suites, stream fuzzer, and live host-fidelity against the dockerized proxy, split into two time-balanced shards via `test:docker --only`), an elevated fuzz pass that runs only when the diff touches fuzzer-related paths (skipped otherwise, which the gate counts as green; one unit job plus a sharded docker job), and the format-check workflow (including the packaged-file-list check). `docker-test.yml` is a workflow_dispatch-only wrapper; `nightly-fuzz.yml` runs the docker and property suites at high iteration counts and files `nightly-fuzz` issues with reproduction seeds; `release.yml` publishes the VSIX after release-please cuts a release.
