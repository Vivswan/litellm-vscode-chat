---
applyTo: "**"
---
<!-- This file is managed by Vivswan/repo-platform.
     Local edits may be replaced during template updates. -->
# How to write review comments

Copilot code review reads this file when it reviews a pull request. It shapes the wording of each comment.

- First line: the problem in one plain sentence. What breaks, and when.
- Then show it. A 2-5 line snippet, or a concrete input and the wrong output it produces. An example beats an explanation.
- Then the fix, as a code suggestion when possible.
- Short sentences. One idea each. No jargon unless the code already uses that word.
- No praise, no restating what the diff does, no "consider maybe" hedging. Either it is wrong because X, or do not comment.
- Skip anything this repository's configured linter or formatter already reports.
