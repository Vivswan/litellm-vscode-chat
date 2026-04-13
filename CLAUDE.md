# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VS Code extension that integrates LiteLLM into GitHub Copilot Chat, allowing users to access 100+ LLMs (OpenAI, Anthropic, Google, AWS, Azure, etc.) through a unified API. The extension implements VS Code's Language Model Chat Provider API to enable streaming chat completions with tool calling, multimodal input (images, PDFs), and thinking/reasoning support.

## Build and Development Commands

```bash
# Install dependencies
bun install

# Compile TypeScript to JavaScript
bun run compile

# Watch mode for development (auto-recompile on changes)
bun run watch

# Run linter
bun run lint

# Format code with Prettier
bun run format

# Run all tests
bun test

# Bump version (updates package.json and CHANGELOG.md)
bun run bump-version
```

## Development Workflow

### Testing the Extension

Press `F5` to launch the Extension Development Host with the extension loaded.

### Running Tests

Tests use the `@vscode/test-electron` framework. Run `bun test` to execute all tests, which compiles the project and runs the test suite.

### Code Style

- **Linting**: ESLint with TypeScript rules
- **Formatting**: Prettier with tabs (width 2), semicolons, 120 character line width
- **Pre-commit hooks**: Husky runs Prettier on staged files via lint-staged

### Git Commit and PR Conventions

- **DO NOT** add "Co-Authored-By: Claude" or similar attribution lines to commit messages
- **DO NOT** add "Generated with Claude Code" or similar markers to pull request descriptions
- Keep commit messages and PR descriptions clean and focused on the actual changes

## Architecture

### Core Components

**`src/extension.ts`**: Extension activation and lifecycle
- Registers the LiteLLM chat provider with vendor ID `"litellm"`
- Implements the `litellm.manage` command for configuration UI
- Manages status bar indicator showing connection state with 4 states:
  - Not configured: `$(warning) LiteLLM`
  - Loading: `$(loading~spin) LiteLLM`
  - Connected: `$(check) LiteLLM (N)` where N is model count
  - Error: `$(error) LiteLLM` with error details in tooltip
- Creates "LiteLLM" output channel for diagnostic logging
- Implements `litellm.testConnection` command to verify server connectivity
- Implements `litellm.showDiagnostics` command to display configuration and connection status
- Stores credentials securely in VS Code's SecretStorage (keys: `litellm.baseUrl`, `litellm.apiKey`)
- Persists connection status in `globalState` across sessions

**`src/provider.ts`**: Main provider implementation (`LiteLLMChatModelProvider`)
- Implements VS Code's `LanguageModelChatProvider` interface
- Fetches available models from LiteLLM's `/v1/model/info` endpoint (with fallback to `/v1/models`)
- Handles streaming chat completions via `/v1/chat/completions`
- Converts VS Code message format to OpenAI-compatible format
- Parses streaming SSE responses and emits parts (text, tool calls, thinking/reasoning)
- Manages tool call buffering and deduplication
- Tracks prompt caching support per model from `/v1/model/info`
- Captures extended model metadata (supports_response_schema, supports_reasoning, supports_pdf_input, supported_openai_params)
- Broad model options pass-through: all `modelOptions` and `modelParameters` keys forwarded to LiteLLM except provider-owned fields (`model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`)
- Requests `stream_options: { include_usage: true }` by default and logs token usage from the final streaming chunk
- Token estimation: text-only for the hard rejection path (no multimodal guesses); `provideTokenCount()` uses rough heuristics for images/PDFs for VS Code UI hints
- Provides status callback mechanism to update extension about fetch results
- Logs all operations to output channel for debugging
- Shows notifications for:
  - Missing configuration (one-time per session)
  - Empty model list from server
  - Connection errors with actionable buttons

**`src/utils.ts`**: Conversion and validation utilities
- `convertMessages()`: Transforms VS Code messages to OpenAI format, including multimodal content:
  - `LanguageModelTextPart` → text content (string or text block)
  - `LanguageModelDataPart` with image MIME (png/jpeg/gif/webp) → `image_url` content block with base64 data URL
  - `LanguageModelDataPart` with `application/pdf` → `file` content block with base64 data URL
  - `LanguageModelDataPart` with text/JSON MIME → decoded as text
  - `LanguageModelPromptTsxPart` → text extraction
  - Unknown binary MIME types → logged and skipped
  - Preserves interleaved ordering of text/image/file parts
  - User messages with non-text parts use array content format; text-only messages use string format
- `convertTools()`: Transforms VS Code tool definitions to OpenAI function definitions
  - `ToolMode.Required` with single tool → named function choice
  - `ToolMode.Required` with multiple tools → `tool_choice: "required"` (no longer throws)
