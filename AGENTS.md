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
- Repo-owned escape hatches stay local:
  `.github/workflows/checks.yml`,
  `.github/workflows/release.yml`, `.gitleaks.toml`,
  `.gitignore`'s marked LOCAL section, `.typography-allow.local`
  (typography exemptions; the managed `.typography-allow` is overwritten
  by sync), and the repository-specific section below.
- Module selection is this repository's own: edit the `modules` list in
  `.repo-platform.yml` and the next sync PR applies the change.

## Repository-specific guidance

<!-- Add project-specific instructions below. This section survives template
     updates via three-way merge. -->
<!-- repo-platform:local-section -->

Keep shared project facts here; the code is the source of truth for
implementation detail.

### Project overview

A VS Code extension that integrates LiteLLM into GitHub Copilot Chat via the Language Model Chat Provider API: streaming chat with tool calling, multimodal input, thinking/reasoning, and multiple LiteLLM servers at once.

### Commands

```bash
bun run setup-env          # install dependencies (setup-env:pwsh on Windows PowerShell)
bun run compile            # tsc to out/ (tests run from here)
bun run bundle             # production bundles (bundle:dev for unminified)
bun run typecheck          # all four tsconfig projects
bun run lint               # Biome (lint:types, lint:knip, lint:actions for the others)
bun run test               # bun tree, then unit + activation-production + capture host-fidelity in the extension host (test:coverage adds the merged floor)
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

Five source trees with Biome-enforced layering: `src/extension/` (activation, commands, UI surfaces) may import the others; `src/provider/` (the `LanguageModelChatProvider` and transport) may import only `src/shared` besides its own tree; `src/dashboard/` (the wire contract as one endpoint table in `endpoints.ts` - every method with its payload, response, outcome class, and chained-vs-concurrent channel, from which the envelope unions, the zod schema map, and the panel handler map all derive by mapped types - plus the `viewModels.ts` state shapes, the `presenters.ts` pure renderers, and the record draft and server form modules) is shared between the extension host and the webview bundle, so it stays pure - no vscode, no zod, no extension or provider imports, only `src/shared` and itself; `src/shared/` imports none of the others; `src/webview/` (the dashboard's Preact UI, own tsconfig, bundled separately to `dist/webview/dashboard.js` plus the `dist/webview/dashboard.css` stylesheet esbuild emits from the entry's css import) may import `src/dashboard` and the pure `src/shared` modules biome.json's webview override explicitly allowlists, and talks to the extension over the panel's request/response/ack/fail/push envelopes (webview-side correlation lives in the useRpc/useIntentOutcome hooks). Inside those trees: `src/provider/transport/` holds the wire-facing request, streaming, and error machinery, `src/provider/catalog/` holds discovery, registration, and model metadata, `src/shared/conversion/` holds the VS Code-to-OpenAI message, tool, and token conversions, `src/shared/util/` and `src/shared/config/` hold the small helpers and the settings/commands/storage-keys declarations (everything else shared stays at the root), `src/extension/servers/` holds the server registry, server management, and the serverSync engine, and `src/extension/ui/` holds the command surfaces: commands, notifier, status bar, and the issue reporter with its diagnostics-snapshot builder (the host-side dashboard/ panel machinery and migrations/ stay where they are). Helper scripts are grouped by role: `scripts/stack/` (compose wrapper, proxy config generation, the fake OpenAI backend), `scripts/dev/` (dev launcher, esbuild, third-party notices), `scripts/env/` (setup-env), and `scripts/ci/`, with `scripts/docker-test.ts` at the root as the docker-suite orchestrator; the compose file itself lives at `docker/docker-compose.yml`.

Two deliberate design contracts worth knowing before touching transport code: streaming parses the raw response body itself instead of using the SDK's stream parser, because the contract is log-and-skip on malformed SSE lines with observable aborts, and `parseChunk`'s leniency rules are pinned by tests. `console.*` is banned in `src/` outside tests; logs also feed the issue-report buffer that opens public GitHub issues, so log classifications, never response-derived text. `src/shared/config/` owns model-record resolution: `modelMatcher.ts` (the key grammar and specificity), `recordResolution.ts` (record inheritance), and `resolutionTable.ts` (the cached per-server-and-model flat table with per-field provenance), consumed through `parameterResolution.ts` and `capabilityResolution.ts` - the request path, registration, and the dashboard inspectors all read the same table, and seed-pinned equivalence properties pin the table against naive resolution and buildRequestBody.

Storage migrations live in `src/extension/migrations/`: state-detecting and idempotent (each one reruns every activation and no-ops once its legacy state is gone), with all logic touching legacy identifiers quarantined there, while the keys themselves stay in `shared/config/storageKeys.ts`.

### Load-bearing invariants

- **Request pass-through.** Beyond the provider-owned request fields (`model`, `messages`, `stream`, `stream_options` with `include_usage`, `max_tokens`, and, when tools are in play, `tools`/`tool_choice`), the extension never injects a request parameter the user did not set: no default temperature, no allow-list. Provider-owned fields cannot be overridden, with one carve-out: `max_tokens` is user-settable through the pass-through and is the one provider-owned key `_force` may mark - a forced `max_tokens` beats runtime options and is never clamped. Keys starting with `_` are record directives, never sent; everything else from the `models.parameters` records and runtime `modelOptions` reaches LiteLLM unchanged. Records are matcher-keyed - exact by default, trailing-`*` glob, `/regex/` (optional `i` flag), `"*"` catch-all - with opt-in record inheritance via `_inheritable`/`_inherit_from`; a server entry's `models.parameters` record beats the global record field by field, and resolution reads the cached flat table, never resolving per request. The host-resolved per-model configuration (Configure Model picks, e.g. reasoning effort) counts as user-set and is forwarded likewise, except only schema-declared properties go out (mapped to their wire keys). The full precedence chain is: forced fields (entry over global) > runtime options > picker configuration > entry `models.parameters` > global `models.parameters`. One documented exception: when neither runtime options nor config set `max_tokens`, the request carries the model's declared max output tokens as-is, or `min(4096, model max output tokens)` when that number is a guess (an OpenRouter catalog value - explicit `_openrouter_model` directive or implicit match - or the built-in floor); a user-set `models.capabilities` value or `_fallback` fill counts as declared (lifts the cap), and a merged deployment's or aggregate's minimum counts as declared only if every contributor declared one.
- **Capabilities vs parameters.** Capabilities (what a model can do) are read from the LiteLLM API and drive registration and token constraints, corrected and extended by user-set `models.capabilities` records (global setting and per-entry field, the same matcher grammar and inheritance as `models.parameters`; `src/shared/config/capabilityResolution.ts` resolves them, and registration and the dashboard's capability inspector consume the same resolver). The field vocabulary is OPEN - the user is always right, it is their server, possibly with custom model_info fields. Three rings: the typed core (`context_length`, `max_input_tokens`, `max_output_tokens`, the four `supports_*` flags) drives registration, backstopped by built-in floors (`max_input_tokens` instead derives context-minus-output); the consumed ring is kind-validated and wired - the 8 cost fields drive pricing, `supports_prompt_caching` gates the request's `cache_control` markers (the one capability that changes request content, still double-gated by the `chat.promptCaching` setting), `supported_openai_params` co-decides the reasoning-effort control with the `supports_reasoning` flag (higher resolution level wins, flag wins ties, the flag's floor counts as no-signal), and `supports_pdf_input`/`supports_response_schema` resolve and display but gate nothing yet; every other non-underscore key (prototype names like `toString` included) resolves through the same walk with provenance and is inert at registration - its values come only from user records, since discovery maps the server's report onto the core and consumed fields alone. Validation is advisory, never gating: an unrecognized field applies as an override as-is, hinted as a possible typo only when the server's observed /model/info key set is known, non-empty, and does not contain the field (a consumed field never produces the diagnostic in the first place) - no evidence (declared models, `expectedFailures: modelInfo`, the `/models` fallback), no hint. The per-field capability walk: entry records > global records > an explicit `_openrouter_model` catalog directive > the server's report > `_fallback` fills (entry over global) > an implicit catalog match (exact ID or unambiguous post-vendor suffix) > the built-in floors (core only - `max_input_tokens` instead derives max(1, context - output); other fields resolve to absent). Both catalog levels backfill capabilities only and NEVER pricing: pricing is LiteLLM's /model/info report plus user cost overrides, field by field, where a server 0/0 input/output pair reads as undeclared (LiteLLM's no-pricing stamp) and a user-written 0/0 prices as genuinely free. Capability records are source-invariant: they apply the same whether the model was discovered or declared. Declaration is its own mechanism, not a capability directive: an entry's `discovery.declared` lists exact model IDs to register when discovery cannot list them - inert when it can, active on any discovery failure type. Parameters (what we ask a model to do) come only from user config, the model picker's per-model configuration, and runtime options.
- **Retries.** Discovery GETs retry (idempotent), except an endpoint named in the entry's `expectedFailures` (`modelListing` for the models listing, `modelInfo` for model info), which gets a single attempt; chat completions never retry. The configured timeouts are hard per-request bounds, not whole-pass bounds: the model-info listing and the `/models` fallback each get their own fresh timeout budget, as does an entry's OAuth token exchange, so a discovery pass may take up to their sum.
- **Error ownership.** Transport modules (`provider/catalog/discovery.ts`, `provider/transport/chatClient.ts`, `provider/transport/auth.ts`, `shared/validation.ts`) construct specific errors and throw without logging; the provider boundary (`src/provider/index.ts`) logs once. Cancellation surfaces as `vscode.CancellationError` and is never logged. Silent refreshes return an empty model list instead of throwing, except that a silent group refresh whose last successful discovery is under ten minutes old returns the group's last known models flagged stale (warning icon plus hover warning). 401s are never re-wrapped as network errors.
- **Storage.** The `servers` setting is declarative truth that `extension/servers/serverSync/` syncs to host provider groups; it is machine-scoped (user settings only, so workspaces cannot re-point a label at another host), and its secret fields may sit inline in the setting or, per entry, under the `serverSecrets` SecretStorage keys, with inline winning. The legacy registry is the pre-migration location - server URLs in `globalState`, per-server API keys in SecretStorage - and serves nothing: it survives as the migration's read source and the pre-migration edit surface (the legacy quick-pick flows), both gone once the provider-group migration completes and empties it. User options live in `litellm-vscode-chat.*` settings; every Memento/SecretStorage key lives in `shared/config/storageKeys.ts`. The OpenRouter catalog cache is a JSON file under `globalStorage`: the file is the truth, and the globalState key beside it holds only advisory refresh metadata (globalState is not transactional). Credentials of externally managed provider groups (created in the native editor, not from a declared entry) are host-owned (declared in the `languageModelChatProviders` contribution) and never duplicated into extension storage; the one exception is the user-initiated adopt action, which copies such a group's credentials into the new declared entry's storage, while the host group keeps its own copy. The dashboard's state pushes carry secret locations, never values; the one value path to the webview is the edit form's on-demand prefill of inline-stored fields (already plaintext in the settings file), and secure-side values never render.
- **Multi-server IDs.** Servers live in VS Code-managed provider groups: the host calls the provider once per group with its configuration, and the resolved server rides on each returned model object (raw IDs; the host namespaces them). A configuration-less refresh serves no models; every model reaches the picker through a per-group call and carries its group's resolved connection, which is the request path's only route (a model without one fails as a classified error). The docker and host-fidelity suites drive provider groups via the declarative `servers` setting and the host's add-group command.

### Localization

One l10n API for every runtime: all shipped source localizes through `import * as l10n from "@vscode/l10n"` and `l10n.t(...)` - the exact form `@vscode/l10n-dev` extraction recognizes, so no aliasing, no destructuring, no facade re-exports. The bundle flows from the host: `src/extension/l10nConfig.ts` feeds `vscode.l10n.bundle` into `l10n.config` at the top of activate(), before any t() can run, and the dashboard HTML shell injects the same bundle as `window.__l10nBundle` for the webview; both read the same `l10n/bundle.l10n.<locale>.json` files. Those `vscode.l10n.bundle` reads are the only sanctioned touch of vscode's own l10n surface: `l10n:check`'s AST rule is an allowlist that fails closed - beyond the canonical import with direct `l10n.t`/`l10n.config` calls, ordinary non-l10n vscode API use, those two bundle reads, the two Reflect constructor-probe files' module-object value use, and type-only forms, ANY other appearance of a tracked l10n binding flags by default, known escape or novel (a `{ t }` import or aliased `t` is invisible to extraction and ships untranslated; a renamed namespace would extract but breaks the one greppable shape) - and Biome still keeps `vscode` itself out of the `src/dashboard` tree, which rides into the webview bundle.

No localized module-level constants: modules load before the bundle is configured, so presentation strings resolve at call time (zero-arg functions like `manageCommandTitle()`). Plurals pick between two literal keys at the call site - `n === 1 ? t("1 model") : t("{0} models", n)` - and interpolation goes through `{0}` args, never `${}` inside `t()`, so extraction sees every literal.

Stays English by policy: logger output and `logClassification`/`markLogSafe`, the issue-report body and diagnostics snapshot, `overallStatusText`/`serverOutcomeText`/`ENTRY_PARAMS_INACTIVE_TEXT` (users paste those lines into issue reports), and brand or protocol terms (LiteLLM, GitHub Copilot Chat, OAuth, header names, setting IDs, model IDs, URLs). Anything that throws a localized Error into the status or provider-boundary log path must carry an English mirror, and `shared/mirroredError.ts` enforces that by construction: `MirroredError` (the base every such error extends - `RequestError`, the `localizedError` factory) does not typecheck without `englishMessage` or a terse `logClassification`, so translated text cannot land in the output channel or public issue reports through these types. The logger still reads both fields duck-typed and total, because a logging boundary can be handed anything.

Workflow: after adding or changing localized strings, `bun run l10n:extract` regenerates the key-sorted `l10n/bundle.l10n.json`; `bun run l10n:check` (pre-commit and CI) fails on extraction drift, key-set or `{0}`-placeholder mismatches in any `bundle.l10n.*.json` or `package.nls.*.json`, banned typography in translation files, and `%key%` coverage between package.json and package.nls.json. Chinese translations keep ASCII punctuation plus the CJK full stop, enumeration comma, and corner brackets; fullwidth ASCII variants, ideographic space, curly quotes, ellipsis, and em/en dashes are banned.

### Repository conventions

- Biome formats and lints: tabs (width 2), semicolons, 120-char lines. Husky pre-commit runs format, lint, actionlint, scripts typecheck, and the unit and capture host-fidelity suites; `biome check --write` applies to staged JS/TS files only (via lint-staged, which re-stages its fixes and aborts on unfixable issues), so unstaged sibling edits are left alone, while lints and tests still run against the working tree.
- release-please manages versioning and Marketplace publishing from Conventional Commit titles. Never bump `package.json` manually.
- A commit that resolves a community-reported issue or supersedes a community PR credits the author in its subject, e.g. `fix: normalize base URL slashes (#53, thanks @Pandaplanes)` - release-please copies the subject into the changelog, so the credit ships with the release. Commits that land or supersede community CODE also carry a human `Co-authored-by:` trailer and a row in `ACKNOWLEDGMENTS.md`.
- No AI/tool attribution in commits or PRs: no "Generated with", no "Co-Authored-By: Claude/Copilot/Codex" or similar. `Co-authored-by:` trailers for human community contributors are the one sanctioned use.

### Code review guidance

Prioritize correctness, security, regressions, missing tests, and violations of this document. Report concrete findings tied to the changed code; skip style Biome already enforces. Pay particular attention to streaming responses, tool-call pairing, multimodal conversion, token limits, request-field ownership, and secret handling (storage, logs, and the webview boundary).

### Testing

Tests mirror the source layout under `src/test/` and run in the extension host (`@vscode/test-cli` via `.vscode-test.mjs`, Mocha tdd; entry points build the bundle first). `.vscode-test.mjs` accepts positive globs only (it ignores `!` negations), and stackDrift's label-coverage guard pins every compiled test file to exactly one label. Network mocking uses msw (`src/test/mocks/handlers.ts` documents its quirks), with `withFetch` for what msw cannot express. Property suites (fast-check) are seed-pinned and scale with `FUZZ_RUNS`. Docker suites drive the fake stack through its chat-input command grammar (`src/test/fakeStack/commands.ts`; `%play:<name>` selects a canned stream shape from `src/test/scenarios.ts`). The model catalog in `src/test/fakeStack/models.ts` is the source of truth for the proxy config, generated at stack startup (`docker/.generated/litellm-config.yaml`, gitignored; the test orchestrator always generates it without real-provider wildcard routes). Pin any fuzz-found failure in `src/test/fuzzCorpus.ts`. `COMPOSE_CMD` overrides docker/podman detection.

The one exception to the extension-host rule is the bun test tree (`src/test/bun/`, `bun run test:bun`): the home for suites that need no extension host - the pure logic and property suites, mirroring the source layout, plus the happy-dom component suites in `src/test/bun/webview/`, which render the dashboard's Preact components directly. A suite belongs there only when its transitive runtime imports reach neither `vscode` nor msw; `FUZZ_RUNS`/`FUZZ_SEED` reach the bun leg straight from the shell environment. `bunfig.toml`'s `[test] root` confines bare `bun test` to that tree - the Mocha-tdd suites crash under bun's runner - and its preload (`src/test/bun/preload.ts`) registers the DOM, pins the fixed fingerprint salt, and installs the `acquireVsCodeApi` stub before any test module; real network machinery (msw) stays host-side. The component suites render source `.tsx`, not the esbuild bundle; the packaged-file-list check's size floors on `dist/webview/dashboard.js` and `dist/webview/dashboard.css` guard the bundling side. `test:coverage` runs both runners with coverage and `scripts/ci/check-coverage.ts` enforces the floor over the per-line union of their lcov reports.

Dashboard pixels are gated too: `bun run render:check` renders every fixture in `scripts/dev/renderFixtures/` through the headless-Chrome harness and pixel-compares against the committed Linux baselines in `scripts/dev/renderFixtures/baselines/` (CI's render-check job; ubuntu only because font rasterization is OS-specific). On Linux, `bun run render:update` regenerates baselines; elsewhere, download the render-current artifact from the branch's CI run and commit those PNGs. Expect a full-set regeneration whenever the runner's Chrome or font packages change rendering.

### CI

Repo-owned jobs live in `checks.yml` inside the required all-green gate: the full `bun run test` pass (bun tree, unit, activation-production, and capture host-fidelity suites) on three OSes with a Linux merged coverage floor, the promoted docker-stack suite (docker suites, stream fuzzer, live host-fidelity against the dockerized proxy, and the capture-mode host-fidelity-groups leg, split into two time-balanced shards via `test:docker --only`), an elevated fuzz pass that runs only when the diff touches fuzzer-related paths (skipped otherwise, which the gate counts as green; one unit job plus a sharded docker job), the render-check pixel gate (ubuntu only - font rasterization is OS-specific), and the format-check workflow (including the packaged-file-list check). `docker-test.yml` is a workflow_dispatch-only wrapper; `nightly-fuzz.yml` runs the docker and property suites at high iteration counts and files `nightly-fuzz` issues with reproduction seeds; `release.yml` publishes the VSIX after release-please cuts a release.
