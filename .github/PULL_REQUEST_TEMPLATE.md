<!--
Delete each comment as you fill its section.

Title: a Conventional Commit, e.g. `fix(transport): a 401 stays an auth error`.
PRs are squash-merged, so the title becomes the commit subject. A change that
resolves a community issue or PR credits its author: `fix: trim base URL slashes (#53, thanks @user)`.

Body: show the change in fenced blocks, then the fewest words. Everything above
<details> is capped at 150 words outside the fenced blocks; the blocks are free.
One small table may stand in for the `## How` bullets when it explains the
mechanism faster. Straight quotes and plain ASCII punctuation, as in the code.

Publish nothing that tells a reader who you are (name, employer, login, email,
host), how you work, or how your machine is set up.

Redact before publishing, keeping the command and the output structure as captured:
strip credentials and tokens; write `/repo/...` for your checkout path, `~` for
your home, `example-user` for your login, `example-user@example.com` for an email,
`example.com` for a host or an employer.

A figure, a setting, a log, or a list of installed tools copied from your own
setup becomes a hand-written value the text calls an example; the repository's
own output and test totals stay as captured.

This file is the shape for a change to something that runs, where its output or
its flow moved. Another kind of change opens with its own file, through
`gh pr create --template <file>` or `?template=<file>` on the compare URL:

  a pure refactor: it runs, and neither moved    this file, with one `## What this changes`
                                                 heading in place of Before and After, its
                                                 one block carrying a `before:` and an
                                                 `after:` line
  something new, added beside what exists        additive.md
  read, not run; an evaluation measures it       measured.md
  a contract or a document: nothing runs         contract.md
-->

## Before

<!-- the flow as it ran: plain ASCII, arrows between steps, a branch on its own indented line; only when the flow moved -->

```text
step -> step -> step
```

<!-- the real captured output, complete enough to stand alone; only when the output changed -->

```text
$ command
output as it was
```

## After

<!-- the same order: the flow as it runs now, then the real output now; each block only when that facet moved -->

```text
step -> step -> branch? -> yes: step
                        -> no:  step
```

```text
$ command
output as it is now
```

## How

<!-- 3 to 6 bullets, one sentence each, about 15 words, a bold lead-in; the mechanism, never the flow again.
When the diff touches a library-shaped category, the last bullet is **Library:** package, covers what (or: searched where; none fits because) -->

- **...**
- **...**
- **...**

## Proof

<!-- 2 to 4 bullets: focused tests or stable checks, latest totals only; never one line per review round -->

- **Tests:** ...
- **Gate:** ...

<details>
<summary>Technical details</summary>

<!-- one fact per line, for a bot reviewer or the next agent; nothing part one already says.
In a release-please repository the commit-override block is the last element here. Delete this section when there is no such detail. -->

- **...**

</details>
