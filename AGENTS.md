# AGENTS.md

Canonical guidance for AI coding agents in this repository. `CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to this file. Keep shared project facts here; the code is the source of truth for implementation detail.

## Project overview

A VS Code extension that integrates LiteLLM into GitHub Copilot Chat via the Language Model Chat Provider API: streaming chat with tool calling, multimodal input (images, PDFs), thinking/reasoning support, and multiple LiteLLM servers at once.

## Commands

```bash
bun run setup-env          # install dependencies (setup-env:pwsh on Windows PowerShell)
bun run compile            # tsc to out/ (tests run from here)
bun run bundle             # production bundle to dist/extension.js + ThirdPartyNotices.txt
bun run bundle:dev         # unminified dist bundle
bun run typecheck          # src/ and scripts/
bun run lint               # Biome
bun run lint:types         # type-aware promise rules (eslint) over src and scripts
bun run lint:knip          # dead files, exports, dependencies
bun run lint:actions       # workflow lint
bun run format             # Biome, writes
bun run test               # unit label in the extension host
bun run test:coverage      # unit label with the enforced source-line coverage floor
bun run host-fidelity-test # end-to-end suite against a capture or live LiteLLM server
bun run mock-server        # local mock LiteLLM server
```

## Validation expectations for agents

- After TypeScript changes: `bun run compile` (src only) and, when scripts/ changed, `bun run typecheck`.
- After source or test changes: `bun run lint`, `bun run lint:types`, `bun run lint:knip`, and the relevant tests (`bun run test` for the unit suite). After workflow changes: `bun run lint:actions`.
- Never launch VS Code, the Extension Development Host, or any GUI for verification; humans test interactively with `F5`.

## Architecture

Three layers plus one standalone module. A Biome override makes any import from the extension layer inside `src/provider.ts` and `src/provider/**` a lint error; `src/shared/` imports neither layer.

- `src/extension.ts` + `src/extension/`: activation, commands, status bar, notifier, diagnostics, and server storage (`serverRegistry.ts`: servers in `globalState` as a version-stamped blob, API keys in SecretStorage). `groupMigration.ts` hands registry servers to VS Code as named provider groups on activation, one server at a time: each accepted group gets a persistent progress record (label, baseUrl, non-secret key fingerprint) and its registry entry is removed only after re-reading and matching that record, duplicate group names are disambiguated with numeric suffixes, and entries whose group cannot be verified (name collisions, mid-seed edits) are marked skipped and announced once. Finalization is state-derived (records exist + registry empty), label mappings (unambiguous labels only) go live as each server seeds, and registry mutations are refused while seeding runs.
- `src/provider.ts` + `src/provider/`: the `LanguageModelChatProvider`. Transport is the official `openai` SDK (`clients.ts` builds one client per server; `errorMapping.ts` maps typed SDK errors to the established user-facing strings). Streaming deliberately does not use the SDK's stream parser: `chatClient.ts` takes the raw response body and `streaming.ts`/`textToolCallParser.ts` parse it, because our contract is log-and-skip on malformed SSE lines and observable aborts. `provider/wire.ts` holds the chunk shapes and the hand-rolled `parseChunk` (per-line hot path; its leniency rules are pinned by tests); `provider/schemas.ts` holds the zod discovery schemas.
- `src/shared/`: cross-layer helpers (message/tool conversion, settings accessors, token estimation, logging; `shared/wire.ts` has the OpenAI request shapes). No VS Code UI dependencies.
- `src/issueReporter.ts`: collects recent logs, redacts secrets, opens prefilled GitHub issues.

Logging goes through `shared/logger.ts` into a `LogOutputChannel` (host-rendered timestamps and levels; `log()` is info, `error()` is error) and, hand-timestamped, into the issue-report buffer. `console.*` is banned in `src/` outside tests.

## Load-bearing invariants

- **Request pass-through.** Beyond the provider-owned request fields (`model`, `messages`, `stream`, `stream_options` with `include_usage`, `max_tokens`, and, when tools are in play, `tools`/`tool_choice`), the extension never injects a request parameter the user did not set: no default temperature, no allow-list. Provider-owned fields cannot be overridden; keys starting with `_` are skipped; everything else from `modelParameters` config and runtime `modelOptions` reaches LiteLLM unchanged. One documented exception: when neither runtime options nor config set `max_tokens`, the request falls back to `min(4096, model max output tokens)`.
- **Capabilities vs parameters.** Capabilities (what a model can do) are read from the LiteLLM API and drive registration and token constraints. Parameters (what we ask it to do) come only from user config and runtime options. `modelParameters` uses longest-prefix matching and supports server scoping by base URL (`http://host:4000/model`) or, for pre-migration configs, by server label (`ServerLabel/model`).
- **Retries.** Discovery GETs retry (idempotent); chat completions never retry. The configured timeouts are hard whole-call bounds.
- **Error ownership.** `discovery.ts` and `chatClient.ts` construct specific errors and throw without logging; the provider boundary (`src/provider.ts`) logs once. Cancellation surfaces as `vscode.CancellationError` and is never logged. In silent refreshes the provider returns an empty model list instead of throwing. 401s are never re-wrapped as network errors.
- **Storage.** Server URLs in `globalState`, API keys in SecretStorage, user options in `litellm-vscode-chat.*` settings. Every Memento/SecretStorage key lives in `shared/storageKeys.ts`.
- **Multi-server IDs.** Servers live in VS Code-managed provider groups: the vendor's `configuration` contribution in `package.json` describes `baseUrl`/`apiKey`, the host calls the provider once per group with that configuration, and `provider/groupModels.ts` attaches the resolved server to each returned model object (raw IDs; the host namespaces them as `litellm/<group>/<id>`). The legacy registry path still serves refreshes that arrive without a configuration until the group migration completes — and permanently in non-production mode, where the `litellm._test.*` commands and the host-fidelity suite depend on it. There, with one server a model's exposed ID is the raw LiteLLM ID; with several it is `<serverId>/<rawModelId>`, and a route map takes chat requests to the right server.

## Conventions

- Biome formats and lints: tabs (width 2), semicolons, 120-char lines. Husky pre-commit runs format, lint, actionlint, typecheck for scripts, and the unit suite; it runs `biome check --write` repo-wide and aborts the commit when that modifies anything, so re-stage and commit again.
- Conventional Commit titles; release-please manages versioning and Marketplace publishing from them. Never bump `package.json` manually.
- No "Co-Authored-By:", "Generated with", or similar attribution in commits or PRs.

## Code review guidance

Prioritize correctness, security, regressions, missing tests, and violations of this document. Report concrete findings tied to the changed code; skip style Biome already enforces. Pay particular attention to streaming responses, tool-call pairing, multimodal conversion, token limits, request-field ownership, and SecretStorage handling.

## Testing

Tests mirror the source layout under `src/test/` and run in the extension host (`@vscode/test-electron`, Mocha tdd). The host activates the extension from the bundled `dist/extension.js`, so every test entry point builds the bundle too. Network mocking uses msw (`src/test/mocks/handlers.ts`; the quirks and their workarounds are documented there), with `withFetch` kept for the cases msw cannot reproduce. Property-based suites (fast-check, seed-pinned) cover the stream parsers. The `host-fidelity` label drives the real chat API against `src/test/capture-server.ts` or a live server configured via `LITELLM_REAL_*` environment variables.

## CI

`ci.yml` calls the reusable format-check and test workflows (three OSes; coverage floor and host-fidelity on Linux); the required merge gate is its `all-green` aggregate job, which deliberately excludes host-fidelity while that job burns in. `release-please.yml` creates release PRs and publishes merged releases. `copilot-setup-steps.yml` prepares the Copilot agent environment via `scripts/setup-env.sh`; keep setup logic in the shared scripts.
