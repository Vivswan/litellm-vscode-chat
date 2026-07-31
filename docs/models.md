# Models and capabilities

The extension reads each server's model info and registers what it finds with Copilot Chat: the model's token limits, pricing, and capability flags all come from there. Capabilities decide what a model is offered for (tools, images, reasoning); they never change what the extension asks a model to do, which is [Model parameters](model-parameters.md)' job.

## What registers

Discovery reads the server's `/v1/model/info` endpoint, falling back to the plainer `/v1/models` listing when that call fails, returns no data array, or returns entries none of which are usable (a well-formed empty list registers zero models without falling back).

Every chat-capable model a reachable server reports appears in the picker. Three exclusions apply:

- Models whose `model_info.mode` names a non-chat endpoint (`embedding`, `image_generation`, `audio_speech`, `audio_transcription`, `rerank`, `moderation`) are left out on purpose, since a chat request to them can only fail. Models with no declared mode always register.
- Deployments the proxy has paused (`model_info.blocked`) are skipped.
- Nothing else is filtered: a model with no capability data at all still registers, with the fallback token limits from [Settings](settings.md#token-limits).

When one model name is served by several deployments (a load-balanced pool), it registers once, with the strictest contributor's token limits, so a request can never exceed whichever deployment serves it.

### Provider routes and aggregates

A model reported with a `providers` array of routes behind it registers differently. Either endpoint can carry such entries; a stock LiteLLM proxy usually does not, and a proxy that load-balances several deployments of one model name does not produce this either (those deployments merge into the single entry above).

- When at least one route supports tools (a single route is enough), each tool-capable route registers its own picker entry (named `via <provider>`), plus `(cheapest)` and `(fastest)` aggregates that let LiteLLM pick the route per request; no unsuffixed base entry registers in that case.
- When no route supports tools, a single base entry registers instead, without the aggregates.
- The aggregates advertise the strictest tool-capable route's token limits.

The picker's and the dashboard's Family column comes from the same data: entries show the provider name the server declares (model info's `litellm_provider`, or a provider route's name) and fall back to `litellm` when it declares none; the `(cheapest)` and `(fastest)` aggregates always show `litellm`.

## Capabilities

| Capability | Read from model info | What it controls |
|------------|----------------------|------------------|
| Tool calling | `supports_function_calling` (or `supports_tool_choice`); provider routes carry `supports_tools` | Whether Copilot can send tool-using requests (agent mode); on when undeclared, off only on an explicit `false` |
| Vision | `supports_vision` | Whether image attachments are sent (see below) |
| Audio input | `supports_audio_input` | Whether audio attachments are sent |
| Reasoning | `supports_reasoning`, or `reasoning_effort` among `supported_openai_params` (an explicit `supports_reasoning: false` wins) | The Thinking Effort control in the picker; see [Model parameters](model-parameters.md#reasoning-effort-in-the-model-picker) |
| Prompt caching | `supports_prompt_caching` | Whether cache breakpoints are placed; see [Settings](settings.md#prompt-caching) |

A wrong flag on the server side is worth fixing there: the extension trusts the declaration in both directions, offering what is declared and withholding what is not.

## Multimodal input

What an attachment becomes on the wire depends on its type and the model's declared capabilities:

| Attachment | Capability gate | On other models |
|------------|-----------------|-----------------|
| Images (attachments, and images replayed from earlier turns) | Sent only to models that declare vision support | The text goes through and the images are dropped, with a note in the "LiteLLM" output channel |
| PDFs (sent as file blocks on user messages) | Not capability-gated | A model that cannot take PDFs fails with its server's own error message |
| Audio (WAV, MP3; sent as audio input blocks) | Sent only to models that declare audio input support | Dropped with an output-channel note |
| Text-decodable files (plain text, JSON, source files) | None: decoded and sent as text everywhere | - |

Tool results forward text, plus images on vision models. Binary content in assistant history has no wire shape; only its text survives replay.

## Thinking, sources, generated media, and token usage

Beyond plain text, four things can come back in (or about) a reply:

- **Thinking.** Models that stream reasoning content (thinking blocks, `reasoning_content` deltas) show it in Copilot's thinking UI as it arrives, on VS Code builds that expose the thinking-part API. On a build without it, the reasoning is dropped with a note in the output channel, and a reply consisting only of reasoning fails with an error telling you to update VS Code; see [Troubleshooting](troubleshooting.md#common-issues).
- **Sources.** Models whose LiteLLM route returns citations or search results (web-search-enabled routes) get a Sources list at the end of the reply, deduplicated by URL.
- **Generated media.** Models that generate media in chat stream it back into the reply: generated images render in place as they arrive, and generated audio arrives as one clip per utterance, with its transcript streamed as ordinary text. Media the extension cannot decode, or that the VS Code build cannot display, is dropped with an output-channel note.
- **Token usage.** Every request asks the server for token usage, and the returned counts (prompt, completion, total, plus cached and reasoning token details where the server reports them) are passed to Copilot for its usage display. Only these known numeric counts are taken from the response; the raw usage record is never forwarded or logged wholesale.

## Pricing in the picker

- Per-token costs from model info are converted to the per-million-token figures the model picker and the [dashboard](dashboard.md)'s models table display, along with cache and long-context tier costs where declared.
- A cost pair of exactly zero is treated as undeclared rather than free, because LiteLLM stamps zeros onto models with no pricing data.
- The cheapest/fastest aggregates carry no pricing at all: there the proxy's routing decides what a request actually costs.
