# Dashboard

English | [简体中文](zh-cn/dashboard.md) | [繁體中文](zh-tw/dashboard.md)

"LiteLLM: Open Dashboard" opens one panel with everything on it: servers, discovered models, usage and budgets, and the extension's settings, under a status strip showing the overall connection state. It is a view over the same stores the rest of the extension uses, so anything you do here you could equally do through VS Code settings and commands; the dashboard just puts it in one place, with validation and provenance the raw JSON cannot show.

## Layout

- A status strip on top: overall connection state, server and model counts, last sync, and a Sync models button. A quiet Report a bug action sits beside the title and opens a GitHub issue pre-filled with version, platform, and recent logs.
- Four tabs. **Servers and models** share the first, since they are one workflow: connect a server, see its models. **Usage** shows spend against budgets. **Settings** holds the extension's settings as editable form controls. **Diagnostics** is a connection summary, the configuration problems the extension has spotted, and the feedback and documentation links.
- Settings edits write to your VS Code settings (to the scope where the value is already set, otherwise to user settings), and the buttons run the same commands the Command Palette offers.
- Sections are addressable from outside: commands land on the section they concern, and notification buttons open the dashboard on Servers and models - except the budget alert's Open Usage button, which deep-links to Usage ([Deep links](#deep-links)).

## Servers

