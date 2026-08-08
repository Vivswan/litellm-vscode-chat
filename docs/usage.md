# Usage and budgets

English | [简体中文](zh-cn/usage.md) | [繁體中文](zh-tw/usage.md)

When a LiteLLM server tracks spend, the extension surfaces it: how much your key has spent against its budget, alerts before the budget runs out, a status bar item that stays out of the way until it matters, and a dashboard panel with the full picture. Everything here is read-only - the extension reads spend data from your servers and never changes a budget, a key, or anything else server-side. Spend data is also never written to the extension's logs or into bug reports; it stays between you and your server.

Four settings drive it all, each detailed in context below:

| Setting | Default | One line |
|---|---|---|
| [`usage.pollInterval`](settings.md#reference) | `300000` ms | how often spend is fetched in the background; `0` = off ([Polling](#polling)) |
| [`usage.alertThresholds`](settings.md#reference) | `[0.8, 0.95]` | budget fractions that trigger a notification ([Alerts](#alerts)) |
| [`usage.statusBar`](settings.md#reference) | `"always"` | `always` / `alerts-only` / `off` ([The status bar](#the-status-bar)) |
| the entry's [`budget`](servers.md#entry-reference) | unset | a manual budget in USD, per server ([Budgets](#budgets)) |

## Requirements

Usage features need a LiteLLM server that runs with a database - the standard setup for spend tracking and [virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys). The extension reads up to three endpoints, always about its own key (the one the server entry authenticates with) and, when that key belongs to a user, that user's own rollup - it never enumerates other keys or users:

| Endpoint | What the extension reads |
|---|---|
| `/key/info` | the calling key's spend, `max_budget`, and `budget_reset_at` |
| `/user/daily/activity` | request counts, success rate, and cache-read token counts for the last 30 days |
| `/user/info` | the owning user's spend, `max_budget`, and `budget_reset_at` - read only when `/key/info` reports the key belongs to a user |

On a server without a database these endpoints do not exist. The extension detects that once and hides every usage surface for that server silently: no dashboard section, no status bar item, no alerts, no error noise, nothing to configure. Availability is per server, so a mixed fleet works fine - usage appears exactly where the data exists.

That detection sticks: background polls do not re-check an endpoint already found missing. If you enable the database later, run "LiteLLM: Refresh Usage Now" - or edit the server's entry - and the extension re-probes availability.

A key can hide usage the same way on a database-backed server: when the server refuses the key on both `/key/info` and `/user/daily/activity` (401 or 403 - a key not permitted to read usage data), the extension treats that as equally permanent and hides the same surfaces. The curl test below tells the two apart: a missing database answers with a routing error, a restricted key with 401 or 403 - the fix is then a key allowed to read its own usage, not a database.

To check what a server supports, ask it the same question the extension asks:

```bash
curl -s -H "Authorization: Bearer $YOUR_LITELLM_KEY" https://litellm.example.com/key/info
```

A database-backed server answers with JSON carrying `spend` and `max_budget` fields; a database-less one answers with an error, because the route is not served without a database. If the curl works but the extension shows nothing, check that the entry's key is the one you tested with - the data is per key. And it is the key's server-side total: every client that spends through that key counts toward it, not only VS Code.

Availability is per endpoint as well as per server: a server (or your key on it) may answer `/key/info` but not `/user/daily/activity`. The [usage panel](#the-usage-panel) then shows spend and budget without the request statistics - a normal shape on some setups, not an error.

## Budgets

A budget can come from two places:

- **Key-reported**: the `max_budget` LiteLLM stores on the key itself, set server-side when the key was created. `/key/info` reports it along with the current spend.
- **The entry's `budget` field**: a manual number (USD, greater than 0) on the [server entry](servers.md#entry-reference):

```jsonc
"litellm-vscode-chat.servers": [
  {
    "label": "prod",
    "baseUrl": "https://litellm.example.com",
    "auth": { "apiKey": "sk-..." },
    "budget": 50
  }
]
```

When both exist, the entry's value is the **effective budget**: percentages and [alerts](#alerts) compute against it, and every surface that shows a budget shows both (`budget $50 - key reports $100`), so the server-side cap never disappears from view. The entry field exists for two situations: a key the server gave no `max_budget`, and a personal alert line set below the hard server-side cap.

A server with spend data but no budget from either source shows its spend without a percentage, and never alerts - there is nothing to compute a fraction of.

The reset date shown beside a budget is the key's `budget_reset_at`: when LiteLLM will zero the spend for the next period. After a reset, spend drops and any tripped [alerts](#alerts) re-arm on their own. The drop becomes visible at the next fetch - a background poll, a dashboard open, or "LiteLLM: Refresh Usage Now" - not at the reset instant itself; a key without a reset schedule simply shows no reset date.

Edge cases worth knowing:

- **The entry's `budget` needs spend data to measure against.** On a server that serves no usage data it changes nothing - the usage surfaces stay hidden regardless.
- **An entry `budget` above the key's cap defeats the alerts.** The entry value wins unconditionally, so a `budget` of $200 on a key capped at $100 computes every percentage against $200 - the server cuts the key off at $100, before the first warning fires. The extension cannot raise a server-side `max_budget`: to be warned before the cap, keep the entry value at or below it, or leave it unset and let the key's own number drive.
- **Spend can pass the budget.** The extension is read-only and never blocks a request; whether the server keeps serving a key past its `max_budget` is LiteLLM policy, not the extension's. Every threshold is at most 1, so spend past the budget sits above the highest one: error background, all alerts fired.
- **The data follows the key, not the entry.** Rotating an entry's credential switches its numbers to the new key's spend and budget. Two entries authenticating with the same key each show that key's spend - and since the [status bar](#the-status-bar) takes a maximum, never a sum, the shared spend is not double-counted there.

## Polling

`usage.pollInterval` (milliseconds, default `300000` - 5 minutes) drives a background poller, so alerts and the status bar work with the dashboard closed. Negative values clamp to `0`; a nonzero value below `30000` (30 seconds) clamps up to it, so the fastest cadence is one fetch per server every 30 seconds.

`0` turns background polling off entirely:

- No background requests are made and no alerts fire.
- The dashboard still fetches fresh data every time it opens.
- "LiteLLM: Refresh Usage Now" still fetches immediately, whenever you run it.

**Freshness.** A server's usage data counts as *fresh* while the last fetch succeeded and is less than two poll intervals old; with polling off, data from an on-demand fetch counts as fresh for ten minutes (twice the default interval), and "LiteLLM: Refresh Usage Now" always produces fresh data. Once data goes stale - the server stopped answering, or the window ran out - the extension keeps showing the last-known values in the [usage panel](#the-usage-panel), labeled with their age ("last updated 25 minutes ago"), but the [status bar](#the-status-bar) drops the server from its aggregation rather than present an old number as current.

The same rule covers a machine that was offline or asleep: no polls run while it sleeps, so anything older than two intervals wakes up stale - the panel keeps showing it with its age, and the status bar item stays hidden until the next successful fetch replaces it.

- A key reporting `max_budget: 0` counts as having no budget (LiteLLM's zero-means-unlimited convention); a server entry `budget` must be a positive number - zero or negative values are reported as a configuration diagnostic and ignored.

## Alerts

`usage.alertThresholds` is a list of fractions of the effective budget, each above 0 and at most 1; reaching a threshold counts as crossing it (at 80.0% the 0.8 alert fires, and a `[1.0]` threshold fires when spend equals the budget). Out-of-range values are dropped and reported as a configuration diagnostic. The default `[0.8, 0.95]` warns at 80% and again at 95%. The list is deduplicated and sorted for you; an empty list turns alerts off.

- Crossing a threshold shows **one** notification per server and threshold - polling every five minutes does not mean a toast every five minutes. When one poll jumps past several thresholds at once, only the highest fires. All budget notifications use one severity; the escalating color story lives in the [status bar](#the-status-bar).
- A tripped threshold re-arms when spend drops back below it: a new billing period, a raised budget, and the alert is live again for next time.
- Alerts evaluate on every fetch - background polls and manual refreshes alike; a "LiteLLM: Refresh Usage Now" that reveals a crossing toasts immediately. The once-per-server-and-threshold rule still applies.

With a $50 effective budget and the defaults, you hear from the extension at $40 and at $47.50 - and not again until the budget resets.

A shorter list works the same way, with one wrinkle on the [status bar](#the-status-bar): severity there scales to the *highest configured* threshold, so with a single-entry list like `[0.5]` that one threshold is the alarm - crossing it goes straight to the error background. At the other end, `[1.0]` keeps the extension quiet until the budget is effectively gone.

## The status bar

`usage.statusBar` controls a deliberately minimal status bar item, sitting beside the [LiteLLM connection item](dashboard.md#the-status-bar-items):

| Value | Behavior |
|---|---|
| `"always"` (default) | visible whenever there is something to show |
| `"alerts-only"` | hidden until a threshold trips, visible while one is tripped |
| `"off"` | never shown |

The item's text is one thing only: the spend percentage of the **worst fresh server** - the highest spend-to-effective-budget ratio among servers with [fresh data](#polling) and a budget. Everything else lives in the tooltip.

| Situation | The item shows |
|---|---|
| every fresh server under its thresholds (`"always"`) | the worst percentage, plain - e.g. `42%` |
| any fresh server over the lowest threshold | the percentage on a warning background |
| any fresh server over the highest threshold | the percentage on an error background |
| `"alerts-only"`, nothing over a threshold | nothing |
| no server has a budget, or `"off"` | nothing |
| no fresh data at all | nothing |

With a custom threshold list, the severity scale tops out at the highest configured threshold: crossing the highest gets the error background, crossing any lower one the warning background - so a single-threshold list goes straight to the error background when crossed; it is the alarm.

Past 100%, the item shows the literal number (`112%`) - the panel's bar just fills, with the real percentage on its label.

The last row is the staleness rule doing its job: the item never shows a stale number as if it were current. Stale servers are excluded from the aggregation and noted in the tooltip; when *no* server has fresh data, the item hides entirely - the connection item already tells the outage story, and a second red thing would add nothing.

The tooltip carries the full per-server breakdown: spend, both budgets, the percentage, the reset date, how many *other* servers are over a threshold, and when the data was last updated. Clicking the item opens [the usage panel](#the-usage-panel).

Edge cases the rules above imply, spelled out:

- **The number can jump between updates.** The worst server is recomputed at every poll, so the percentage can move to a *different* server's ratio, not just up or down along one server's spend; the tooltip's breakdown shows which server is behind the current number.
- **Percentages never add up.** The item is a maximum across servers: two half-spent budgets show as the larger of the two, not as 100%.
- **`"alerts-only"` follows freshness too.** When the only over-threshold server's data goes stale, the item hides even though the budget is likely still spent - it returns when fresh data confirms the state either way. The panel keeps the last-known values meanwhile.
- **`"off"` hides the item and nothing else.** Alerts still fire and the usage panel still works; the setting controls one status bar item only.

## The usage panel

The dashboard's [Usage section](dashboard.md#the-usage-section) is where the complete picture lives. For each server with usage data:

- A **spend vs budget bar** with the percentage, against the effective budget; the key-reported budget shows beside it when the two differ.
- The **reset date** (`budget_reset_at`).
- **Request count, success rate, and cache hit rate** over the last 30 days (UTC calendar days, today included), where the server serves `/user/daily/activity`; servers without it show spend and budget only.
- A **Refresh now** button: fetches immediately, disables itself while a fetch is in flight, and shows when the data was last updated.

Opening the dashboard fetches fresh data even when [polling](#polling) is off. When a server's data is stale, its last-known values stay on screen labeled "last updated X ago" - history you can still read, clearly marked as history.

## Commands

| Command | What it does |
|---|---|
| LiteLLM: Refresh Usage Now | fetches spend data for every server immediately, regardless of `usage.pollInterval`, and re-checks usage availability on every server |
| LiteLLM: Open Dashboard | opens the dashboard; the Usage section is one click away (or direct, via the status bar item) |
