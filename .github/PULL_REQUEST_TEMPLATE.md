<!--
Delete each comment as you fill its section.

Title: a Conventional Commit, e.g. `fix(transport): a 401 stays an auth error`.
PRs are squash-merged, so the title becomes the commit subject. A fix for a
community issue credits its author: `fix: trim base URL slashes (#53, thanks @user)`.

Body: show the change in fenced blocks, then the fewest words. Everything above
<details> is capped at 150 words outside the fenced blocks; the blocks are free.
Straight quotes and plain ASCII punctuation, as in the code.
Publish nothing that says who you are or how your machine is set up: write
`/repo/...` for your checkout path, `example-user` for your login, and
`example.com` for a host.
-->

## What this changes

<!--
```text
before: request -> 401 -> wrapped as a network error -> "server unreachable" toast
after:  request -> 401 -> auth error -> "check the API key" toast
```

That is the flow, as arrows between steps. A second block follows only where the
change moved it: the real command output, or the numbers the change has (counts,
sizes, timings).

A feature opens with `## What this adds` instead. A bug fix may split into
`## Before` and `## After`, with the same blocks under each.
-->

```text
before:
after:
```

## How

<!--
- **The status is read before the wrapper runs,** so a 401 never becomes a network error.

3 to 6 bullets like that one: one sentence each, about 15 words, a bold lead-in.
A change that adds or touches a parser, fetcher, retry loop, or similar carries one more:

- **Library:** `<package>`, covers <what>. Or: searched <where>; none fits because <reason>.
-->

## Proof

<!--
- **Tests:** 2458 bun tests green (1 new).
- **Gate:** `bun run check` green.

2 to 4 bullets like those, latest totals only.
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
