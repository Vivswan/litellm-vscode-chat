# Getting started

English | [简体中文](zh-cn/getting-started.md) | [繁體中文](zh-tw/getting-started.md)

Install the extension, point it at a LiteLLM proxy, and its models show up in GitHub Copilot Chat's model picker. This page walks that path once, end to end, then hands you a set of short recipes for the most common next steps.

## Requirements

- **VS Code 1.129.0 or higher**, with the GitHub Copilot Chat extension installed and signed in. This extension plugs into Copilot's chat view, so without it there is no chat interface and no model picker. If your Copilot seat comes from an organization (Copilot Business or Enterprise), the organization must also enable GitHub's "Bring your own language model key" policy - without it, Copilot hides models from provider extensions like this one even when every diagnostic reports connected.
- **A running LiteLLM proxy**, self-hosted or cloud. A LiteLLM proxy is one server that exposes many LLM providers behind a single OpenAI-compatible endpoint; if you do not have one, LiteLLM's own [proxy quickstart](https://docs.litellm.ai/docs/proxy/quick_start) gets a local one running in a few commands.
- **A LiteLLM API key**, if your proxy requires one: usually an `sk-...` value, either the proxy's master key from its config or a [virtual key](servers.md#authentication) issued by whoever runs the proxy.
  - If your company runs the server, ask its administrator.
  - Not sure whether yours needs one? The dashboard's Test connection reports an authentication error when it does.

The repository also ships a scriptable local proxy for trying things out; see [Development](development.md).

## Install and add a server

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat).
2. Run "LiteLLM: Open Dashboard" from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and click **Add server**.
3. Fill in the form:
   - **Label** - the name the model picker will show, e.g. `prod`.
   - **Base URL** - the server's root URL, e.g. `http://localhost:4000`. The extension appends `/v1` unless the URL already ends in a version segment (like `/v1` or `/v2`), which is used as-is.
   - **Auth** - exactly one form: an API key (the common case), OAuth client credentials, or a key in a custom header. For a key, the form's "Store in:" choice defaults to "secret storage", which puts it in VS Code [secret storage](servers.md#secrets-and-secret-storage) instead of your settings file - the right choice for anything you would not commit; "settings (visible)" writes it into settings.json.
4. Click **Test connection**. It probes the draft exactly as entered and answers with the model count or the exact error, before anything is saved.
5. Click **Save**.

The form writes the `litellm-vscode-chat.servers` setting, so the same server in settings.json is one entry:

```jsonc
"litellm-vscode-chat.servers": [
  {
    "label": "prod",
    "baseUrl": "http://localhost:4000",
    "auth": { "apiKey": "sk-..." }   // or omit and keep the key in secret storage
  }
]
```

