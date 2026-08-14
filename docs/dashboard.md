# Dashboard

English | [简体中文](zh-cn/dashboard.md) | [繁體中文](zh-tw/dashboard.md)

"LiteLLM: Open Dashboard" opens one panel with everything on it: servers, discovered models, usage and budgets, and the extension's settings, with the overall connection state pinned to the rail beside them. It is a view over the same stores the rest of the extension uses, so anything you do here you could equally do through VS Code settings and commands; the dashboard just puts it in one place, with validation and provenance the raw JSON cannot show.

## Layout

- A rail down the left side: the destinations, each carrying the live number it is about when there is one to show (servers, models, spend against budget, open problems), and under them the fleet's overall connection state and last sync, which stay on screen while the page beside them scrolls. A Sync models button and a quiet Report a bug action sit at its foot; the latter opens a GitHub issue pre-filled with version, platform, and recent logs.
- Five destinations. **Servers** is your entries and their health, with each server's problems written under the row they belong to. **Models** is everything those servers report, and a server's model count on the Servers page navigates here scoped to it. **Usage** shows spend against budgets. **Diagnostics** is a connection summary, the configuration problems the extension has spotted, and the feedback and documentation links. **Settings** holds the extension's settings as editable form controls.
- Settings edits write to your VS Code settings (to the scope where the value is already set, otherwise to user settings), and the buttons run the same commands the Command Palette offers.
- Sections are addressable from outside: commands land on the section they concern, and notification buttons open the dashboard on Servers - except the budget alert's Open Usage button, which deep-links to Usage ([Deep links](#deep-links)).
- Narrow panes reflow instead of scrolling sideways, down to a 320px floor. Below 1000px of window the rail collapses to an icon rail, the way VS Code's own activity bar is one; every label, the fleet's verdict, and its sync time stay in the accessible names and appear as tips, and the wider rows fold onto extra lines rather than dropping facts.

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

