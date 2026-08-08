# Models

English | [简体中文](zh-cn/models.md) | [繁體中文](zh-tw/models.md)

Everything about models in one place: how they get into the picker, how configuration keys select them, what you can override and send, and how to see exactly what the extension resolved. New here? Read top to bottom. Coming back for something specific:

- [How models appear](#how-models-appear) - discovery, declared models, what registers and what does not
- [Model matching](#model-matching) - the key grammar every model-keyed record uses, and how matching records combine
- [Capabilities](#capabilities) - what a model can do: the field vocabulary, overrides, fallbacks, the OpenRouter catalog, token limits
- [Parameters](#parameters) - what a request asks for: the pass-through contract, the `max_tokens` exception, forcing, precedence
- [The picker](#the-picker) - how models surface in Copilot Chat, and the per-model Configure menu
- [Multimodal input](#multimodal-input) and [what comes back](#thinking-sources-generated-media-and-token-usage) - attachments, thinking, sources, generated media, token usage
- [Inspectors](#inspectors) - the dashboard views that show which source produced every resolved field

Three ideas carry the whole page. **Capabilities** describe what a model *can do* - they are resolved once, at registration time, and drive what the model is offered for. **Parameters** are what a request *asks of it* - they are resolved per request and go out on the wire. A **declaration** says a model *exists* when discovery cannot see it. The three never mix: a capability is never sent as a request field, and a parameter never changes what a model is registered as.

## How models appear

### Discovery

The extension asks each configured server what it serves - on activation, when settings change, and whenever VS Code re-resolves its model providers:

- Discovery reads `/v1/model/info` first - the rich endpoint carrying token limits, pricing, and capability flags - and falls back to the plain `/v1/models` listing when that call fails, returns no data array, or returns entries none of which are usable. A well-formed empty list registers zero models without falling back.
- Discovery requests are idempotent GETs, so transient failures are retried; the whole pass - retries and any OAuth token exchange included - is bounded by `discovery.timeout` (default 30 seconds). Details on the retry rules: [Troubleshooting](troubleshooting.md#timeouts-and-retries).
- A server *expected* to fail an endpoint (a gateway with no model listing) says so in its entry's `discovery.expectedFailures`: single attempt, an info-level log line, no error noise. See [Servers](servers.md#discovery-and-expected-failures).
- Results are reused for `discovery.cacheTtl` (default 1 hour), because VS Code re-resolves providers often - sometimes several times per second. Failures are never cached, simultaneous refreshes share one request, and "LiteLLM: Sync Models Now" bypasses the cache when you need a fresh list immediately.
- When a background refresh fails but the last successful discovery is under ten minutes old, the last known models stay available, flagged stale (a warning icon with a hover note) instead of vanishing from the picker mid-session.

### Declared models

Discovery is not the only way in: a server entry's `discovery.declared` lists exact model IDs to register even when the server cannot list them, and it goes inert for any ID discovery starts listing. Declaring a model and describing it are separate steps - a declared model's [capabilities](#capabilities) resolve from the same sources as every discovered model's, and it carries a "declared" badge in the [dashboard's models table](dashboard.md#models). The full story, including the one-object recipe for a discovery-less gateway, is at [Servers - Declared models](servers.md#declared-models).

### What registers

Every chat-capable model a reachable server reports appears in the picker. Three exclusions apply:

- Models whose `model_info.mode` names a non-chat endpoint (`embedding`, `image_generation`, `audio_speech`, `audio_transcription`, `rerank`, `moderation`) are left out on purpose, since a chat request to them can only fail. Models with no declared mode always register.
- Deployments the proxy has paused (`model_info.blocked`) are skipped.
- Nothing else is filtered: a model with no capability data at all still registers, its gaps filled by the [capability sources](#capability-precedence) below.

### Load-balanced pools

When one model name is served by several deployments (a load-balanced pool), it registers once, with the strictest contributor's token limits, so a request can never exceed whichever deployment serves it. This merging matters for the [`max_tokens` exception](#the-max_tokens-exception): the merged output limit counts as declared only when every deployment declared one.

### Provider routes and aggregates

A model reported with a `providers` array of routes behind it registers differently. Either discovery endpoint can carry such entries; a stock LiteLLM proxy usually does not, and a proxy that load-balances several deployments of one model name does not produce this either (those deployments merge into the single entry above).

- When at least one route supports tools (a single route is enough), each tool-capable route registers its own picker entry (named `via <provider>`), plus `(cheapest)` and `(fastest)` aggregates that let LiteLLM pick the route per request; no unsuffixed base entry registers in that case.
- When no route supports tools, a single base entry registers instead, without the aggregates.
- The aggregates advertise the strictest tool-capable route's token limits.

## Model matching

The two model-keyed records - `models.parameters` and `models.capabilities`, global and per-entry alike - select models with the same key grammar. Keys match the model's exact ID as your server reports it, which the picker does not show; the [dashboard's models table](dashboard.md#models) has a per-row copy action for it.

**A key matches exactly unless it says otherwise:**

| Key | Matches | Notes |
|---|---|---|
| `"gpt-5"` | only the ID `gpt-5` | not `gpt-5.7`, not `gpt-5-turbo` |
| `"gpt-5*"` | every ID starting with `gpt-5` | glob; the `*` must be last |
| `"/gpt-[45].*/"` | whatever the regular expression matches | slash-wrapped, matched against the whole ID; add `i` after the closing slash for case-insensitive (`"/GPT-5.*/i"`); any other flag or an invalid pattern is reported in the dashboard and ignored |
| `"*"` | every model | your defaults live here |
| `""` | nothing | invalid; reported and ignored |

Keys are compared character for character: nothing is trimmed (a leading space is part of the key), and exact and glob keys are case-sensitive - `/re/i` is the only case-insensitive form. A few consequences for unusual IDs and imperfect records:

- An ID containing `/` (say `anthropic/claude-4`) is matched by a plain exact key - a key is regex-shaped only when it *starts* with `/`. In a key that starts with `/`, whatever follows its last `/` must be a supported flag (`i`, or nothing), so `"/anthropic/claude"` is invalid and reported; an ID that itself starts with `/` is matched by a regex with the slash in the body (`"/\\/anthropic.*/"`).
- A key ending in `*` always reads as a glob, so an ID that literally ends in `*` needs a regex with the star escaped: `"/gpt-5\\*/"`.
- A `*` anywhere but the end of a key (`"gpt*5"`) is not a glob and not a literal - the key is invalid, reported, and ignored, like an empty key or a malformed regex.
- A record key starting with `_` is a directive, never a matcher, so an ID that starts with `_` can only be matched by a regex key.
- A key that matches none of your current models is not an error: it simply never applies, and sits ready should such a model appear. Only a malformed key (invalid regex, unsupported flag, `""`) is reported - and its record then never matches anything.
- Writing the same key twice in one record is a JSON problem, not a matcher one: VS Code's editor warns about the duplicate, and only the last occurrence survives parsing - the extension never sees the first.

Keys are model matchers and nothing else - **there is no server scoping at the global level**. Configuration meant for one server lives in that server entry's own `models.parameters` / `models.capabilities` records, which use the same grammar ([Servers](servers.md#per-server-model-configuration)). For a server added through VS Code's own model management (no entry), [adopt it](servers.md#external-servers-and-adoption) first.

The native settings GUI cannot edit object settings, so the [dashboard](dashboard.md) gives both records row editors: matcher fields suggest your discovered model IDs, an Edit as JSON toggle accepts a pasted record, and edits land only when you press Apply. Editing the JSON in settings.json directly works the same.

### Which record applies

Specificity orders the matching keys: an exact key is more specific than a glob (between globs, the longer literal prefix wins), a glob than a regex (between regexes, the one later in the record wins), and everything beats `"*"`. The tiers are strict: any glob outranks any regex, however narrow the regex reads, and `"/.*/"` outranks `"*"` even though the two match the same models - it ranks as a regex. Ties barely exist: two different globs matching the same ID always differ in prefix length (equal prefixes would make them the same key), and between regexes the later-in-the-record rule decides - the same order that places the later regex nearer the model in the inheritance chain below.

**By default, the most specific matching record wins wholesale** - its fields apply, and no other record leaks in. Two directives control the flow - the giver marks fields, the receiver decides - and the receiving side always wins:

| Directive | Side | Meaning |
|---|---|---|
| `"_inheritable": true \| ["field", ...]` | giver | Mark all/listed fields inheritable: any more-specifically-matched model whose own record does not say otherwise inherits them (for fields it leaves unset; the nearest inheritable value wins per field) |
| `"_inherit_from": ["key", ...]` | receiver | Inherit from exactly the named records - all their literal fields, nearest-first - and nothing else. Naming is full intent: the named record needs no `_inheritable`, its own inheritance settings do not carry over, and barriers between it and this record are bypassed. Entries are exact record keys and must also match the model - a named record that does not match contributes nothing for that model (inheritance has sources, not includes); naming a key that does not exist is flagged in the dashboard, and the rest of the list still applies |
| `"_inherit_from": true` | receiver | Inherit everything that reaches this record - the full view of the next broader match, marked inheritable or not; barriers still apply |
| `"_inherit_from": false` | receiver | Inherit from nothing - fully self-contained. And since broader fields can only reach more specific records through this record's resolved view, nothing flows past it either: `false` is the barrier |

Inheritable fields travel along the specificity chain and must pass *through* every record between their source and the model: each record passes upward only what it accepts itself. A record with `"_inherit_from": false` therefore cuts the line - it shields itself *and* everything more specific from all broader records. The one way around a barrier is naming: an `"_inherit_from"` list reaches its records directly, barriers or not.

Worked example - the same family, configured two ways:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "*":        { "temperature": 0.7, "top_p": 0.9, "_inheritable": true },
  "gpt-5*":   { "temperature": 0.3, "_inheritable": true, "_inherit_from": false },
  "gpt-5.6":  { "max_tokens": 8192 },
  "claude*":  { "max_tokens": 4000 },
  "claude-4": { "temperature": 1.0 }
}
```

| Model | Result | Why |
|---|---|---|
| `gpt-5.6` | `max_tokens: 8192, temperature: 0.3` | silent, so it inherits what reaches it: `gpt-5*` marks `temperature` inheritable; the catch-all's `top_p` dies at `gpt-5*`'s barrier |
| `gpt-5`, `gpt-5.7`, ... | `temperature: 0.3` | best match is `gpt-5*`, which is self-contained - the catch-all's fields stop here |
| `claude-4` | `temperature: 1.0, top_p: 0.9` | own `temperature` wins; `top_p` crosses the silent `claude*` record untouched on its way from the catch-all. `claude*`'s own `max_tokens` does not follow: it was never marked inheritable |
| `claude-4.1` | `max_tokens: 4000, temperature: 0.7, top_p: 0.9` | best match is `claude*`, applied wholesale, plus the catch-all's inheritable fields it leaves unset |
| anything else | `temperature: 0.7, top_p: 0.9` | the catch-all is the best match itself |

The `claude-4` row is the pass-through rule in action: a record with no directives is transparent - inheritable fields cross it unchanged, still carrying their source's markings, while its own unmarked fields stay put.

An `"_inherit_from"` list curates the ancestry explicitly - and it is also the one way around a barrier:

```jsonc
"gpt-5.6": { "max_tokens": 8192, "_inherit_from": ["gpt-5*"] }
// -> max_tokens 8192 + temperature 0.3 (exactly the named record, nothing else)

"gpt-5.6": { "max_tokens": 8192, "_inherit_from": ["gpt-5*", "*"] }
// -> max_tokens 8192, temperature 0.3, top_p 0.9 - naming "*" reaches around the barrier
```

#### Edge cases

- `"_inherit_from": []` names no records, so it inherits nothing - the empty list behaves exactly like `false`, barrier included.
- The order of an `"_inherit_from"` list does not matter, and naming a record twice adds nothing: when two named records set the same field, the more specific one wins - "nearest-first" is specificity order, not list order.
- A record naming itself in `"_inherit_from"` is a no-op: it contributes its own literal fields, which the record already has - own fields always beat inherited ones.
- `"_inherit_from": false` on the `"*"` record changes nothing: the catch-all is the broadest match, so there is nothing broader to inherit or to block. Its `_inheritable` marking still gives as usual - `_inherit_from` only governs what a record receives.
- `"_inherit_from": true` reads the next broader match's *resolved view*: that record's own fields plus whatever it accepted from further out. If that record is itself a barrier, its view is just its own fields - `true` does not see past it.
- Only fields flow. A directive is an instruction on its own record: a broader record's [`_openrouter_model`](#the-openrouter-catalog), `_inheritable`, or `_inherit_from` never travels with inheritance. What an inherited field carries along is its source's `_inheritable`, `_fallback`, or `_force` marking - nothing more.
- Chains never cross levels: an entry record's `"_inherit_from"` names keys in that entry's own record, a global one names global keys. Each level resolves its whole chain independently, and only then does the entry result beat the global result field by field. Naming a key that exists only at the other level is the same as naming a nonexistent one: flagged in the dashboard, with the rest of the list still applying.

Two independent rules sit outside this flow: a server entry's record beats the global record field by field (each resolved with its own matching first), and a flowing field keeps its source record's [`_fallback`](#fallback-values-_fallback) or [`_force`](#forcing-parameters-_force) marking.

Resolution never happens per request: each model's flat result is computed once and cached - recomputed only when settings, entries, or the model list change - and requests only merge runtime values on top. The [inspectors](#inspectors) and the Diagnostics tab's [Resolved models view](dashboard.md#diagnostics) render that same cached table - the fastest way to debug a matcher, and exactly what will be sent.

### Migrated from prefix keys

Keys in older versions were implicit prefixes: `"gpt-5"` also matched `gpt-5.7` and `gpt-5-turbo`. The upgrade migration appends `*` to every existing key (and turns the old match-everything `""` into `"*"`), so old configs keep matching exactly what they matched before. Only keys you write from now on use the exact-by-default rule.

Older versions also allowed server-URL-scoped keys in the global records (`"https://litellm.example.com/gpt-4"`). The migration moves each one into the matching server entry's record, merged losslessly. A scoped key whose URL matches no entry is left in place - it can never match a model ID, so it is inert - and the dashboard flags it with a hint to move it into a server entry. The full rename story: [Settings](settings.md#renamed-and-removed-settings).

## Capabilities

Capabilities are registration-time facts: they decide what a model is offered for (tools, images, reasoning), its token limits, and which attachments are sent. They never change what a request asks a model to do - that is [Parameters](#parameters)' job.

Capabilities are **source-invariant**: the resolution below neither knows nor cares whether a model was discovered or [declared](#declared-models). A declared model with no server data simply resolves from the remaining sources - and [matching](#model-matching) treats its ID exactly like a discovered one, so a `"*"` record's inheritable fields or fallbacks reach declared models too.

### Capability fields

The `models.capabilities` records (global setting and [per-entry field](servers.md#per-server-model-configuration)) correct and extend what the server reports, using this closed vocabulary:

| Field | Type | What it controls |
|-------|------|------------------|
| `context_length` | number | The model's context window |
| `max_input_tokens` | number | The input budget; when nothing sets it, context length minus max output tokens |
| `max_output_tokens` | number | The output limit, and the `max_tokens` fallback ([the exception](#the-max_tokens-exception)) |
| `supports_function_calling` | boolean | Tool-using requests (agent mode) |
| `supports_vision` | boolean | Whether image attachments are sent |
| `supports_reasoning` | boolean | The Thinking Effort control in the picker |
| `supports_audio_input` | boolean | Whether audio attachments are sent |

Unlike `models.parameters`, this vocabulary is closed: an unknown field is not forwarded anywhere, it is flagged in the [capability inspector](#inspectors). Number fields take positive integers; an invalid value is flagged too, and the next-best source wins instead.

### What the server reports

Discovery reads capabilities from model info:

| Capability | Read from model info | Notes |
|------------|----------------------|-------|
| Tool calling | `supports_function_calling` (or `supports_tool_choice`); provider routes carry `supports_tools` | On when undeclared; off only on an explicit `false` |
| Vision | `supports_vision` | |
| Audio input | `supports_audio_input` | |
| Reasoning | `supports_reasoning`, or `reasoning_effort` among `supported_openai_params` | An explicit `supports_reasoning: false` wins |
| Prompt caching | `supports_prompt_caching` | Not in the override vocabulary; `chat.promptCaching` turns the feature off globally ([Settings](settings.md#prompt-caching)) |
| Token limits | model info's token limit fields | See [Token limits](#token-limits) |

A wrong flag on the server side is worth fixing there: the extension trusts the declaration in both directions, offering what is declared and withholding what is not. When the server is not yours to fix, override the flag instead.

### Overrides

A plain capability field says "the server is wrong (or silent) - use this": your value beats the server's, field by field.

```json
{
  "litellm-vscode-chat.models.capabilities": {
    "gpt-4": { "context_length": 128000, "supports_vision": true },
    "my-gateway-model": { "max_output_tokens": 32000 }
  }
}
```

A server entry can carry the same record scoped to its own models (`models.capabilities`, same [matcher grammar](#model-matching), no URL scoping needed since the entry already names its server); entry fields beat global ones per field. The dashboard's server form has a matching "for this server" section. Details: [Servers](servers.md#per-server-model-configuration).

### Fallback values: `_fallback`

An override says "the server is wrong"; a fallback says "in case the server is silent". The `_fallback` directive turns fields of a record into gap-fillers that apply *below* server-reported values:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "*": {
    "_fallback": true,             // every field in this record is a fallback
    "context_length": 131072,      // used only when the server reports none
    "max_output_tokens": 8192
  },
  "qwen*": {
    "_fallback": ["supports_vision"],  // only the listed fields fall back
    "supports_vision": true,           // fills a gap; a server "false" wins
    "context_length": 32768            // not listed: a plain override, beats the server
  }
}
```

- `_fallback: true` makes every field in the record a fallback; `_fallback: ["field", ...]` only the listed ones, leaving the rest ordinary overrides.
- A fallback `max_output_tokens` still counts as user-set for the [`max_tokens` exception](#the-max_tokens-exception): the 4096 clamp is lifted.
- An inherited field arrives with its source's marking: a fallback stays a fallback wherever [inheritance](#which-record-applies) carries it, and a receiving record cannot re-mark fields it did not write (its own `_fallback` list may only name its own fields; the same source-side rule governs [`_force`](#forcing-parameters-_force)). Want an inherited fallback as a hard override on one model? State it there: `"gpt-5.6": { "context_length": 200000 }` - an own, unlisted field is an override, and only that model stops following the source.
- A directive list may only name fields present in its own record: naming an absent field is reported as an invalid directive, that name is skipped, and the rest of the list still applies (the same rule the receiver re-marking restriction builds on). And a known directive in the wrong record type - `_fallback` in a parameters record, `_force` in a capabilities record - is reported and ignored, while truly unknown `_` keys stay silently ignored for forward compatibility.

Like every directive, the underscore key is an instruction to the extension - it is never sent anywhere.

### The OpenRouter catalog

The extension bundles a snapshot of [OpenRouter](https://openrouter.ai)'s public model catalog and fills capability fields nothing else provides from it. Two ways a model meets the catalog:

- **Explicit**: `"_openrouter_model"` names the catalog entry for models whose ID the catalog would never guess:

  ```json
  {
    "litellm-vscode-chat.models.capabilities": {
      "my-alias": { "_openrouter_model": "anthropic/claude-sonnet-4" }
    }
  }
  ```

  Fields derived this way rank *above* what the server reports - the directive says the server's data is not to be trusted for this model. Your explicit fields in the same record still win over the catalog's. An unknown catalog ID shows a warning in the [capability inspector](#inspectors) and the model falls back to the other sources; it is never an error. The dashboard's capability editor offers a search picker for the ID. And like every directive, `_openrouter_model` belongs to the record it sits in: it is never inherited - only fields flow between records - and a more specific matching record shadows it along with the rest of the record's fields, so restate the directive there if that model still needs it.

- **Implicit**: without a directive, a model whose own ID matches a catalog entry exactly (or matches the part after the `vendor/` prefix, when only one entry does) still backfills from the catalog - but only as the weakest source above the built-in defaults, so it can never displace server-reported data or your settings.

Where the data comes from, and the one network implication:

- The snapshot ships inside the VSIX and refreshes about weekly from `https://openrouter.ai/api/v1/models` - a public, unauthenticated model list. The request carries no prompts, no usage, no account data, and nothing about your servers; the refreshed copy is cached in VS Code's global storage, and a failed refresh falls back silently to the cached or bundled snapshot.
- Refresh on demand with the "LiteLLM: Refresh OpenRouter Catalog" command, or the Refresh button on the setting's dashboard row, which also shows the catalog's size and when it was last updated. A failed manual refresh reports in the row status - no popups.
- **Opting out**: set `litellm-vscode-chat.models.openRouterCatalog` to `false` to stop the periodic refresh (all catalog network) and the implicit matching; the dashboard row goes inert with a hint. Explicit `_openrouter_model` directives keep working offline from the bundled or cached snapshot - they are your stated intent and need no network.

### Capability precedence

Per field, the highest source that sets it wins. Within each record level, [the matching rules](#which-record-applies) pick among matching keys:

1. Entry `models.capabilities`
2. Global `models.capabilities`
3. Fields derived from an explicit `_openrouter_model` directive
4. What the server reports (absent for declared models)
5. `_fallback` fields (entry above global, the matching rules within each)
6. An implicit OpenRouter catalog match
7. Built-in defaults: tools on, vision/audio/reasoning off, 128000 context, 16000 max output

Two consequences worth knowing:

- A `max_output_tokens` you set yourself - levels 1, 2, or 5 - counts as user-declared and is sent as-is when it becomes the wire `max_tokens`; so does a server limit every deployment of the model declared. Any catalog-derived value (explicit directive or implicit match) and the built-in floor count as guesses and cap wire `max_tokens` at 4096 ([the exception](#the-max_tokens-exception)). To lift the cap for a catalog-backed model, write the `max_output_tokens` yourself.
- Pricing is never overridden: server-reported pricing always wins, and catalog pricing only fills in where the server reports none.

### Token limits

Three numbers bound every request, resolved through the precedence above:

- `context_length` is the model's whole window.
- `max_input_tokens` is the input budget Copilot packs prompts against; when nothing sets it, it derives as context length minus max output tokens.
- `max_output_tokens` bounds the reply, and doubles as the wire `max_tokens` when no parameter sets one ([the exception](#the-max_tokens-exception)).

For a [load-balanced pool](#load-balanced-pools), the registered limits are the strictest contributor's - and your own override still beats the merge: a `max_output_tokens` you set counts as declared even when the deployments disagree, whereas the merged server value counts as declared only when every deployment declared one.

#### Migrated from the removed default settings

Older versions had three global fallback settings: `defaultContextLength`, `defaultMaxOutputTokens`, and `defaultMaxInputTokens`. They are gone; the upgrade migration writes any values you had set into a `"*"` record:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "*": {
    "_inheritable": true,
    "_fallback": ["context_length", "max_output_tokens"],
    "context_length": 100000,      // was defaultContextLength
    "max_output_tokens": 8000,     // was defaultMaxOutputTokens
    "max_input_tokens": 90000      // was defaultMaxInputTokens - a plain override
  }
}
```

The first two ride `_fallback` because the old settings only filled gaps below the server's report. The record is also marked `_inheritable: true`, because the old defaults applied to every model no matter what else you had configured: without the marking, any model with a more specific record of its own would lose the defaults wholesale; with it, they follow every model that does not opt out - each field still a fallback wherever it lands, since [inherited fields keep their source's marking](#fallback-values-_fallback). `defaultMaxInputTokens` always outranked the server's input limit, so it migrates as a plain override - same behavior, new home. Full rename table: [Settings](settings.md#renamed-and-removed-settings).

## Parameters

Parameters are what a request asks for: `temperature`, `max_tokens`, `reasoning_effort`, anything your LiteLLM deployment and model provider accept. The extension never decides them for you.

### The pass-through contract

When you configure nothing - or nothing that matches a given model - your model provider's own defaults apply:

- The extension injects no default temperature, no allow-list, nothing.
- All non-reserved parameter keys pass through unchanged; the extension does not restrict which parameters you can set.
- Provider-owned fields cannot be overridden: `model`, `messages`, `stream`, `stream_options`, and - when tools are in play - `tools` and `tool_choice`.
- Keys starting with `_` are extension directives ([`_force`](#forcing-parameters-_force)) and are never sent.

### The `max_tokens` exception

The one field the extension fills in on its own is `max_tokens`. When neither runtime options nor any parameters record sets it, the request carries the model's resolved max output tokens:

- **as-is** when the number is declared: reported by the server (for a [pooled model](#load-balanced-pools), only when every deployment declared one), or set by you in `models.capabilities` - an override or a `_fallback` value;
- **capped at 4096** when it is a guess: a catalog value (explicit `_openrouter_model` directive or implicit match) or the built-in default.

Set `max_tokens` anywhere in the [precedence chain](#parameter-precedence) and the exception never engages: the value goes out exactly as written - the extension never edits or clamps a user-set parameter, even when it exceeds the model's resolved `max_output_tokens` (the capability keeps governing registration and the input budget, not the request). Setting `max_output_tokens` in [capabilities](#capability-fields) instead does not bypass the exception - it feeds it: the fallback fires with your number, which counts as declared, so the 4096 cap never applies.

### Where parameters come from

Four sources can set a parameter for a request, listed here from lowest to highest:

1. **The global setting** - `litellm-vscode-chat.models.parameters`, keyed by [matchers](#model-matching):

   ```json
   {
     "litellm-vscode-chat.models.parameters": {
       "gpt-5*": { "temperature": 1 },
       "claude-opus": { "max_tokens": 16000, "temperature": 0.5 }
     }
   }
   ```

   Useful for models with hard requirements (gpt-5 rejecting any `temperature` but 1) or house defaults (a `"*"` key). Common parameters: `max_tokens`, `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `stop`, `response_format`, `reasoning_effort`, `seed`.

2. **Entry parameters** - a server entry's `models.parameters`, same grammar, applied above the global record field by field; the home for server-specific values ([Servers](servers.md#per-server-model-configuration)). A request picks up an entry's parameters only when the provider group it runs through matches the entry on both label and base URL; external groups with no entry, and stale groups left behind by a label or `baseUrl` edit, get only the global setting - the dashboard flags this as a ["params inactive" notice](troubleshooting.md#per-server-model-parameters-are-inactive).

3. **Picker configuration** - the per-model [Configure menu](#per-model-configuration) in Copilot's picker (today: reasoning effort). These choices count as user-set and are forwarded like any configured parameter, except only schema-declared properties go out, mapped to their wire keys.

4. **Runtime options** - what the chat client (Copilot, or another extension calling the model) sets on the request itself.

### Forcing parameters: `_force`

Runtime options normally win - the chat client asked for something specific. The `_force` directive flips that for chosen fields, for gateways or models where your value must always win:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "gpt-5*": {
    "_force": ["temperature"],   // or true to force every field in the record
    "temperature": 1,            // wins even over Copilot's runtime options
    "top_p": 0.9                 // not listed: ordinary, runtime options still win
  }
}
```

- `_force: true` forces every field in the record; `_force: ["field", ...]` only the listed ones.
- Like [`_fallback`](#fallback-values-_fallback), the marking is source-side: a forced field stays forced wherever [inheritance](#which-record-applies) carries it, and a record's own `_force` list may only name its own fields - to force an inherited field, mark it at its source (or restate it locally and force that).
- Provider-owned fields can no more be forced than set: a `_force` naming one is reported in the dashboard and the key is ignored.
- `max_tokens` is not provider-owned and CAN be forced: a forced value beats runtime options and, being user-set, is never capped by the [`max_tokens` exception](#the-max_tokens-exception).
- Forced fields from an entry record beat forced fields from the global record.

### Parameter precedence

When several sources set the same parameter for one request, the higher one wins. Within each record level, [the matching rules](#which-record-applies) pick among matching keys:

1. Forced fields ([`_force`](#forcing-parameters-_force)) - entry above global
2. Runtime options - the chat client's own request settings
3. Picker configuration - the per-model [Configure menu](#per-model-configuration)
4. Entry `models.parameters`
5. Global `models.parameters`

Any parameter left unset by all five falls through to your model provider's defaults, with the [`max_tokens` exception](#the-max_tokens-exception) above. To see how the layers resolved for a specific model, use the [inspectors](#inspectors).

## The picker

Each server entry becomes a provider group in Copilot's model picker, named after its label, with the server's models under it. Entries show the provider name the server declares (model info's `litellm_provider`, or a provider route's name) and fall back to `litellm` when it declares none; the `(cheapest)` and `(fastest)` [aggregates](#provider-routes-and-aggregates) always show `litellm`. The [dashboard's models table](dashboard.md#models) shows the same data with the exact IDs.

### Per-model configuration

Some models offer a Configure menu in the picker - this is the "picker configuration" level of the [parameter precedence](#parameter-precedence). Today it carries one control, Thinking Effort, on models that advertise reasoning support:

1. Select the model in the picker.
2. Click the "Thinking Effort" label next to the model name in the chat input.
3. Pick a level from Off through Extra High; VS Code remembers the choice for that model.

What each choice sends:

- Every request then carries `reasoning_effort` accordingly; "Off" goes out as `reasoning_effort: "none"`, which turns thinking off on models that support that.
- "Provider default" (the initial state) sends nothing and lets your provider decide.
- The menu is the same for every reasoning model, because LiteLLM reports which models take `reasoning_effort` but not which values each one accepts. If you pick a level your model rejects (say, Extra High on a model that stops at High), the request fails with the server's own error message; pick a different level and retry.

Temperature stays free-form in `models.parameters` on purpose: the Configure menu can only render fixed choices, so the extension does not add temperature presets there.

### Pricing in the picker

- Per-token costs from model info are converted to the per-million-token figures the model picker and the [dashboard](dashboard.md)'s models table display, along with cache and long-context tier costs where declared.
- A cost pair of exactly zero is treated as undeclared rather than free, because LiteLLM stamps zeros onto models with no pricing data.
- The cheapest/fastest aggregates carry no pricing at all: there the proxy's routing decides what a request actually costs.

What requests actually cost, per server and against budgets, lives in [Usage](usage.md#the-usage-panel).

## Multimodal input

What an attachment becomes on the wire depends on its type and the model's resolved [capabilities](#capabilities):

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
- **Token usage.** Every request asks the server for token usage, and the returned counts (prompt, completion, total, plus cached and reasoning token details where the server reports them) are passed to Copilot for its usage display. Only these known numeric counts are taken from the response; the raw usage record is never forwarded or logged wholesale. Server-side spend and budgets are a separate feature: [Usage](usage.md#the-usage-panel).

## Inspectors

Every rule on this page is observable. The [dashboard](dashboard.md)'s models table gives each model two inspectors:

- **Params** ([effective parameters](dashboard.md#effective-parameters)): every parameter that would go out, its resolved value, and the source that set it - which record, which matcher key - with shadowed values shown beneath the winner, plus the `max_tokens` the request would carry and why.
- **Caps** ([effective capabilities](dashboard.md#effective-capabilities)): every capability field with its resolved value and source - an entry or global record key, an `_openrouter_model` derivation, the server's report, a `_fallback` fill, a catalog match, or the built-in default - again with the shadowed values beneath.

The inspectors also surface the diagnostics named on this page: invalid matcher keys, unknown capability fields, invalid values, unknown catalog IDs, and `_force` on unforceable keys. When a matcher does something surprising, start here - the answer is one Params or Caps click away.
