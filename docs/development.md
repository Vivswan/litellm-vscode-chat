# Development

How to build the extension from source and, for anyone who wants a LiteLLM proxy to test against (contributor or not), how to run the repository's local stack: a real LiteLLM proxy in Docker backed by a fake, fully scriptable OpenAI server.

## Building from source

```bash
git clone https://github.com/Vivswan/litellm-vscode-chat
cd litellm-vscode-chat
bun install
bun run compile
```

Press `F5` to launch the Extension Development Host, or `bun run dev` to launch it preconfigured against the local stack below. In the dev container (or any other headless Linux machine), run the test suite under a virtual display: `xvfb-run -a bun run test`.

| Command | Description |
|---------|-------------|
| `bun run compile` | Build |
| `bun run watch` | Watch mode |
| `bun run lint` | Lint |
| `bun run format` | Format |
| `bun run test` | Run tests |

[CONTRIBUTING.md](../CONTRIBUTING.md) covers environment setup, the full check list, and how to submit a pull request.

## Local LiteLLM stack (Docker or Podman)

For local testing you can run a real LiteLLM proxy in Docker, backed by a fake OpenAI server:

```bash
cp .env.example .env   # optional; only needed for real provider keys or port changes
bun run docker:up
```

Then add a server in the extension with base URL `http://localhost:4000` and API key `sk-test-1234`.

The fake serves six realistic models and takes its instructions from the chat input itself: a `%` command on the last line of your message picks the response shape, so one model can play every stream shape the extension handles. (The sigil is `%` because the obvious choices are both intercepted before they reach the model: Copilot Chat claims `/`-prefixed input for its own slash commands, and agent CLIs like Claude Code run a leading `!` as a shell command, while no chat input surface claims `%`.)

The model list is deliberately small and shaped like a real deployment (`src/test/fakeStack/models.ts`):

| Model | What it plays |
|-------|---------------|
| `claude-opus-4-5` | Everything on: reasoning, caching, tiered pricing, 1M context |
| `gpt-5.2` | A load-balanced pair |
| `gpt-5.2-mini` | The everyday target |
| `gpt-5.2-omni` | Audio flags |
| `deepseek-r2` | Reasoning without tools |
| `llama-4-scout` | No limits or pricing declared, tools explicitly off |
| `gpt-4-turbo` | Blocked in the config; must never appear in the picker - that absence is itself under test |

Pick any of them in the Copilot model picker and type a command as your message. `%help` lists everything; the ones you will reach for first:

```
%help                     list all commands and playback scenarios
%play:thinking-blocks     play a canned stream shape (the library lives in src/test/scenarios.ts)
%echo:any text            reply with exactly that text
%echon:one\ntwo           multi-line echo: \n decodes to a newline, \\ keeps a backslash
%text:200                 a deterministic 200-word paragraph
%think:5                  reasoning chunks, then a closing text
%tool:get_weather {}      call an offered tool, then summarize its result on the next turn
%image, %audio            byte-stable generated media carrying their own sha256
%params, %messages, %attachments, %tools   inspect what actually reached the backend
%cache, %deployment       cache_control marker positions; which upstream served the request
%error:429, %finish:length, %stream:50:100, %delay:2000   error, truncation, pacing shapes
%abort:3, %nodone:5, %stall:3:30000   transport failures: dropped socket, missing [DONE], silent stall
```

A message without a command gets a fixed reply pointing at `%help`. Everything is deterministic: the same conversation produces the same bytes.

### Real provider routes

The proxy config is generated at stack startup (`docker/.generated/litellm-config.yaml`, gitignored) from `src/test/fakeStack/models.ts`. On top of the fixed catalog:

- **A real provider key** set in `.env` or the environment makes the generated config also route `openai/*` or `anthropic/*` model names through the proxy to that provider - the intended way to eyeball real-provider behavior through the same stack. It also turns on LiteLLM's `check_provider_endpoint`, which expands the wildcard into the provider's live catalog on `/v1/models` for direct API consumers of the proxy; the extension's picker reads `/v1/model/info`, where a wildcard route appears as its literal entry (`openai/*`).
- **Without a key** the wildcard route is not emitted at all, so there are no phantom catalog models and no misleading 401s.
- **GitHub Copilot** works differently (its API takes a device-flow login, not an API key): run `bun run copilot-login` once, and every stack start fetches your live Copilot catalog and emits a `github_copilot/<model>` route per model.
- **`LITELLM_WILDCARD_ALL=1`** adds a bare `*` passthrough for anything else LiteLLM can infer.
- **The docker test suite** always generates without these routes, so local keys never change test results.

### Useful commands

```bash
bun run test:docker    # run the docker test suites against the stack (starts and stops it)
bun run docker:logs    # follow container logs
bun run docker:down    # stop the stack and remove volumes
bun run generate-config  # print the generated LiteLLM config to stdout (never writes; startup writes the real file)
bun run copilot-login    # one-time GitHub device flow; stack starts then emit github_copilot/<model> routes
```

### Docker and Podman notes

- The stack also works with Podman: the scripts try `docker compose` first, then `podman compose`, and `COMPOSE_CMD` overrides the choice. The compose provider must support `up --wait`; Podman with the docker-compose provider does, while older `podman-compose` releases may not.
- On SELinux hosts, change the bind mounts in `docker/docker-compose.yml` from `:ro` to `:ro,z`.
- Always start the stack through `bun run docker:up` (or `dev` / `test:docker`): those paths generate `docker/.generated/litellm-config.yaml` first. Invoking `docker compose up` directly is unsupported - without the generation step the read-only directory mount materializes empty and the litellm container exits on a missing config.

## Host-fidelity suite against a live server

The host-fidelity suite runs against a built-in capture server as part of `bun run test`; to point it at the stack (or any live server) instead, opt in with `LITELLM_REAL_LIVE=1` and set its connection variables:

```bash
bun run compile && bun run bundle:dev && \
  LITELLM_REAL_LIVE=1 LITELLM_REAL_BASE_URL=http://localhost:4000 LITELLM_REAL_API_KEY=sk-test-1234 LITELLM_REAL_MODEL=gpt-5.2-mini \
  bunx vscode-test --config .vscode-test.mjs --label host-fidelity
```

On Windows PowerShell:

```powershell
bun run compile; bun run bundle:dev
$env:LITELLM_REAL_LIVE = "1"; $env:LITELLM_REAL_BASE_URL = "http://localhost:4000"
$env:LITELLM_REAL_API_KEY = "sk-test-1234"; $env:LITELLM_REAL_MODEL = "gpt-5.2-mini"
bunx vscode-test --config .vscode-test.mjs --label host-fidelity
```

Without `LITELLM_REAL_LIVE=1` the other `LITELLM_REAL_*` variables are ignored, so exporting them in your shell never turns a regular test run live.