A row's problems render directly under it, worst first. Each line leads with the consequence ("prod is serving no models: ..."), carries the server's own error text where there was any, and offers the matching actions in place - Retry, Open entry, Fix in settings.json, Declare models, Open models file, or a troubleshooting link. When any row needs action, a "N servers need attention" summary sits above the list; quiet advisory lines state facts that need none and stay out of that count. [Troubleshooting](troubleshooting.md#common-issues) covers the recovery steps. One deliberate softening: an expected discovery failure with the entry's [declared models](servers.md#declared-models) still serving is not a problem - the row stays Connected, with a quiet advisory line stating the expected failure. With nothing declared the row goes red like any other server serving no models, and its verdict reads "Expected failure".

### Notices

- **Inactive entry configuration** (a diagnostic line under the server's row): the provider group serving the entry does not carry the entry's labeled identity (the group predates entry labels, or a rename left a stale group), so some of what the entry declares is not being applied - its per-server model parameters, per-server capabilities, declared models and expected failures, custom headers, or an `apiVersion` override (requests fall back to the auto rule). One line names exactly which of those surfaces are inactive, with an Open models file action beside it. The fix is the same for all: delete the group's object from the models file (chatLanguageModels.json), reload the window, and re-sync - or re-label the entry; [Troubleshooting](troubleshooting.md#per-server-model-parameters-are-inactive) has the steps.
- **An expected discovery failure with nothing declared** is a blocking line under the row: discovery failed only in categories the entry expects, but the entry's `discovery.declared` list is empty, so the server serves no models; the line's Declare models action opens the entry ([declared models](servers.md#declared-models)).
- **After adopting an external server**, a one-time notice reminds you that the original group still exists and its models appear twice until you delete its object from the models file (the notice's button opens it) and reload the window.

## The server form

Add and Edit open the same form as a destination in the main pane, with the rail still beside it: one flat page, every part of the entry in the same scroll under an in-flow heading - Connection, Authentication, Model parameters, Model capabilities, Discovery, Headers and budget - with nothing folded away behind a disclosure. It writes the `servers` setting, so edits made here and edits made in settings.json are the same thing; the form's value is that it enforces the entry's shape as you type instead of after you save. Each field carries its hint beside it, an error takes the hint's place (so nothing shifts as you type), and the sticky bar at the bottom names the setting the entry lands in and counts what is still unsaved. Leaving - the trail back at the top, the rail, Esc, or Discard changes - is a request rather than an act: with unsaved edits it asks, and only the explicit Discard destroys the draft. Focus follows you in and back out again, to the row you opened.

**Identity** - `label` (the picker name) and `baseUrl`. The extension appends `/v1` unless the URL already ends in a version segment (like `/v1` or `/v2`), which is used as-is; the `apiVersion` field overrides both ([why](servers.md#entry-reference)).

**Authentication** - a selector for the auth form: none, API key, virtual key, or OAuth. The selector *is* the [exactly-one-form rule](servers.md#authentication): where raw JSON asks you to keep the rule by hand, the form makes a second form unreachable. Choosing OAuth reveals its fields plus the optional companions - an `apiKey` or `virtualKey` sent alongside the bearer token, for gateways that check two credentials at once.

**Secrets** - each secret-capable field offers a per-field choice between VS Code secret storage (the default) and an inline settings value:

- Secrets in secret storage never render back into the dashboard; for them the form shows where the value lives, not what it is.
- Inline values do prefill the edit form, masked behind a Show toggle: they already sit in plain text in your settings.json, so the form reveals nothing the Settings editor does not.
- When editing, an emptied secret field keeps the stored value; deleting one is the form's explicit "Remove the stored ..." checkbox (see [Secrets and secret storage](servers.md#secrets-and-secret-storage)).

**Per-server model configuration** - the form carries the entry's [`models` object](servers.md#per-server-model-configuration) as two sections:

- *Model parameters for this server*: one line per [matcher](models.md#model-matching) - the matcher key, what it matches, and its fields as quiet text (`temperature 0.2`) that turn into controls under the pointer or under focus, with a `[+]` to add one. Clicking a chip opens a small editor - the JSON value, a **force** toggle (a forced field beats the chat client's runtime options and the model picker's configuration, [parameters](models.md#parameters); disabled with the reason on provider-owned keys), an **inheritable** toggle, and Remove field. The pencil opens the full matcher editor.
- *Model capabilities for this server*: the same rows for capability overrides. Field names are free-form (the vocabulary is open, [capabilities](models.md#capability-fields)); a name the extension does not consume gets a non-blocking possible-typo hint as you type - only when the server's observed `/model/info` key set is known, non-empty, and does not carry the name - and is applied as-is either way. Capability chips carry a **fallback** toggle - a fallback field applies *below* what the server reports instead of above it - and the `_openrouter_model` directive renders as a catalog chip whose editor is the OpenRouter catalog picker ([capabilities](models.md#capabilities)).

**Discovery** - the two controls for what discovery cannot see, in one section because they combine ([the discovery-less-gateway recipe](servers.md#discovery-and-expected-failures)):

- *Declared models* (`discovery.declared`): a plain list of exact model IDs to register even when discovery cannot list them ([declared models](servers.md#declared-models)). In older versions declaration was a "declare this model" toggle on a capabilities row; the migration moved those into this list.
- *Expected failures*: checkboxes for the endpoints this server is known not to serve (`modelListing`, `modelInfo`).

**Headers** - a row editor for the entry's `headers` object: extra HTTP headers on every request to this server (routing tags, tracing headers). The entry's own [auth](servers.md#authentication) headers win conflicts, so a custom `Authorization` cannot clobber the configured credential. Header values are settings, not secrets - they sit in plain text in settings.json; credentials belong in the auth forms, which can live in secret storage.

**Budget** - a manual USD budget that drives [usage alerts](usage.md#budgets).

**Test connection**, beside the Base URL it probes, tries the draft before you commit it - one discovery call with the URL and credentials as currently entered, answering "Connected - 12 models" or the exact error, and saving nothing. The probe honors the draft's expected failures and declared models, so a discovery-less gateway reports what it would serve instead of a hard failure. Failures the extension recognizes as setup problems (a wrong base URL, an unreachable proxy, a rejected key) add a link to the matching section of the [troubleshooting guide](troubleshooting.md#common-issues) under the message.

Edit on an external row is the adopt action; see [Servers](servers.md#external-servers-and-adoption).

## Models

Every model your servers report, as registered with Copilot Chat, one two-line row each: the name and its family and server, then a quiet sentence of specs - token limits, price per million, and what the model can do. Sort and filter controls sit above the list. Where those values come from, what each capability gates, and why a model might be missing: [Models](models.md#how-models-appear).

- Clicking a server's model count on the Servers page opens this one scoped to that server; a chip beside the filter box shows the active scope and clears it.
- Each row carries a copy action (visible on hover) for the model's exact ID - the string your [matcher keys](models.md#model-matching) match against.
- Clicking a row opens its detail in place - the exact token limits, the raw model ID, every price tier including cache and long-context, and a yes or no for each capability. One row is open at a time and the page does not navigate.
- Models registered by an entry's [declared list](servers.md#declared-models) rather than discovered on the server say "declared" beside their family, and their detail explains what that means.
- Lists are cached ([`discovery.cacheTtl`](settings.md#reference)); the Sync models button asks the servers again now.

### Effective parameters

Each row's quiet Inspect action opens the model inspector, one side panel with a Parameters, a Capabilities, and a Pricing section. The Parameters section answers one question: what would a request to this model actually carry?

- The table lists every configured parameter that matches the model, its value, and one badge naming where the value came from - `entry gpt-5*` or `settings *`, the winning [matcher](models.md#model-matching). Where a more specific match or a higher layer overrode another, the losing value shows struck through underneath with its own badge, so a matcher that fires when you did not expect it is one glance away from its culprit.
- Forced fields are marked as forced: they will beat even the chat client's runtime options ([the full precedence](models.md#parameters)).
- Keys the extension refuses to forward (provider-owned fields, keys starting with `_`) render muted with the reason.
- A `max_tokens` line is always present, stating the value and where it came from: your configuration, the server's declared output limit, or the capped default.
- The model's record-matching chain closes the section in the open, one Record path line per layer, each key jumping into the editor that owns it.

The panel renders from the same resolution code the request path runs, so it cannot drift from real requests. Two things it honestly cannot show: runtime options the chat client sets on each request (they override any *unforced* parameter listed), and a reasoning model's Configure Model pick, which VS Code stores on its side.

### Effective capabilities

The inspector's Capabilities section answers the other question: what does the extension believe this model can do, and why?

- Every capability field is listed with its resolved value and a source badge - a server entry's or the global `models.capabilities` record (naming the winning matcher key), the server's own report, an OpenRouter catalog entry (explicit `_openrouter_model`, or an implicit match by exact ID or unambiguous post-vendor suffix), the context-minus-output derivation, or the built-in default - with the directive that did the work as a quiet mark beside it (`fallback`, `matched`) and overridden values shown beneath the winner (the full [precedence](models.md#capabilities)).
- An Output limit line under the table states whether the limit goes out uncapped (user-set or server-declared) or capped at 4,096 (a guessed default).
- Record problems - invalid values, an invalid regex matcher, an `_openrouter_model` ID the catalog does not know - are called out here, beside the rows they affect. A field name the extension does not consume gets an advisory note instead - the value applies as an override as-is, and the note appears only when the server's own `/model/info` key set is known, non-empty, and does not carry the name ([capability fields](models.md#capability-fields)).
- This section closes with its own Record path line, the capability records' matching chain.

It renders from the same resolver the registration path runs, so what it shows is what Copilot Chat was told.

## The Usage section

Spend against budget, per server, for every server whose LiteLLM instance tracks spend - servers without a database simply do not appear, and when none of your servers tracks spend the section says so instead of showing empty charts.

Each server is one line - label, spend against the effective budget, meter, percentage, and the fact that matters most - and opening it lists every number the extension holds: the effective and key-reported budgets when they differ, the budget's next reset date, and, where the server serves daily activity data, request count, success rate, and cache hit rate. A field the server does not report renders as a dim dash plus the reason in place, never as a zero. A Refresh now button in the section heading fetches immediately (disabled while a fetch is in flight); stale data stays visible, marked with its cause when one is known ("last refresh failed", "usage access denied"). When an explicit refresh fails on every server, one warning toast says so; the per-server detail stays on the rows.

Opening the dashboard always fetches fresh usage data, even when background polling is off. The depth - what the extension reads and from where, how the two budget sources interact, polling and freshness, alert thresholds, the status bar item - lives on the [Usage and budgets](usage.md) page.

## Settings

The Settings section renders the same settings the native Settings editor shows, grouped the same way (Servers, Models, Chat, Discovery, Usage, UI), as form rows with their units, defaults, and a Reset action. A configured row says where its value lives ("Modified in User settings"); Reset removes the value from that scope so the next scope's value or the default shows through.

- The object-shaped settings - [`models.parameters`](settings.md#reference) and [`models.capabilities`](settings.md#reference) - get matcher tables here, since the native settings GUI cannot edit objects. They use the same table as the [server form](#the-server-form)'s per-server sections: one row per matcher, sorted broadest first (the catch-all at the top, exact IDs at the bottom - a display order only; the stored key order never changes), fields as chips with force/fallback/inheritable badges, chip popovers for quick edits, and a pencil opening the full matcher editor. Capability field names are free-form, with the same advisory typo hint as the server form's table. Apply stays disabled until every field parses. (Custom HTTP headers are per server, not global: they live on the entry and are edited in the [server form](#the-server-form).)
- Because VS Code merges object settings across scopes, each record editor works on one scope at a time (the one your edits write to) and lists entries from other scopes read only, so applying a change never copies user-scope values into workspace files.
- The [`models.openRouterCatalog`](models.md#the-openrouter-catalog) row carries a status line - the catalog's size and when it was last updated - and a Refresh button (the same action as "LiteLLM: Refresh OpenRouter Catalog"). With the setting off, the row is inert with a hint saying so; a failed refresh reports in the status line, never as a toast.
- The **UI** group carries the dashboard's own appearance: a theme picker (follow the editor, or hold light or dark) and four accent swatches. Both apply the moment you pick them, and both are ordinary settings - editing [`ui.theme`](settings.md#appearance) or [`ui.accent`](settings.md#appearance) in settings.json restyles an open dashboard just the same. High contrast themes always follow the editor, whichever option is picked.
- The trailing **Import & Export** group holds two buttons, Export settings and Import settings - the same flows as the "LiteLLM: Export Settings..." and "LiteLLM: Import Settings..." commands, for moving your setup to another machine ([details](settings.md#export-and-import)).

## Diagnostics

The Diagnostics section gathers the support surfaces; "LiteLLM: Show Diagnostics" in the Command Palette opens the dashboard straight onto it.

- A connection summary, written to be copied whole into a bug report: the same verdict the rail shows, the configured-server count, the last check as an absolute timestamp (with a relative echo), and one outcome line per server ("OK (12 models)", the error text otherwise), plus a Test connection button. Installs carrying pre-migration servers with no row of their own also see a "Legacy registry servers" count.
- Configuration diagnostics: problems the extension found in your settings, each rendered here and beside the row it concerns ([below](#configuration-diagnostics)).
- Report a bug opens a GitHub issue pre-filled with version, platform, and recent logs - the same action as the rail's button.
- Request a feature, Rate this extension, Documentation, and the GitHub repository are plain links.

### Resolved models

The Diagnostics section also renders the extension's precomputed resolution table - the exact capabilities and parameters every registered model ends up with, across all servers, before any request is made. Two views of the same data:

- **The inheritance tree**: your matcher keys drawn as a tree - each record under its next-broader match, models as leaves under their most specific match - with each node's own fields, its `_inheritable` marks, and `_inherit_from: false` barriers drawn on the branch they cut. One glance answers "why does gpt-5.6 have this temperature": follow its branch upward.

```text
*  temperature 0.7, top_p 0.9  (inheritable)
├─ gpt-5*  temperature 0.3  (inheritable)  [inheritance stops here]
│  ├─ gpt-5.6  max_tokens 8192   -> 8192 - 0.3
│  └─ gpt-5, gpt-5.7, ...        -> 0.3
├─ claude-4  temperature 1.0     -> 1.0 - top_p 0.9
└─ (everything else)             -> 0.7 - 0.9
```

- **The flat table**: one row per model with its final resolved values, each carrying a provenance chip (own, inherited from `key`, forced, fallback, server, catalog, floor), a filter box (by model ID or by matcher key - "show everything `gpt-5*` touched"), and a per-row Inspect action opening the model's [inspector](#effective-parameters) in place, over the Diagnostics page.

One honesty note about the tree: it is drawn against the models your servers serve *right now*. A record node - a regex key especially - shows the live models it currently matches, not everything it could ever match, so the tree changes when the model list does. For the definitive answer about one model, the flat table's per-model row and the inspector are the canonical view.

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
| notification buttons that open the dashboard ("Configure Now", "Reconfigure") | [Servers](#servers), where connection problems are fixed |
| the budget alert's "Open Usage" button | [the Usage section](#the-usage-section) |