- `sanitizeSchema()`: Sanitizes JSON schemas while preserving provider-compatible features:
  - Preserves composite schemas (`anyOf`/`oneOf`/`allOf`) — recursively sanitizes branches instead of collapsing
  - Preserves `$ref` and `definitions`/`$defs` for recursive schemas
  - Preserves widely-supported keywords: `const`, `examples`, `title`, `exclusiveMinimum`/`exclusiveMaximum`, `minItems`/`maxItems`/`uniqueItems`
  - Does NOT force `type: "object"` on nodes defined by composites or `$ref`
  - Converts `number` → `integer` for ID-like property names
- `validateRequest()`: Ensures correct tool call/result pairing in message sequences
- `collectToolResultText()`: Handles text, `LanguageModelDataPart` (text/JSON decoded, image warned), and `LanguageModelPromptTsxPart` in tool results
- `tryParseJSONObject()`: Safely parses JSON for tool call arguments

**`src/types.ts`**: TypeScript interfaces for LiteLLM and OpenAI types
- `OpenAIChatContentBlock`: Discriminated union of `OpenAIChatTextContentBlock`, `OpenAIChatImageUrlContentBlock`, and `OpenAIChatFileContentBlock`
- `LiteLLMProvider`: Extended with `supports_response_schema`, `supports_reasoning`, `supports_pdf_input`, `supported_openai_params`
- `LiteLLMModelInfoItem`: Extended with `supports_response_schema`, `supports_reasoning`, `supports_pdf_input`, `supports_audio_input`, `supports_audio_output`, `supported_openai_params`

### Key Architectural Patterns

**Model Registration with Provider Variants**

The extension creates multiple model entries per LiteLLM model to support provider-specific routing:
- `model-name:cheapest` - Routes to the cheapest available provider
- `model-name:fastest` - Routes to the fastest available provider
- `model-name:provider-name` - Routes to a specific provider (e.g., `gpt-4:openai` or `gpt-4:azure`)

This allows users to choose routing strategy in the VS Code chat model picker.

**Token Limit Management**

Token constraints are resolved with the following priority:
1. LiteLLM model info (from `/v1/models` response)
2. Workspace settings (`litellm-vscode-chat.default*`)
3. Hardcoded defaults (16K output, 128K context)

The provider uses rough estimation (length/4) for token counting.

**Model Parameters vs Capabilities**

There are two distinct configuration concepts:
- **Capabilities** (read from LiteLLM API): What the model CAN do (max tokens, context length, tool support, vision, reasoning, PDF input, etc.) - handled by `getTokenConstraints()` and extended metadata
- **Parameters** (from user config or runtime): What we ASK the model to do (temperature, max_tokens, response_format, reasoning_effort, etc.) - handled by `getModelParameters()` and broad pass-through

The `modelParameters` setting uses longest-prefix matching, so `"gpt-4"` matches `"gpt-4-turbo:openai"`.

**Request Parameter Pass-through**

The extension uses a broad pass-through approach for model parameters rather than an allow-list:
- **Provider-owned fields** (never overwritable): `model`, `messages`, `stream`, `tools`, `tool_choice`
- **Special handling**: `max_tokens` has its own precedence logic (runtime > config > default clamped to model max)
- **Everything else**: All keys from `modelParameters` config and `options.modelOptions` runtime are forwarded directly to LiteLLM

This enables any LiteLLM/OpenAI-compatible parameter without extension updates: `response_format`, `reasoning_effort`, `seed`, `top_k`, `parallel_tool_calls`, `logprobs`, `modalities`, `metadata`, etc.

**Model Info and Prompt Caching**

The provider fetches model metadata from LiteLLM's `/v1/model/info` endpoint:
- **Fallback logic**: Tries `/v1/model/info` first, falls back to `/v1/models` on any error
- **Model ID extraction**: Uses priority fallback (model_name → litellm_params.model → model_info.key → model_info.id)
- **Prompt caching detection**: Tracks `supports_prompt_caching` flag per model
- **Extended metadata**: Captures `supports_response_schema`, `supports_reasoning`, `supports_pdf_input`, `supported_openai_params` for diagnostics and future use
- **Vision detection**: Sets `imageInput` capability from `supports_vision`; includes `pdf` in `input_modalities` from `supports_pdf_input`
- **Cache management**: Only clears cache on successful fetch to preserve data on failure
- **Cache control**: Adds `cache_control` blocks to system messages for supported models when enabled

Prompt caching is controlled by `promptCaching.enabled` setting (default: true) and only affects models that advertise support.

**Streaming Response Processing**

