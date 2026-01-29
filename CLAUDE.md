# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VS Code extension that integrates LiteLLM into GitHub Copilot Chat, allowing users to access 100+ LLMs (OpenAI, Anthropic, Google, AWS, Azure, etc.) through a unified API. The extension implements VS Code's Language Model Chat Provider API to enable streaming chat completions with tool calling support.

## Build and Development Commands

```bash
# Install dependencies
npm install

# Compile TypeScript to JavaScript
npm run compile

# Watch mode for development (auto-recompile on changes)
npm run watch

# Run linter
npm run lint

# Format code with Prettier
npm run format

# Run all tests
npm test

# Bump version (updates package.json and CHANGELOG.md)
npm run bump-version
```

## Development Workflow

### Testing the Extension

Press `F5` to launch the Extension Development Host with the extension loaded.

### Running Tests

Tests use the `@vscode/test-electron` framework. Run `npm test` to execute all tests, which compiles the project and runs the test suite.

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
- Fetches available models from LiteLLM's `/v1/models` endpoint
- Handles streaming chat completions via `/v1/chat/completions`
- Converts VS Code message format to OpenAI-compatible format
- Parses streaming SSE responses and emits parts (text, tool calls, thinking)
- Manages tool call buffering and deduplication
- Provides status callback mechanism to update extension about fetch results
- Logs all operations to output channel for debugging
- Shows notifications for:
  - Missing configuration (one-time per session)
  - Empty model list from server
  - Connection errors with actionable buttons

**`src/utils.ts`**: Conversion and validation utilities
- `convertMessages()`: Transforms VS Code messages to OpenAI format
- `convertTools()`: Transforms VS Code tool definitions to OpenAI function definitions
- `validateRequest()`: Ensures correct tool call/result pairing in message sequences
- `sanitizeSchema()`: Cleans JSON schemas to work with OpenAI's requirements (removes unsupported keywords, handles composite schemas like anyOf/oneOf/allOf, converts number types to integer for ID-like properties)
- `tryParseJSONObject()`: Safely parses JSON for tool call arguments

**`src/types.ts`**: TypeScript interfaces for LiteLLM and OpenAI types

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
- **Capabilities** (read from LiteLLM API): What the model CAN do (max tokens, context length, tool support) - handled by `getTokenConstraints()`
- **Parameters** (from user config): What we ASK the model to do (temperature, max_tokens, etc.) - handled by `getModelParameters()`

The `modelParameters` setting uses longest-prefix matching, so `"gpt-4"` matches `"gpt-4-turbo:openai"`.

**Streaming Response Processing**

The provider handles three formats for tool calls:
1. **Standard OpenAI format**: Tool calls in `delta.tool_calls[]` array
2. **Inline control tokens**: `<|tool_call_begin|>name<|tool_call_argument_begin|>{...}<|tool_call_end|>` embedded in text
3. **Control token stripping**: Removes `<|*_section_begin|>` and `<|*_section_end|>` markers

Tool calls are buffered until arguments become valid JSON, then emitted immediately to avoid perceived hanging. Deduplication prevents duplicate emissions.

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

- Network/certificate errors: Provide specific actionable error messages
- Authentication failures (401): Prompt user to run "Manage LiteLLM Provider" command
- Silent mode errors: Return empty array instead of throwing to prevent UI breakage
- Tool call JSON errors: Throw on completion, silently drop on cancellation

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
