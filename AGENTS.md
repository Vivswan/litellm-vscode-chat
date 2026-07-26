# AGENTS.md

This file provides canonical guidance to AI coding agents working with code in this repository.

## Instruction sources

- `AGENTS.md` is the canonical, cross-agent source for repository architecture, development commands, and contribution rules.
- `CLAUDE.md` and `.github/copilot-instructions.md` are symlinks to this file so Claude Code and GitHub Copilot receive the same guidance.
- Keep shared project facts here instead of duplicating them across agent-specific configuration files.

## Project overview

This is a VS Code extension that integrates LiteLLM into GitHub Copilot Chat, allowing users to access 100+ LLMs (OpenAI, Anthropic, Google, AWS, Azure, etc.) through a unified API. The extension implements VS Code's Language Model Chat Provider API to enable streaming chat completions with tool calling, multimodal input (images, PDFs), and thinking/reasoning support. It supports multiple LiteLLM servers at once.

## Build and development commands

```bash
# Install dependencies on macOS/Linux, or shells with Bash
bun run setup-env

# Install dependencies on Windows PowerShell
bun run setup-env:pwsh

# Install dependencies and run compile/lint on macOS/Linux, or shells with Bash
bun run setup-env:verify

# Install dependencies and run compile/lint on Windows PowerShell
bun run setup-env:verify:pwsh

# Compile TypeScript to JavaScript (src/ only, per-file output in out/ for tests)
bun run compile

# Bundle the extension into dist/extension.js (production: minified, regenerates ThirdPartyNotices.txt)
bun run bundle

# Development bundle of dist/extension.js (no minify)
bun run bundle:dev

# Typecheck src/ and scripts/
bun run typecheck

# Watch mode for development (auto-recompile on changes)
bun run watch

# Run linter (Biome)
bun run lint

# Format code with Biome
bun run format

# Run the unit test label (compiles first)
bun run test

# Run the host-fidelity suite against a real or capture server
bun run host-fidelity-test

# Start the local mock LiteLLM server used in development
bun run mock-server
```

## Development workflow

### Manual extension testing

For human interactive testing, press `F5` to launch the Extension Development Host with the extension loaded. Automated agents must not launch VS Code, the Extension Development Host, or another GUI for verification.

### Running tests

Tests use the `@vscode/test-electron` framework, configured in `.vscode-test.mjs` with two labels. The extension host activates the extension from the bundled `dist/extension.js` (`main` in package.json), while the test files themselves run from the per-file `out/` compile — both test entry points build both.

- `unit`: every test file under `out/test/` except `host-fidelity.test.js`. This is what `bun run test` runs.
- `host-fidelity`: `src/test/host-fidelity.test.ts` only. It reads `LITELLM_REAL_BASE_URL`, `LITELLM_REAL_API_KEY`, `LITELLM_REAL_MODEL`, and `LITELLM_REAL_TIMEOUT` from the environment; live suites skip themselves when the base URL is unset. `bun run host-fidelity-test` drives it via `scripts/host-fidelity-test.ts`.

### Agent environment setup

- `scripts/setup-env.sh` and `scripts/setup-env.ps1` are the shared setup implementations.
- `bun run setup-env:verify` is the canonical macOS/Linux entry point used by local GitHub Copilot app sessions and the Copilot cloud agent.
- `.github/github-app.yml` configures local GitHub Copilot app sessions.
- `.github/workflows/copilot-setup-steps.yml` configures the ephemeral GitHub Actions environment used by Copilot cloud agent.
- Keep setup logic in the shared scripts; the Copilot configuration files should only invoke it.

### Automated agent validation

- Run `bun run compile` after TypeScript changes. It only covers `src/`; after changing `scripts/*.ts`, also run `bun run typecheck`, which checks both.
- Run `bun run lint` (Biome), `bun run lint:types` (type-aware promise rules via eslint), and `bun run lint:knip` (dead files/exports/dependencies) after source or test changes; `bun run lint:actions` after workflow changes.
- `bun run test:coverage` runs the unit suite with a line-coverage floor enforced by `scripts/check-coverage.ts`; CI enforces it on Linux.
- Run the relevant tests for the affected behavior; use `bun run test` for the unit suite.
- Do not launch GUI applications as part of automated validation.

### Code style