The provider handles three formats for tool calls:
1. **Standard OpenAI format**: Tool calls in `delta.tool_calls[]` array
2. **Inline control tokens**: `<|tool_call_begin|>name<|tool_call_argument_begin|>{...}<|tool_call_end|>` embedded in text
3. **Control token stripping**: Removes `<|*_section_begin|>` and `<|*_section_end|>` markers

Tool calls are buffered until arguments become valid JSON, then emitted immediately to avoid perceived hanging. Deduplication prevents duplicate emissions.

The provider handles thinking/reasoning tokens from multiple providers:
- `choice.thinking` or `delta.thinking` — Anthropic Claude format (structured object with text/id/metadata)
- `delta.reasoning_content` — DeepSeek, Kimi/Moonshot, xAI/Grok format (plain string)
- `delta.reasoning` — other providers mapped through LiteLLM
- All mapped to `LanguageModelThinkingPart` (probed dynamically, not yet in stable VS Code API)

Structured `delta.content` arrays are handled: text blocks are extracted, non-text blocks silently ignored.

Token usage from the final streaming chunk is logged to the output channel. The usage extraction runs before the `choices[0]` early-return to catch the common OpenAI `choices: []` + `usage: {...}` trailer format.

**Configuration Storage**

- Base URL and API key stored in VS Code's SecretStorage (encrypted)
- Settings like token limits and model parameters stored in workspace/user settings
- First-run welcome message shown once using `globalState`
- Connection status persisted in `globalState` for status bar restoration

**Diagnostics and Status Tracking**

The extension implements comprehensive diagnostics to help users troubleshoot configuration issues:

1. **Status Bar Indicator**: Shows real-time connection state
   - Updates automatically when models are fetched
   - Persists state across VS Code reloads
   - Click to open diagnostics dialog

2. **Output Channel**: Provides detailed logging
   - All configuration changes logged with timestamps
   - Model fetch attempts and results
   - Full error messages with stack traces
   - Network request/response information
   - Located at "Output" panel → "LiteLLM" dropdown

3. **Status Callback Pattern**: Provider notifies extension of fetch results
   - `setStatusCallback()` method accepts callback function
   - Provider calls callback with model count on success or error message on failure
   - Extension updates status bar and persists state

4. **User Notifications**: Proactive error reporting
   - One-time notification when no configuration exists (silent mode only)
   - Warning when server returns empty model list
   - Error notifications with actionable buttons (Reconfigure, View Output)

5. **Test Connection Command**: Proactive verification
   - Manually trigger model fetch to test connectivity
   - Shows detailed success/failure messages
   - Updates status bar with results
   - Provides access to output channel logs

## Common Patterns

### Adding a New Configuration Option

1. Add the property to `package.json` under `contributes.configuration.properties`
2. Read the value in `provider.ts` using `vscode.workspace.getConfiguration("litellm-vscode-chat")`
3. Apply the configuration in the appropriate method (e.g., `provideLanguageModelChatResponse`)

### Extending Tool Call Support

Tool call handling is in `provider.ts`:
- `processDelta()`: Processes incoming SSE chunks
- `tryEmitBufferedToolCall()`: Emits tool calls when JSON is valid
- `processTextContent()`: Handles inline control token parsing
- `flushToolCallBuffers()`: Flushes all buffered calls on completion

### Error Handling Strategy

- **Model fetch fallback**: `/v1/model/info` errors (including non-404/405) gracefully fall back to `/v1/models`
- **Network/certificate errors**: Provide specific actionable error messages
- **Authentication failures (401)**: Prompt user to run "Manage LiteLLM Provider" command
- **Silent mode errors**: Return empty array instead of throwing to prevent UI breakage
- **Tool call JSON errors**: Throw on completion, silently drop on cancellation
- **Logging consistency**: All errors logged through `this.log()` instead of `console.warn/error` for unified output

## CI/CD Structure

Workflows are organized with reusable workflow patterns:
- **`bump-version-reusable.yml`**: Reusable workflow for version bumping
- **`format-check-reusable.yml`**: Reusable workflow for Prettier format checking
- **`test-reusable.yml`**: Reusable workflow for running tests
- **`ci.yml`**: Main CI pipeline that calls reusable workflows
- **`release.yml`**: Deploys to VS Code Marketplace on `deploy` branch push
- **`auto-format.yml`**: Auto-formats and commits when PR has `auto-format` label

Husky pre-commit hooks are disabled in CI using `CI=true` environment variable.

## Testing Notes

- Test file: `src/test/provider.test.ts`
- Tests run in VS Code Extension Host environment
- Use `@vscode/test-electron` for extension testing
