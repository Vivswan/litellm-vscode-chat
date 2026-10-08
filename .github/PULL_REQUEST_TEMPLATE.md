<!--
Delete each comment as you fill its section.

Title: a Conventional Commit, e.g. `fix(transport): a 401 stays an auth error`.
PRs are squash-merged, so the title becomes the commit subject. A change that
resolves a community issue or PR credits its author: `fix: trim base URL slashes (#53, thanks @user)`.

Body: show the change in fenced blocks, then the fewest words. Everything above
<details> is capped at 150 words outside the fenced blocks; the blocks are free.
Straight quotes and plain ASCII punctuation, as in the code.

Publish nothing that tells a reader who you are (name, employer, login, email,
host), how you work, or how your machine is set up.

Redact before publishing, keeping the command and the output structure as captured:
strip credentials and tokens; write `/repo/...` for your checkout path, `~` for
your home, `example-user` for your login, `example-user@example.com` for an email,
`example.com` for a host or an employer.

A figure, a setting, a log, or a list of installed tools copied from your own
setup becomes a hand-written value the text calls an example; the repository's
own output and test totals stay as captured.
-->

## Before

<!--
```text
request -> 401 -> wrapped as a network error -> "server unreachable" toast
```

The kind of change sets the headings:

  bug fix or behavior change      ## Before and ## After, the same blocks under each
  feature                         ## What this adds
  pure refactor                   ## What this changes
  contract, schema, or docs       ## What this specifies

Under one heading, a single block carries a `before:` line and an `after:` line.

Insert only the blocks the change moved, in this order: the flow (plain ASCII,
arrows between steps), then the real output or the numbers (counts, sizes,
timings), or the contract itself. An output-only fix shows the output alone.
-->

## After

<!--
```text
request -> 401 -> auth error -> "check the API key" toast
```
-->

## How

<!--
- **The status is read before the wrapper runs,** so a 401 never becomes a network error.

By default 3 to 6 bullets like that one: one sentence each, about 15 words, a bold
lead-in. One small table may replace them when it explains the mechanism faster.
A change that adds, moves, touches, reuses, or depends on a parser, fetcher,
retry loop, or similar library-shaped code carries one more bullet:

- **Library:** `<package>`, covers <what>. Or: searched <where>; none fits because <reason>.
-->

## Proof

<!--
- **Tests:** 2458 bun tests green (1 new).
- **Gate:** `bun run check` green.

By default 2 to 4 bullets like those, latest totals only.
-->

<details>
<summary>Technical details</summary>

<!--
- **Refused: a retry on 401.** The server's answer is final, so a retry only repeats it.
- **Files:** `src/provider/transport/errorMapping.ts`.

Lines like those, for a bot reviewer or the next agent rather than the reader
above: reviewer notes, refused alternatives, the file list. One fact per line,
one sentence each. Delete this whole section when it is empty.
-->

</details>