- Linting and formatting: Biome (`biome.json`), with tabs (width 2), semicolons, 120 character line width.
- Pre-commit hooks: Husky runs `biome format` on staged files via lint-staged, then `biome check --write` across the repo.

### Git commit and PR conventions

- Do not add "Co-Authored-By:" or similar attribution lines to commit messages.
- Do not add "Generated with" or similar markers to pull request descriptions.
- Keep commit messages and PR descriptions clean and focused on the actual changes.

### Code review guidance

- Prioritize correctness, security, regressions, missing tests, and violations of the documented architecture.
- Report concrete, actionable findings tied to the changed code.
- Do not request style-only changes already handled by Biome.
- Pay particular attention to streaming responses, tool-call pairing, multimodal conversion, token limits, request-field ownership, and SecretStorage handling.

## Architecture

The source tree has three layers plus two standalone modules:

- `src/extension.ts` and `src/extension/`: activation, commands, the status bar, diagnostics, and server storage.
- `src/provider.ts` and `src/provider/`: the language-model provider, split into focused modules for discovery, registration, request building, and streaming.
- `src/shared/`: pure conversion and validation helpers with no VS Code UI dependencies.
- `src/issueReporter.ts`: collects recent logs and errors, redacts secrets, and opens prefilled GitHub issues.
- `src/types.ts`: TypeScript interfaces for the LiteLLM and OpenAI wire formats.

### Extension layer

`src/extension.ts` activates the extension: it creates the "LiteLLM" output channel, constructs the `IssueReporter`, the shared `Logger`, the `ServerRegistry`, and the `LiteLLMChatModelProvider`, wires the provider to the registry and the configuration prompt, awaits the legacy-config migration, registers the provider under vendor ID `"litellm"`, and registers the commands. The layers are separated: shared domain types (`ServerConfig`, `ServerWithKey`, `ServerStatus`, `AggregatedStatus`) live in `src/shared/servers.ts`, and a Biome override turns any import from the extension layer inside `src/provider/**` into a lint error.

The modules under `src/extension/`:

- `serverRegistry.ts` owns server storage. The registry is authoritative in memory and persists to `globalState` under `litellm.serverRegistry` as a version-stamped blob (snapshots from other windows are adopted only when strictly newer, so stale storage broadcasts cannot revert a registration); each server's API key lives in SecretStorage under `litellm.apiKey.<id>`. `migrateLegacy()` converts the old single-server secrets (`litellm.baseUrl`, `litellm.apiKey`) into a registry entry named "Default" and deletes them; those legacy keys exist only for this migration.
- `serverManagement.ts` implements the `litellm.manage` quick-pick flows for adding, editing, and removing servers.
- `status.ts` (`StatusBarManager`) renders the status bar item with five states (not configured, loading, connected with model count, degraded when some servers fail, error) and persists the last `ConnectionStatus` in `globalState` under `litellm.lastConnectionStatus` so the state survives reloads.
- `notifier.ts` owns user-facing toasts: `showActionableMessage` plus shared action factories, `createConfigurationPrompt()` for the interactive configure-then-continue flow, and the `Notifier`, which consumes the provider's status callback and toasts once per failure condition on silent refreshes (deduped until a successful refresh resets the signature). Non-silent refreshes never toast from the Notifier; their caller surfaces the result.
- `diagnostics.ts` builds the diagnostics snapshot and registers `litellm.showDiagnostics`.
- `commands.ts` registers `litellm.testConnection`, `litellm.reportIssue`, `litellm.helpAndFeedback`, and, outside production mode, the `litellm._test.*` commands the host-fidelity tests drive. The test mutation commands (`addServer`, `removeServer`, `clearServers`) run serialized, refresh models after mutating, and resolve with the fresh model IDs (or null when superseded by a newer mutation).

Commands contributed in `package.json`: `litellm.manage`, `litellm.testConnection`, `litellm.showDiagnostics`, `litellm.helpAndFeedback`, and `litellm.reportIssue`.

### Provider layer

`src/provider.ts` (`LiteLLMChatModelProvider`) implements VS Code's `LanguageModelChatProvider` as a facade over one `ChatClient`. `provideLanguageModelChatInformation` fetches models from every configured server, aggregates them into `LanguageModelChatInformation` entries, and reports per-server status (with the refresh's `silent` flag) through the callback the extension registers; `provideLanguageModelChatResponse` delegates to the client; `provideTokenCount` uses the shared token estimation with multimodal estimates.