The server list shows every server the extension knows about: entries declared in the [`litellm-vscode-chat.servers` setting](servers.md#entry-reference), and "external" servers that exist only as VS Code provider groups (added outside this extension - see [adoption](servers.md#external-servers-and-adoption)). Groups hidden by a removed entry fold into a "hidden groups" line with an Unhide action ([lifecycle](servers.md#lifecycle-renames-removals-hidden-groups)).

Each row's Status pill is one of six states:

| Status | Meaning |
|--------|---------|
| Connected | Discovery succeeded |
| Error | The last check failed |
| Sync issue | The server answers, but its last settings sync reported a problem, typically the [group update limitation](servers.md#lifecycle-renames-removals-hidden-groups) |
| Expected failure | Discovery failed only in categories the entry's [`discovery.expectedFailures`](servers.md#discovery-and-expected-failures) declares, and no models are declared to serve |
| Misconfigured | The entry itself is invalid - for example more than one [auth form](servers.md#authentication) - and is not used until fixed |
| Not checked | Declared, but no discovery pass has seen it yet |

The error text behind an Error or Sync issue state renders selectable in a banner under the table; [Troubleshooting](troubleshooting.md#common-issues) covers the recovery steps. One deliberate softening: an expected discovery failure is never shown red - the row stays Connected while the entry's [declared models](servers.md#declared-models) keep serving, or shows "Expected failure" when nothing is declared.

### Notices

- **"params inactive"** (a badge on the server row, with a matching banner under the table): the entry declares per-server model parameters, but the provider group serving it does not carry the entry's labeled identity (the group predates entry labels, or a rename left a stale group), so those parameters are not being applied. Entries whose per-server capabilities, declared models, or expected failures are inactive for the same reason get the twin "capabilities inactive" badge, and inactive custom headers get their own "headers inactive" badge. The fix is the same for all three: delete the group's object from the models file (chatLanguageModels.json), reload the window, and re-sync - or re-label the entry; [Troubleshooting](troubleshooting.md#per-server-model-parameters-are-inactive) has the steps.
- **An expected discovery failure with nothing declared** gets its own banner: discovery failed only in categories the entry expects, but the entry's `discovery.declared` list is empty, so the server serves no models; the banner points at [declared models](servers.md#declared-models).
- **After adopting an external server**, a one-time notice reminds you that the original group still exists and its models appear twice until you delete its object from the models file (the notice's button opens it) and reload the window.

## The server form

Add and Edit open the same form in a side panel. It writes the `servers` setting, so edits made here and edits made in settings.json are the same thing; the form's value is that it enforces the entry's shape as you type instead of after you save.

**Identity** - `label` (the picker name) and `baseUrl`. The extension appends `/v1` unless the URL already ends in a version segment (like `/v1` or `/v2`), which is used as-is; the `apiVersion` field overrides both ([why](servers.md#entry-reference)).

**Authentication** - a selector for the auth form: none, API key, virtual key, or OAuth. The selector *is* the [exactly-one-form rule](servers.md#authentication): where raw JSON asks you to keep the rule by hand, the form makes a second form unreachable. Choosing OAuth reveals its fields plus the optional companions - an `apiKey` or `virtualKey` sent alongside the bearer token, for gateways that check two credentials at once.

**Secrets** - each secret-capable field offers a per-field choice between VS Code secret storage (the default) and an inline settings value:

- Secrets in secret storage never render back into the dashboard; for them the form shows where the value lives, not what it is.
- Inline values do prefill the edit form, masked behind a Show toggle: they already sit in plain text in your settings.json, so the form reveals nothing the Settings editor does not.
- When editing, an emptied secret field keeps the stored value; deleting one is the form's explicit "Remove the stored ..." checkbox (see [Secrets and secret storage](servers.md#secrets-and-secret-storage)).

**Per-server model configuration** - the form carries the entry's [`models` object](servers.md#per-server-model-configuration) as two sections:

- *Model parameters for this server*: a compact table, one row per [matcher](models.md#model-matching), fields as chips (`temperature: 0.2`) with a `[+]` chip to add one. Clicking a chip opens a small editor - the JSON value, a **force** toggle (a forced field beats the chat client's runtime options and the model picker's configuration, [parameters](models.md#parameters); disabled with the reason on provider-owned keys), an **inheritable** toggle, and Remove field. The pencil opens the full matcher editor.
- *Model capabilities for this server*: the same table for capability overrides. Field names are free-form (the vocabulary is open, [capabilities](models.md#capability-fields)); a name the extension does not consume gets a non-blocking possible-typo hint as you type - only when the server's observed `/model/info` key set is known, non-empty, and does not carry the name - and is applied as-is either way. Capability chips carry a **fallback** toggle - a fallback field applies *below* what the server reports instead of above it - and the `_openrouter_model` directive renders as a catalog chip whose editor is the OpenRouter catalog picker ([capabilities](models.md#capabilities)).

**Discovery** - the two controls for what discovery cannot see, side by side because they combine ([the discovery-less-gateway recipe](servers.md#discovery-and-expected-failures)):

- *Declared models* (`discovery.declared`): a plain list of exact model IDs to register even when discovery cannot list them ([declared models](servers.md#declared-models)). In older versions declaration was a "declare this model" toggle on a capabilities row; the migration moved those into this list.
- *Expected failures*: checkboxes for the endpoints this server is known not to serve (`modelListing`, `modelInfo`).

**Headers** - a row editor for the entry's `headers` object: extra HTTP headers on every request to this server (routing tags, tracing headers). The entry's own [auth](servers.md#authentication) headers win conflicts, so a custom `Authorization` cannot clobber the configured credential. Header values are settings, not secrets - they sit in plain text in settings.json; credentials belong in the auth forms, which can live in secret storage.

**Budget** - a manual USD budget that drives [usage alerts](usage.md#budgets).

**Test connection**, beside Save, probes the draft before you commit it - one discovery call with the URL and credentials as currently entered, answering "Connected - 12 models" or the exact error, and saving nothing. The probe honors the draft's expected failures and declared models, so a discovery-less gateway reports what it would serve instead of a hard failure. Failures the extension recognizes as setup problems (a wrong base URL, an unreachable proxy, a rejected key) add a link to the matching section of the [troubleshooting guide](troubleshooting.md#common-issues) under the message.

Edit on an external row is the adopt action; see [Servers](servers.md#external-servers-and-adoption).

## Models

Every model your servers report, as registered with Copilot Chat, in a sortable and filterable table with token limits, pricing, and capability notes. Where the columns come from, what each capability gates, and why a model might be missing: [Models](models.md#how-models-appear).

- Clicking a server's model count in the servers table narrows this table to that server's models; a chip beside the filter box shows the active scope and clears it.
- Each row carries a copy action (visible on hover) for the model's exact ID - the string your [matcher keys](models.md#model-matching) match against.
- Models registered by an entry's [declared list](servers.md#declared-models) rather than discovered on the server carry a "declared" badge.
- Lists are cached ([`discovery.cacheTtl`](settings.md#reference)); the Sync models button asks the servers again now.

### Effective parameters

Each row's quiet Parameters action opens a side panel answering one question: what would a request to this model actually carry?

- The table lists every configured parameter that matches the model, its value, and which layer and key set it - `Server entry "prod" - key "gpt-5*"` or `Settings - key "*"` - naming the winning [matcher](models.md#model-matching). Where a more specific match or a higher layer overrode another, the losing value shows struck through underneath, so a matcher that fires when you did not expect it is one glance away from its culprit.
- Forced fields are marked as forced: they will beat even the chat client's runtime options ([the full precedence](models.md#parameters)).
- Keys the extension refuses to forward (provider-owned fields, keys starting with `_`) render muted with the reason.
- A `max_tokens` line is always present, stating the value and where it came from: your configuration, the server's declared output limit, or the capped default.

The panel renders from the same resolution code the request path runs, so it cannot drift from real requests. Two things it honestly cannot show: runtime options the chat client sets on each request (they override any *unforced* parameter listed), and a reasoning model's Configure Model pick, which VS Code stores on its side.

### Effective capabilities

The Parameters action's twin, the quiet Capabilities action on each row, answers the other question: what does the extension believe this model can do, and why?

- Every capability field is listed with its resolved value and source - a server entry's or the global `models.capabilities` record (naming the winning matcher key), the server's own report, a fallback-marked field, an OpenRouter catalog entry (explicit `_openrouter_model`, or an implicit match by exact ID or unambiguous post-vendor suffix), the context-minus-output derivation, or the built-in default - with overridden values shown beneath the winner (the full [precedence](models.md#capabilities)).
- A line under the table states whether the output limit goes out uncapped (user-set or server-declared) or capped at 4096 (a guessed default).
- Configuration problems in the matched records - invalid values, an invalid regex matcher, an `_openrouter_model` ID the catalog does not know - are called out here, beside the rows they affect. A field name the extension does not consume gets an advisory note instead - the value applies as an override as-is, and the note appears only when the server's own `/model/info` key set is known, non-empty, and does not carry the name ([capability fields](models.md#capability-fields)).

It renders from the same resolver the registration path runs, so what it shows is what Copilot Chat was told.

## The Usage section

Spend against budget, per server, for every server whose LiteLLM instance tracks spend - servers without a database simply do not appear, and when none of your servers tracks spend the section says so instead of showing empty charts.

Each server card shows the spend-vs-budget bar and percentage, the effective and key-reported budgets when they differ, the budget's reset date, and - where the server serves daily activity data - request count, success rate, and cache hit rate. A Refresh now button fetches immediately (disabled while a fetch is in flight) and shows when the data was last updated; stale data stays visible, labeled with its age and, when known, the cause ("- last refresh failed", "- usage access denied"). When an explicit refresh fails on every server, one warning toast says so; the per-server detail stays on the cards.

Opening the dashboard always fetches fresh usage data, even when background polling is off. The depth - what the extension reads and from where, how the two budget sources interact, polling and freshness, alert thresholds, the status bar item - lives on the [Usage and budgets](usage.md) page.

## Settings

The Settings section renders the same settings the native Settings editor shows, grouped the same way (Servers, Models, Chat, Discovery, Usage, UI), as form rows with their units, defaults, and a Reset action. A configured row says where its value lives ("Modified in User settings"); Reset removes the value from that scope so the next scope's value or the default shows through.

- The object-shaped settings - [`models.parameters`](settings.md#reference) and [`models.capabilities`](settings.md#reference) - get matcher tables here, since the native settings GUI cannot edit objects. They use the same table as the [server form](#the-server-form)'s per-server sections: one row per matcher, sorted broadest first (the catch-all at the top, exact IDs at the bottom - a display order only; the stored key order never changes), fields as chips with force/fallback/inheritable badges, chip popovers for quick edits, and a pencil opening the full matcher editor. Capability field names are free-form, with the same advisory typo hint as the server form's table. Apply stays disabled until every field parses. (Custom HTTP headers are per server, not global: they live on the entry and are edited in the [server form](#the-server-form).)
- Because VS Code merges object settings across scopes, each record editor works on one scope at a time (the one your edits write to) and lists entries from other scopes read only, so applying a change never copies user-scope values into workspace files.
- The [`models.openRouterCatalog`](models.md#the-openrouter-catalog) row carries a status line - the catalog's size and when it was last updated - and a Refresh button (the same action as "LiteLLM: Refresh OpenRouter Catalog"). With the setting off, the row is inert with a hint saying so; a failed refresh reports in the status line, never as a toast.
- The trailing **Import & Export** group holds two buttons, Export settings and Import settings - the same flows as the "LiteLLM: Export Settings..." and "LiteLLM: Import Settings..." commands, for moving your setup to another machine ([details](settings.md#export-and-import)).

## Diagnostics

The Diagnostics section gathers the support surfaces; "LiteLLM: Show Diagnostics" in the Command Palette opens the dashboard straight onto it.

- A connection summary, written to be copied whole into a bug report: the same verdict the status strip shows, the configured-server count, the last check as an absolute timestamp (with a relative echo), and one outcome line per server ("OK (12 models)", the error text otherwise), plus a Test connection button. Installs carrying pre-migration servers with no row of their own also see a "Legacy registry servers" count.
- Configuration diagnostics: problems the extension found in your settings, each rendered here and beside the row it concerns ([below](#configuration-diagnostics)).
- Report a bug opens a GitHub issue pre-filled with version, platform, and recent logs - the same action as the header button.
- Request a feature, Rate this extension, Documentation, and the GitHub repository are plain links.

### Resolved models

The Diagnostics tab also renders the extension's precomputed resolution table - the exact capabilities and parameters every registered model ends up with, across all servers, before any request is made. Two views of the same data:

- **The inheritance tree**: your matcher keys drawn as a tree - each record under its next-broader match, models as leaves under their most specific match - with each node's own fields, its `_inheritable` marks, and `_inherit_from: false` barriers drawn on the branch they cut. One glance answers "why does gpt-5.6 have this temperature": follow its branch upward.

```text
*  temperature 0.7, top_p 0.9  (inheritable)
├─ gpt-5*  temperature 0.3  (inheritable)  [inheritance stops here]
│  ├─ gpt-5.6  max_tokens 8192   -> 8192 - 0.3
│  └─ gpt-5, gpt-5.7, ...        -> 0.3
├─ claude-4  temperature 1.0     -> 1.0 - top_p 0.9
└─ (everything else)             -> 0.7 - 0.9
```

- **The flat table**: one row per model with its final resolved values, each carrying a provenance chip (own, inherited from `key`, forced, fallback, server, catalog, floor), a filter box (by model ID or by matcher key - "show everything `gpt-5*` touched"), and per-row actions opening the model's [effective-values inspectors](#effective-parameters) in place, over the Diagnostics page.

One honesty note about the tree: it is drawn against the models your servers serve *right now*. A record node - a regex key especially - shows the live models it currently matches, not everything it could ever match, so the tree changes when the model list does. For the definitive answer about one model, the flat table's per-model row and the inspectors are the canonical view.

With no matcher records configured at all, the flat table still lists every model - values then come from the server, the catalog, and the built-in floor - and the tree collapses to the models under an implicit root with a hint that no records exist.

Both render the same precomputed table the request path uses, so what you see is exactly what will be sent. The view is local to the dashboard - it is never included in GitHub issue reports.

### Configuration diagnostics

Settings problems never fail silently; each one renders as a diagnostic with the offending key and the fix:

| Diagnostic | Meaning | Fix |
|---|---|---|
| Invalid regex matcher | a `/slash-wrapped/` record key does not parse as a regular expression; the key is ignored | correct the pattern ([matching](models.md#model-matching)) |
| Unforceable key | `_force` names a provider-owned field, which nothing may override; the force is ignored for that field | drop the field from the force list ([parameters](models.md#parameters)) |
| Misconfigured auth | a server entry configures more than one auth form; the entry is not used until fixed | keep exactly one form ([authentication](servers.md#authentication)) |
| Legacy scoped key | a global record key still uses the removed `"<baseUrl>/matcher"` server-scoped grammar; it can never match a model ID and sits inert | move it into that server entry's own record ([migration](models.md#migrated-from-prefix-keys)) |
| Inert global headers | the migration found values in the removed global `headers` setting but no server entry to copy them into; they are applied to nothing | add the headers to a server entry, then delete the old global setting ([migration](settings.md#renamed-and-removed-settings)) |
| Unknown `_inherit_from` key | an `_inherit_from` list names a record key that does not exist; the name is skipped and the rest of the list still applies | correct the name to an exact record key ([matching](models.md#which-record-applies)) |
| Unrecognized capability field (advisory) | a `models.capabilities` record sets a field the extension does not consume, and the server's observed `/model/info` keys do not name it; the value is applied as an override as-is | fix the spelling if it was a typo; keep it if intentional ([capability fields](models.md#capability-fields)) |

## The status bar items

The extension owns up to two status bar items; the dashboard is where their click-targets land.

- **The connection item** reads `$(check) LiteLLM` when everything is healthy, with the server and model counts in its tooltip; error and partial states change the icon and tooltip, and the tooltip's lines are written to be pasted into an issue report. Clicking it opens the dashboard. (Older versions put the model count in the item's text; it now lives in the tooltip, keeping the bar quiet.)
- **The usage item** shows the worst fresh server's spend percentage and appears only when there is something trustworthy to show; clicking it opens [the Usage section](#the-usage-section). Its full behavior - modes, thresholds, the staleness rule - is specified in [Usage and budgets](usage.md#the-status-bar).

## Deep links

Every dashboard section is addressable from outside the panel, so commands and notifications land you on the thing they are talking about rather than on a front page:

| Entry point | Opens |
|---|---|
| LiteLLM: Open Dashboard | the dashboard, on its first section |
| LiteLLM: Show Diagnostics | [Diagnostics](#diagnostics) |
| the usage status bar item | [the Usage section](#the-usage-section) |
| notification buttons that open the dashboard ("Configure Now", "Reconfigure") | [Servers and models](#servers), where connection problems are fixed |
| the budget alert's "Open Usage" button | [the Usage section](#the-usage-section) |
