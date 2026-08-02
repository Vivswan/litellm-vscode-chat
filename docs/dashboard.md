# Dashboard

English | [简体中文](zh-cn/dashboard.md) | [繁體中文](zh-tw/dashboard.md)

"LiteLLM: Open Dashboard" opens one panel with everything on it: servers, discovered models, and the extension's settings, under a status strip showing the overall connection state. It is a view over the same stores the rest of the extension uses, so anything you do here you could equally do through VS Code settings and commands; the dashboard just puts it in one place.

## Layout

- A status strip on top: overall connection state, server and model counts, last sync, and a Sync models button. A quiet Report a bug action sits beside the title and opens a GitHub issue pre-filled with version, platform, and recent logs.
- Three tabs. Servers and models share the first, since they are one workflow: connect a server, see its models. The second holds the extension's settings as editable form controls. The third is Diagnostics: a connection summary plus the feedback and documentation links.
- Settings edits write to your VS Code settings (to the scope where the value is already set, otherwise to user settings), and the buttons run the same commands the Command Palette offers.

## Servers

The server list shows every server the extension knows about: entries declared in the `litellm-vscode-chat.servers` setting, and "external" servers that exist only as VS Code provider groups (added outside this extension).

Each row's Status pill is one of four states:

| Status | Meaning |
|--------|---------|
| Connected | Discovery succeeded |
| Error | The last check failed |
| Sync issue | The server answers, but its last settings sync reported a problem, typically the [group update limitation](servers.md#the-servers-setting) |
| Not checked | Declared, but no discovery pass has seen it yet |

The error text behind an Error or Sync issue state renders selectable in a banner under the table; [Troubleshooting](troubleshooting.md) covers the recovery steps.

The add/edit form opens in a side panel; it writes the servers setting, so edits made here and edits made in settings.json are the same thing. Test connection, beside Save, probes the draft before you commit it - one discovery call with the URL and credentials as currently entered, answering "Connected - 12 models" or the exact error, and saving nothing. Failures the extension recognizes as setup problems (a wrong base URL, an unreachable proxy, a rejected key) add a link to the matching section of the [troubleshooting guide](troubleshooting.md#common-issues) under the message. Edit on an external row adopts it into the setting; see [Servers](servers.md#external-servers-and-adoption).

For each secret field the form lets you choose between VS Code secret storage (the default) and an inline settings value:

- Secrets in secret storage never render back into the dashboard; for them the form shows where the value lives, not what it is.
- Inline values do prefill the edit form, masked behind a Show toggle: they already sit in plain text in your settings.json, so the form reveals nothing the Settings editor does not.
- When editing, an emptied secret field keeps the stored value; deleting one is the form's explicit "Remove the stored ..." checkbox (see [Secrets and secret storage](servers.md#secrets-and-secret-storage)).

### Notices

- **"params inactive"** (a badge on the server row, with a matching banner under the table): the entry declares per-server model parameters, but the provider group serving it does not carry the entry's labeled identity (the group predates entry labels, or a rename left a stale group), so those parameters are not being applied. The fix is to delete the group's object from the models file (chatLanguageModels.json), reload the window, and re-sync - or re-label the entry; [Troubleshooting](troubleshooting.md#per-server-model-parameters-are-inactive) has the steps.
- **After adopting an external server**, a one-time notice reminds you that the original group still exists and its models appear twice until you delete its object from the models file (the notice's button opens it) and reload the window.

## Models

Every model your servers report, as registered with Copilot Chat, in a sortable and filterable table with token limits, pricing, and capability notes.

- Clicking a server's model count in the servers table narrows this table to that server's models; a chip beside the filter box shows the active scope and clears it.
- Each row carries a copy action (visible on hover) for the model's exact ID, which is what a [`modelParameters` prefix](model-parameters.md#prefix-matching-and-server-scoping) matches against.
- Lists are cached ([discoveryCacheTtl](settings.md#model-list-caching)); the Sync models button asks the servers again now.

Where the table's columns come from, what each capability gates, and why a model might be missing are covered in [Models and capabilities](models.md).

### Effective parameters

Each row's quiet Params action (visible on hover) opens a side panel answering one question: what would a request to this model actually carry?

- The table lists every configured parameter that matches the model, its value, and which layer set it - `Server entry "Team A" - gpt-4` or `Settings - gpt-4`, naming the winning prefix key. Where a higher layer overrode a lower one, the losing value shows struck through underneath.
- When a server-scoped settings key wins, the whole unscoped record it replaced is listed as "Not applied" - scoped keys replace the record outright rather than merging with it (see [prefix matching](model-parameters.md#prefix-matching-and-server-scoping)).
- Keys the extension refuses to forward (provider-owned fields, keys starting with `_`) render muted with the reason.
- A `max_tokens` line is always present, stating the value and where it came from: your configuration, the server's declared output limit, or the capped default.

The panel renders from the same resolution code the request path runs, so it cannot drift from real requests. Two things it honestly cannot show: runtime options the chat client sets on each request (they override any forwarded parameter listed), and a reasoning model's Configure Model pick, which VS Code stores on its side.

## Settings

The Settings tab renders the same settings the native Settings editor shows, as form rows with their defaults and a Reset action.

- Two settings are easier to edit here than in the Settings UI: `modelParameters` and `headers` are objects the native settings GUI cannot edit, so the dashboard gives them row editors.
- Model parameter values are JSON (`0.2`, `true`, `"text"`, `["stop"]`); invalid input is flagged and Apply stays disabled until every row parses.
- Because VS Code merges object settings across scopes, each record editor works on one scope at a time (the one your edits write to) and lists entries from other scopes read only, so applying a change never copies user-scope values into workspace files.
- Header values are settings, not secrets: they show up exactly as they do in the Settings editor, so keep secret headers in User scope rather than workspace scope.

## Diagnostics

The Diagnostics tab gathers the support surfaces; "LiteLLM: Show Diagnostics" in the Command Palette opens the dashboard straight onto it.

- A connection summary, written to be copied whole into a bug report: the same verdict the status strip shows, the configured-server count, the last check as an absolute timestamp (with a relative echo), and one outcome line per server ("OK (12 models)", the error text otherwise), plus a Test connection button. Installs carrying pre-migration servers with no row of their own also see a "Legacy registry servers" count.
- Report a bug opens a GitHub issue pre-filled with version, platform, and recent logs - the same action as the header button.
- Request a feature, Rate this extension, Documentation, and the GitHub repository are plain links.