The modules under `src/provider/`:

- `chatClient.ts` (`ChatClient`) owns the `/v1/chat/completions` call (message conversion, validation, token-limit rejection, timeout, streaming) plus the model routes, the prompt-caching map, and the tool-call ID counter that stream processors mint IDs from. The HTTP transport is the official `openai` SDK: requests go through `client.post(...).asResponse()` so the SDK handles auth, URLs, and HTTP-error typing while the response body still streams through our own `StreamProcessor` (the SDK's stream parser is not used — it aborts on malformed SSE lines and swallows mid-stream aborts, both against our contracts).
- `clients.ts` (`createServerClient`, `ServerClientCache`) builds one OpenAI client per server: `Authorization: Bearer` from the SDK plus `X-API-Key` and custom headers via `defaultHeaders`, keyless servers send no auth header at all, and a late-binding fetch wrapper reads `globalThis.fetch` per call so test-time fetch replacement works. Chat requests use `maxRetries: 0`; every call passes the configured timeout as the per-request SDK `timeout` so the SDK's own 600 s default never cuts in.
- `errorMapping.ts` (`mapSdkError`, `RequestError`) maps typed SDK errors onto the provider's user-facing strings, walking the full cause chain for certificate/ENOTFOUND/ECONNREFUSED/timeout classification; `RequestError.kind` lets callers branch without matching message text.
- `config.ts` resolves which servers to use (`ensureServers`, `resolveServer`); the interactive configure-then-continue prompt is injected from the extension layer as a `ConfigurationPrompt`.
- `discovery.ts` (`fetchModels`) calls `/v1/model/info` and falls back to `/v1/models` on any error, normalizing both into `LiteLLMModelItem`s.
- `registration.ts` (`buildModelInfos`) turns fetched models into chat-model entries, registers routes, and records per-model prompt-caching support.
- `modelCatalog.ts` defines `ModelRoute`, `buildExposedModelId`, and `getTokenConstraints`.
- `request.ts` matches `modelParameters` config (`getModelParameters`) and builds request bodies (`buildRequestBody`).
- `streaming.ts` (`StreamProcessor`) parses SSE chunks through the typed `parseChunk` contract and emits response parts, deduplicating tool calls that arrive on both the delta and inline channels.
- `textToolCallParser.ts` (`TextToolCallParser`) is the pure incremental scanner for `<|tool_call_begin|>` sequences embedded in streamed text, returning ordered text/call events.

### Shared modules

- `messages.ts` (`convertMessages`, `collectToolResultText`, `isToolResultPart`) converts VS Code messages to the OpenAI format, including multimodal content: image MIME types become `image_url` blocks with base64 data URLs, `application/pdf` becomes a `file` block, text and JSON MIME types are decoded as text, `LanguageModelPromptTsxPart` is converted to text, and unknown binary MIME types are logged and skipped. Interleaved ordering of parts is preserved; text-only messages use string content, mixed content uses the array format.
- `tools.ts` (`convertTools`, `sanitizeSchema`, `sanitizeFunctionName`) converts VS Code tool definitions to OpenAI function definitions. `ToolMode.Required` maps to a named function choice for a single tool and `tool_choice: "required"` for several. `sanitizeSchema` preserves composite schemas (`anyOf`/`oneOf`/`allOf`), `$ref` and `definitions`/`$defs`, and widely supported keywords, and converts `number` to `integer` for ID-like property names.
- `validation.ts` (`validateRequest`) checks tool call/result pairing in message sequences.
- `json.ts` (`tryParseJSONObject`) safely parses tool-call argument JSON.
- `settings.ts` has one accessor per `litellm-vscode-chat.*` setting, each reading fresh per call and validating exactly once (`clampTimeout` for the two timeouts).
- `tokenEstimation.ts` holds the token heuristics (`CHARS_PER_TOKEN`, `IMAGE_TOKEN_ESTIMATE`, `PDF_TOKEN_ESTIMATE`) behind `estimatePartTokens(part, { includeMultimodal })`; the chat rejection path counts text only, `provideTokenCount` includes multimodal estimates.
- `mime.ts` (`isTextMimeType`, `isImageMimeType`) is the single home for MIME classification.
- `servers.ts` holds the cross-layer domain types (`ServerConfig`, `ServerWithKey`, `ServerStatus`, `AggregatedStatus`).
- `logger.ts` (`Logger`) writes timestamped lines to the output channel and the issue-report buffer; every module logs through it.
- `storageKeys.ts` centralizes every Memento and SecretStorage key.
- `numbers.ts` (`normalizePositiveNumber`) validates numeric config values.

### Multi-server model registration

Each server's models are registered separately. With one server, a model's exposed ID is the raw LiteLLM ID; with more than one, it is prefixed as `<serverId>/<rawModelId>` and display names get a `[label] ` prefix. The provider keeps a route map from exposed ID to `{ serverId, rawModelId, serverLabel }` so chat requests reach the right server.

Per model, registration produces entries by provider composition:

- One provider whose data came from `/v1/model/info`, or no provider data at all: a single entry.
- Otherwise (several providers, or a single provider from another source): `model:cheapest` and `model:fastest` aggregate entries (LiteLLM routes to the cheapest or fastest provider) plus one `model:provider` entry per tool-capable provider.
- No tool-capable providers: a single entry with `toolCalling: false`.

### Token limits

Token constraints resolve per field in `getTokenConstraints`: max output tokens come from model info (`max_output_tokens`, then `max_tokens`), then the `defaultMaxOutputTokens` setting, then 16K; context length comes from model info (`context_length`), then `defaultContextLength`, then 128K; max input tokens come from the `defaultMaxInputTokens` setting first (it overrides model info when set), then model info (`max_input_tokens`), then context length minus max output tokens. A request's `max_tokens` comes from runtime `modelOptions`, then `modelParameters` config, and only when neither sets it does the fallback `min(4096, model max output tokens)` apply; explicit values pass through unclamped.

### Model parameters vs capabilities

Two distinct configuration concepts:

- Capabilities (read from the LiteLLM API): what the model can do (max tokens, context length, tool support, vision). Handled by `getTokenConstraints` and registration.
- Parameters (from user config or runtime): what we ask the model to do (temperature, max_tokens, response_format, reasoning_effort). Handled by `getModelParameters` and pass-through.

The `modelParameters` setting uses longest-prefix matching, so `"gpt-4"` matches `"gpt-4-turbo:openai"`. Entries can be scoped to a server by prefixing the key with the server label (`"Production/gpt-4"`); scoped entries win over unscoped ones.

### Request parameter pass-through

The extension forwards parameters broadly rather than keeping an allow-list, and it never injects a parameter the user did not set (the model provider's own defaults apply):

- Provider-owned fields, never overwritable: `model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`.
- Keys starting with `_` are skipped in both `modelParameters` config (retired extension metadata) and runtime `modelOptions` (VS Code injects internal fields there).
- Everything else from `modelParameters` config and runtime `modelOptions` goes to LiteLLM unchanged, so any LiteLLM/OpenAI-compatible parameter works without extension updates.

Requests always set `stream_options: { include_usage: true }`; token usage from the final streaming chunk is logged to the output channel.

### Prompt caching

Registration records `supports_prompt_caching` per model from `/v1/model/info`. When the `promptCaching.enabled` setting is on (default) and the model advertises support, `convertMessages` adds a `cache_control` block to the system message. Model routes and caching flags are cleared whenever at least one server fetch succeeds, so a refresh where every server fails keeps the previous data, but a partial success also drops the entries that belonged to the failed servers.

### Streaming response processing

`StreamProcessor` handles three tool-call formats:

1. Standard OpenAI deltas in `delta.tool_calls[]`.
2. Inline control tokens embedded in text: `<|tool_call_begin|>name<|tool_call_argument_begin|>{...}<|tool_call_end|>`.
3. Section markers `<|*_section_begin|>` and `<|*_section_end|>`, which are stripped.

Tool calls are buffered until their arguments parse as JSON, then emitted immediately; deduplication prevents double emission. Thinking/reasoning tokens arrive as `choice.thinking` or `delta.thinking` (structured), `delta.reasoning_content` (DeepSeek, Kimi, Grok), or `delta.reasoning`, and map to `LanguageModelThinkingPart`, which is probed dynamically because it is not yet in the stable VS Code API. Structured `delta.content` arrays are handled by extracting the text blocks.

### Configuration storage

Server URLs live in `globalState`; API keys live in SecretStorage (see the ServerRegistry description above). Settings such as token limits, `modelParameters`, and `headers` live in workspace or user settings under `litellm-vscode-chat.*`. The first-run welcome flag is `litellm.hasShownWelcome` in `globalState`.

### Diagnostics and status

The provider reports an `AggregatedStatus` (per-server statuses plus total model count) through the status callback after every fetch; `StatusBarManager` renders it and persists it. All provider operations log through `log`/`logError` to the output channel, and the same lines feed the `IssueReporter` buffer that `litellm.reportIssue` attaches (secret-redacted) to prefilled GitHub issues. `litellm.testConnection` triggers a non-silent model fetch and reports the result.

## Common patterns

### Adding a new configuration option

1. Add the property to `package.json` under `contributes.configuration.properties`.
2. Add an accessor for it in `src/shared/settings.ts`, validating the raw value there, and read it through that accessor.

### Extending tool call support

Tool call handling is in `src/provider/streaming.ts` (`StreamProcessor`): `processDelta` processes incoming SSE chunks, `processTextContent` parses inline control tokens, `tryEmitBufferedToolCall` emits calls once their JSON is valid, and `flushToolCallBuffers` flushes at end of stream.

### Error handling strategy

- Model fetch: any `/v1/model/info` error falls back to `/v1/models`. Payload entries are narrowed element-wise with type guards; a malformed entry is skipped with a log line rather than aborting registration, and a nonempty payload with zero usable entries triggers the same fallback.
- Network and certificate errors produce specific, actionable messages via `errorMapping.ts`, which classifies the typed `openai` SDK errors and walks their cause chains. HTTP-status errors (like 401) are classified separately from network failures and are never re-wrapped as network errors.
- Authentication failures (401) prompt the user to run "Manage LiteLLM Provider".
- In silent mode the provider returns an empty model list instead of throwing, so the UI keeps working.
- Errors are logged once, at the provider boundary (`src/provider.ts`); `discovery.ts` and `chatClient.ts` construct specific errors and throw without logging, so the issue-report buffer is not double-filled. User cancellation aborts the in-flight fetch and surfaces as `vscode.CancellationError`, which is not logged.
- Invalid standard tool-call JSON is logged and throws when a `tool_calls` or `stop` finish reason arrives (though the broad per-SSE-line catch currently swallows that error); buffers still pending at `[DONE]` or cancellation are dropped without logging.
- Log through the shared `Logger` so messages reach both the output channel and issue reports. `console.*` is banned in `src/` outside tests (Biome `noConsole`); shared helpers take an optional `log` callback instead.

## CI/CD structure

Workflows are organized with reusable workflow patterns:

- `format-check-reusable.yml`: reusable workflow for Biome format and lint checking (`biome ci`).
- `test-reusable.yml`: reusable workflow for running tests.
- `ci.yml`: main CI pipeline that calls the reusable workflows.
- `release-please.yml`: runs release-please on `main` to create release PRs and publishes created releases to the VS Code Marketplace.
- `copilot-setup-steps.yml`: prepares the Copilot coding agent environment using `scripts/setup-env.sh`.
- `pr-title.yml`: enforces Conventional Commit PR titles for release-please.
- `auto-format.yml`: auto-formats and commits when a PR has the `fix-lint` label.

Husky pre-commit hooks are disabled in CI via the `CI=true` environment variable.

Releases are managed by release-please from Conventional Commits. Do not manually bump `package.json`; merging the release-please PR creates the GitHub Release and publishes the VSIX.

## Testing notes

Tests live under `src/test/`, mirroring the source layout:

- `src/test/shared/`: unit tests for the shared conversion and validation helpers.
- `src/test/provider/`: unit tests for streaming, timeouts, and model defaults.
- `src/test/extension/`: tests for the extension-layer commands.
- `src/test/provider.test.ts`: the main provider suite (model listing, request building, error paths) using mocked `fetch` and SecretStorage.
- `src/test/issueReporter.test.ts`: issue reporter and secret redaction tests.
- `src/test/host-fidelity.test.ts`: end-to-end tests that drive the real VS Code chat API against a capture server or a live LiteLLM instance, synchronized through the `litellm._test.*` commands.

All tests run in the VS Code Extension Host via `@vscode/test-electron` with the tdd Mocha UI. `bun run test` runs the `unit` label only; the host-fidelity label runs separately (see "Running tests").