Both routes are equivalent - edit whichever you prefer, the dashboard and the setting stay in step. Every entry field, the other auth forms, and where secrets can live are on the [Servers](servers.md#entry-reference) page.

The extension also ships a walkthrough covering these steps: run "Welcome: Open Walkthrough..." from the Command Palette and pick "Get started with LiteLLM for Copilot Chat".

> Servers can also be added through VS Code's own model management ("Manage Models..." in the model picker). Those work, but exist outside the `servers` setting - the dashboard marks them "external" until you [adopt them](servers.md#external-servers-and-adoption). Starting from the dashboard skips that detour.

## First chat

Within moments of saving, the server's models are registered:

1. Open VS Code's chat interface: `Ctrl+Alt+I` / `Cmd+Ctrl+I`, or the chat icon in the title bar.
2. Open the model picker and choose a model under your server's label - Copilot stays on its default model until you pick one.
3. Send a message.

The LiteLLM status bar item (bottom right) shows the connection state at a glance - a check mark (`$(check) LiteLLM`) means every server is reachable, and its tooltip carries the model count. If models do not appear or something shows red, [Troubleshooting](troubleshooting.md#common-issues) resolves the common cases.

## Where to next

The recipes, in the order people usually need them. Each shows the whole fix; the linked page has the depth.

### Correct a capability the server reports wrong

Your gateway says a model has an 8k context window, but you know it takes 131072 tokens? Capabilities come from the server, and anything you set in `models.capabilities` overrides them:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "deepseek-r1": { "context_length": 131072, "supports_reasoning": true }
}
```

The key is exact: it matches only the model ID `deepseek-r1`, nothing else. Vision, tool calling, and token limits work the same way. Details: [Models: capabilities](models.md#capabilities).

### Tune request parameters for a model family

Parameters you set are sent with every request to the matching models - and only parameters you set; the extension injects no defaults of its own:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "*":       { "temperature": 0.7 },   // every model
  "gpt-5*":  { "temperature": 0.3 }    // the gpt-5 family runs cooler
}
```

A trailing `*` makes a key a family matcher. By default the most specific matching record wins wholesale - so `gpt-5-turbo` gets 0.3, `claude-4` gets 0.7; a broader record's fields reach a more specific match only when marked `_inheritable` (or pulled in explicitly with `_inherit_from`). Details: [Models: parameters](models.md#parameters) and [model matching](models.md#model-matching).

### Connect a gateway that cannot list its models

Some gateways serve chat but no `/v1/models`. Declare the models on the entry, and tell discovery not to treat the missing endpoints as an outage:

```jsonc
{
  "label": "gateway",
  "baseUrl": "https://gateway.internal",
  "auth": { "apiKey": "sk-..." },
  "discovery": {
    "expectedFailures": ["modelListing", "modelInfo"],
    "declared": ["gpt-5", "claude-4-sonnet"]
  }
}
```

The declared models register as if discovery had found them, and the server stays green. Details: [Servers: declared models](servers.md#declared-models).

### Set a budget and get warned before it runs out

Give the entry a budget in the server's billing currency; alerts and the status bar do the rest:

```jsonc
{ "label": "prod", "baseUrl": "https://litellm.example.com", "budget": 50 }
```

With the default `usage.alertThresholds` of `[0.8, 0.95]`, you get one notification at 80% of $50 and another at 95%, and the usage status bar item shows the spend percentage - plain while you are under, on a warning background past 80%, on an error background past 95%. If your key already carries a LiteLLM `max_budget`, that works without any entry field at all. One requirement: spend tracking needs a LiteLLM server backed by a database ([requirements](usage.md#requirements)); on a proxy without one, the usage surfaces stay hidden and the `budget` field changes nothing. Details: [Usage: budgets](usage.md#budgets) and [alerts](usage.md#alerts).

### Use your proxy's own MCP tools in chat

If your LiteLLM server serves tools over the Model Context Protocol, one field on the entry makes them available in chat:

```jsonc
{ "label": "prod", "baseUrl": "https://litellm.example.com", "auth": { "apiKey": "sk-..." }, "mcp": true }
```

`true` uses the server's own endpoint at `<baseUrl>/mcp`; write `"mcp": { "url": "..." }` when it lives somewhere else. The tools appear in chat's tool picker under the entry's label, and the extension attaches this entry's credentials - the same key, virtual key, or OAuth token your chats use - at the moment the editor starts a session, never before. Details: [Servers: MCP tools](servers.md#mcp-tools).

### See why a value is what it is

When several matcher keys, a server entry, and the picker all have opinions, guessing is the slow way. Open the dashboard's Models section and Inspect a model: the panel lists every effective parameter and capability with the exact source that set it - which matcher key, which server entry, the server's own report, or the OpenRouter catalog. Details: [Models: the inspectors](models.md#inspectors).

### Generate commit messages with your own model

Two settings turn it on - the opt-in and an explicit model choice (the label of a `servers` entry plus one of its raw model IDs):

```jsonc
"litellm-vscode-chat.commitGeneration.enabled": true,
"litellm-vscode-chat.commitGeneration.model": { "server": "local", "model": "gpt-4o-mini" }
```

A sparkle button appears in the Source Control title bar, and "LiteLLM: Generate Commit Message" appears in the palette. Either one sends your staged diff - or the working-tree diff plus untracked file names when nothing is staged - to that model and writes the drafted message into the commit box. Your last five commit subjects ride along as style examples, so the draft follows your repository's conventions. The request is bounded: the diff is truncated at 80,000 characters, and at most 100 untracked paths are listed, with a count standing in for the rest.

This differs from pointing Copilot's own `chat.utilitySmallModel` slot at a LiteLLM model ([Copilot model slots](models.md#copilot-model-slots)): it needs no Copilot subscription, the instruction text is yours to change, and the style examples come from your repository's history. The built-in instruction, replaced wholesale by anything you put in `litellm-vscode-chat.commitGeneration.prompt`:

```text
Write a commit message for the change in the diff below.
Use the Conventional Commits form: one subject line like "type(scope): summary" (types such as feat, fix, docs, refactor, test, chore), at most about 72 characters, in the imperative mood.
When the change needs explanation, add a blank line and a short body of one to three sentences saying what changed and why.
Answer with the commit message text only: no markdown fences, no surrounding quotes, no commentary.
```

Privacy and cost work like chat: the diff, untracked file names, and your last five commit subjects go only to the LiteLLM server you configured, on your explicit invocation, and the request counts toward the same [usage tracking and budget alerts](usage.md) as everything else. The dashboard's explicit "Test model" button is the one exception to the opt-in: it sends a single canned sample diff with canned style subjects on your click, enabled or not, never your repository.

### Generate pull request descriptions with your own model

The same two settings as the recipe above, under a different key:

```jsonc
"litellm-vscode-chat.prGeneration.enabled": true,
"litellm-vscode-chat.prGeneration.model": { "server": "local", "model": "gpt-4o-mini" }
```

Off, the command stays hidden and no request is ever made; the dashboard's explicit "Test model" button is the one exception, sending a single canned sample branch on your click, enabled or not. On, "LiteLLM: Generate Pull Request Description" appears in the palette. It works out which branch yours would be merged into, compares the two from their merge base, and sends the branch's commit messages plus one patch per changed file to that model; the drafted title and description land on your clipboard.

The request is bounded: at most 20 commit messages and 100 changed files, with the joined patches truncated at 120,000 characters. Merge commits are left out, and uncommitted changes to tracked files are included, because they are part of what the description will cover (untracked files are not: git does not diff them). An over-long commit list is thinned from the middle, so the first and last commits always ride, and the character budget goes needs-first: short messages take only what they need and their surplus goes to the long ones, so no end of the list is cut off to pay for the other.

If the GitHub Pull Requests extension is installed, the feature also registers itself there as "Generate with LiteLLM", so the generate button in its Create Pull Request view fills the title and description in place, with no clipboard step.

That extension hands the request to the first generator registered with it, so when Copilot's own generator is installed too, which one answers is that extension's choice rather than ours; the palette command always uses your LiteLLM model. On that path the extension assembles the context, and it sends more than the palette command does: your repository's pull request template and the title and body of every issue your commits reference, private ones included.

Four repository states are advice rather than failures: no checked-out branch, a branch VS Code cannot name a base for (set its upstream, or push it), a branch level with its base, and a branch whose base resolves to its own upstream (check out the feature branch you meant).

Privacy works like the commit recipe: the branch name, its commit messages, and the patches go only to the LiteLLM server you configured, on your explicit invocation, and the request counts toward the same [usage tracking and budget alerts](usage.md) as everything else. Cancelling the progress notification stops the walk before anything is sent.

### Get inline completions from a LiteLLM model

Ghost text in the editor, written by a model on your own proxy. Two settings turn it on - the opt-in and an explicit model choice, the same `{ "server", "model" }` shape as the recipe above:

```jsonc
"litellm-vscode-chat.inlineCompletions.enabled": true,
"litellm-vscode-chat.inlineCompletions.model": { "server": "local", "model": "qwen2.5-coder-fim" },
"litellm-vscode-chat.inlineCompletions.languageFilter": { "mode": "block", "languages": ["markdown", "plaintext"] }
```

There is no command to run: the feature is settings-driven end to end. Off, nothing registers and no automatic request is ever made (the dashboard's explicit "Test model" button is the one exception - it sends a single probe on your click, enabled or not); on but without a model, it stays idle.

**Pick a completions model, not a chat model.** Inline completions POST to `/v1/completions`, so the model has to be one your LiteLLM server declares with `mode: completion` in its `model_info` - a fill-in-the-middle (FIM) model. Those models deliberately stay out of the chat model picker, so take the ID from your proxy's config rather than from the picker.

One more setting decides where it runs. `inlineCompletions.languageFilter` holds a mode plus exact VS Code language IDs: `"block"` runs completions everywhere except the listed languages, `"allow"` only in the listed ones (an empty allow list runs nowhere). You do not have to edit it by hand: while the feature is enabled, a "LiteLLM inline suggestions" row appears in the editor's `{}` language status menu (bottom right), and its toggle writes the current language into the filter for you.

The request shape is fixed rather than tunable: at most 8000 characters of the text before your cursor (truncated from the left) and 4000 characters after it, a 200 ms pause in typing before anything is sent, `max_tokens` 256, and a 15 second timeout. A small in-memory cache keeps an unchanged context from being asked twice. Failures are silent by design - a timeout, a 401 or a malformed response means no suggestion appears, never a popup interrupting your typing.

One rule worth knowing before you reach for a matcher key: `models.parameters` records do not apply to inline completion or commit-generation requests. The one exception is the `_fim_template` directive, which shapes the FIM prompt and is never sent. Use it for a raw backend that has no native fill-in-the-middle handling and wants both halves inlined into a single prompt:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "qwen2.5-coder-fim": { "_fim_template": "<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>" }
}
```

When the template applies, the prompt is built from it and the wire `suffix` field is omitted; a value missing its `{prefix}` or `{suffix}` placeholder falls back to the plain prompt-and-suffix body. Reference: [Settings: record directives](settings.md#record-directives).

Privacy is the part to read twice: inline completions send the file content around your cursor to the configured LiteLLM server automatically as you type. It is the same trust boundary as chat - your own server, no third party - but without a per-request action from you, which is why the feature ships off and takes an explicit model. The requests go over the same server connection as everything else, so they are covered by the existing [usage and spend tracking and budget alerts](usage.md).

### Chat with @litellm

Type `@litellm` in the chat view and ask. Unlike the recipes above this one is already on - it ships enabled and costs nothing until you invoke it - so the only setting is the one that turns it off:

```jsonc
"litellm-vscode-chat.chatParticipant.enabled": false
```

It answers with **whichever model the chat model picker has selected**, and that is the whole model policy: there is no separate model setting to fill in, and pointing the picker at one of your LiteLLM models is what makes the answer come from your own proxy. Every turn is an ordinary chat request, so it goes exactly where that model goes and nowhere else - pick one of your LiteLLM models and it is your own server, covered by the same [usage tracking and budget alerts](usage.md) as any other chat turn; leave a built-in Copilot model selected and the turn goes to Copilot, as that model always does. Either way this adds no path off your machine that chat did not already have.

Five slash commands come with it. `/tests`, `/docs`, `/fix` and `/explain` put a fixed instruction in front of your text and send it to the model - the last two are what the [quick fixes](#fix-or-explain-a-diagnostic) send for you, and they work just as well typed by hand. `/models` is the odd one out: it answers from what the extension already knows, listing every connected server with its models, their context windows, and their tool and image support, without touching the network - which is the quick way to get the exact raw model ID to paste into a `servers` entry or a feature's model setting.

Whatever you attach comes with it: the editor selection, the file you have open, and every `#file:` you add are read and sent below your text, so "write tests for this" means the code in front of you. Attachments are capped at 40,000 characters in total, and anything cut or left out is labeled as such rather than passed off as whole.

Asking with an empty prompt lists the commands instead of sending an empty request - an open file alone is not a question. Earlier turns ride along as context up to 80,000 characters, with the oldest messages dropping off first, so a long thread stays bounded and no single message is ever cut mid-sentence.

### Let an agent ask a second model

Copilot's agent mode works through tools, and this one hands the agent a second opinion: a model on your own proxy that it can put a question to mid-task. Useful when you want a different model to sanity-check a plan, a diagnosis, or an argument you are not sure about. Two settings turn it on, the same shape as the recipes above:

```jsonc
"litellm-vscode-chat.consultTool.enabled": true,
"litellm-vscode-chat.consultTool.model": { "server": "local", "model": "gpt-4o-mini" }
```

Both halves are required. With the switch on but no model picked, nothing registers and agents never see the tool at all. Once both are set, "Consult a LiteLLM model" joins the tool list in agent mode, and you can also aim a single prompt at it with `#litellmConsult`.

**The agent decides when to call it**, which is the part to weigh before enabling. That is what makes it a tool rather than a command: once it is on, the agent may consult on its own initiative, sending whatever question and background it judges the other model needs. The tool itself is read-only - it asks a model and hands the answer back as text, and cannot read files, run commands, or change anything - but the text it sends is the agent's choice, not yours.

Nothing is attached automatically. The consulted model gets only what the agent writes into the call - the question and an optional `context` - never your chat history, your open files, or your workspace as such. Read that precisely: the agent is *told* to put the relevant code, errors, and background into `context`, so material it has read from your workspace can end up there. What reaches the other model is whatever the agent chose to type, and nothing else.

The outgoing prompt is capped at 60,000 characters, a fixed limit like the commit recipe's diff cap; past it the context is trimmed first, with a marker so the consulted model knows material was cut, and the question is only shortened once the context is gone. Coming back, the reply is fitted to whatever token budget the calling model advertised, again with a marker. The request runs under the same `chat.timeout` setting as chat and sends no `max_tokens`, so the consulted model's own default bounds the answer.

Privacy is the same trust boundary as chat - your own server, no third party - but, like inline completions, without a per-request action from you, and with the agent rather than you choosing what to send, which is why this ships off and takes an explicit model. The question and context the agent writes go to the LiteLLM server you named for the tool, and the requests count toward the same [usage and spend tracking and budget alerts](usage.md) as everything else. The dashboard's "Test model" button is the one exception: it sends a single fixed question on your click, never anything of yours.

### Get review comments on your code

A model reads your code and leaves comments on the lines they are about, in the same threaded UI a pull request review uses. Two settings turn it on - the opt-in and an explicit model choice, the same `{ "server", "model" }` shape as the recipes above:

```jsonc
"litellm-vscode-chat.reviewComments.enabled": true,
"litellm-vscode-chat.reviewComments.model": { "server": "local", "model": "gpt-4o-mini" }
```

Two commands then decide what gets read, and you pick per invocation:

- **LiteLLM: Review Changes** reviews everything uncommitted in a repository - staged and unstaged together, one request per file. A sparkle button in the Source Control title bar runs it too. Untracked files are not included: git has no diff for them, so review them with the other command.
- **LiteLLM: Review This File** reviews the file you are looking at, whole, whether or not git knows about it.

Both are cancellable while they run, and both are bounded: a changes review sends at most 20 files (the notice says how many it left out), and each request carries at most 80,000 characters of diff or file content.

The comments arrive as threads anchored to line ranges, and a thread is a conversation rather than a verdict:

- **Reply** in the thread and the model answers there, with the anchored lines quoted back to it - so "no, `values.length` is the count" gets a real answer instead of the same comment again.
- **Resolve** the ones you have dealt with, **Unresolve** if you change your mind, **Delete Review Thread** for the ones you disagree with.
- Reviewing a file again replaces that file's model-written comments, so a second pass never stacks duplicates, and a file that now reads clean loses them. Threads you have replied in, and ones you started yourself, are kept - those are your words, not the review's.
- You can also start your own thread anywhere in a file from the gutter and ask about those lines directly.

Threads are saved per workspace and come back when you reopen it, including for files you have not opened. They come back on the lines they were written for: the editor keeps a thread beside its code while the file is open, but a comment restored into a file that was edited in between can sit a few lines off - re-running the review is the fix. Turning the feature off takes the comments off the screen without erasing them; turning it back on brings them back. Threads whose file no longer exists are dropped in the background.

Three things the review will not do quietly. A file with unsaved changes is left out of a changes review - the diff comes from what is on disk, so its comments would land on lines the model never saw - and the notice tells you to save it and review the file on its own. If a file changes while its review is in flight, its findings are dropped for the same reason, and again the notice says so. And if the model answers with something that is not a review at all, that file keeps the comments it already had instead of being cleared as though it came back clean.

Privacy: the diff of each reviewed file - or the whole file's content, in file mode - goes to the LiteLLM server you configured for it, on your explicit invocation, along with the file's path relative to the workspace or repository - just the file name when it belongs to neither, so no absolute path goes out - and, in file mode, its language identifier. Replies send the thread's conversation plus the lines it is anchored to.

Nothing is reviewed automatically; the dashboard's "Test model" button is the one request you can make without a review, and it sends a small fixed sample diff, never your files. The requests count toward the same [usage tracking and budget alerts](usage.md) as everything else.

### Fix or explain a diagnostic

Turn the quick fixes on, and pick the model that answers when the chat view cannot be opened:

```jsonc
"litellm-vscode-chat.quickFix.enabled": true,
"litellm-vscode-chat.quickFix.model": { "server": "Team proxy", "model": "gpt-4o-mini" }
```

Now any squiggle - a compiler error, a linter warning, anything an extension reports - carries two extra lightbulb entries: **Fix with LiteLLM** and **Explain with LiteLLM**. Picking one opens the chat view and **sends** `@litellm /fix` (or `/explain`) with the diagnostic messages behind it and the offending lines attached, so the answer comes from **whichever model the chat picker has selected** - one of yours if you selected one, a built-in Copilot model otherwise - and lands in a conversation you can keep asking questions in. Nothing is sent while you are only reading the lightbulb; the request happens when you pick an action.

The lightbulb appears on saved files. An unsaved buffer's code cannot be attached to a chat turn, and asking a model to fix diagnostics it cannot see is worse than not offering, so save the file first.

An action claims at most five diagnostics at that position, worst first (errors before warnings), and attaches the lines they sit on plus two lines either side.

The `quickFix.model` setting is the fallback, not the main path: it is used only when the chat view cannot answer - no chat extension installed, one that is disabled or failing, or the `@litellm` participant itself turned off or refused registration.

Then the same question - Fix asks for corrected code, Explain asks for an explanation, exactly as on the chat path - goes to that model as a single request, and the answer opens as a new untitled markdown editor you can read and close; nothing is ever written into your file. Leaving the model unset is fine if you have chat - you simply get a message instead of an answer on the rare occasions the fallback would have run. The dashboard's "Test model" button on that row sends one small fixed snippet, never your code.

Privacy: both paths send the diagnostic messages and the attached lines off your machine - on the chat path to whichever model the picker names (a built-in Copilot model unless you selected one of yours), with the conversation's earlier turns riding along as any chat turn's do; on the fallback path to the server behind `quickFix.model`.

## Commands

Everything the extension can do on demand is a Command Palette command (`Ctrl+Shift+P` / `Cmd+Shift+P`, then type "LiteLLM"):

| Command | What it does |
|---------|--------------|
| Manage LiteLLM Provider | The hub menu: manage servers and models, open the dashboard, run diagnostics |
| LiteLLM: Open Dashboard | The [dashboard](dashboard.md) panel: servers, models, usage, and settings in one place |
| LiteLLM: Test Connection | Connects to each server and reports the model count or the exact error |
| LiteLLM: Sync Models Now | Refreshes the model lists immediately, bypassing the discovery cache |
| LiteLLM: Show Diagnostics | Opens the dashboard's Diagnostics section: per-server connection state, model counts, errors, and the last check time |
| LiteLLM: Set Server Secret | Stores a server's API key, OAuth client secret, or virtual key in [secret storage](servers.md#secrets-and-secret-storage) |
| LiteLLM: Refresh Usage Now | Fetches spend and budget data immediately, regardless of the polling interval |
| LiteLLM: Refresh OpenRouter Catalog | Refreshes the capability catalog on demand ([Models](models.md#capabilities)) |
| LiteLLM: Export Settings... | Saves the extension's settings to a JSON file, with an explicit choice to include or exclude stored secrets |
| LiteLLM: Import Settings... | Merges a previously exported settings file, with a prompt per colliding server |
| LiteLLM: Undo Last Settings Import | Restores settings and secrets to their state before the last import |
| LiteLLM: Generate Commit Message | Drafts a commit message from your staged changes into the Source Control input (opt-in; see the [recipe](#generate-commit-messages-with-your-own-model)) |
| LiteLLM: Generate Pull Request Description | Drafts a pull request title and description from your branch onto the clipboard (opt-in; see the [recipe](#generate-pull-request-descriptions-with-your-own-model)) |
| LiteLLM: Review Changes | Reviews every uncommitted change in a repository and leaves comments on the lines (opt-in; see the [recipe](#get-review-comments-on-your-code)) |
| LiteLLM: Review This File | Reviews the file you are looking at, whole, and leaves comments on the lines (same opt-in) |
| LiteLLM: Report Issue | Opens a prefilled GitHub issue; see [what it collects](troubleshooting.md#reporting-an-issue) |
| LiteLLM: Help & Feedback | Shortcuts to the documentation, bug reports, and feature requests |
