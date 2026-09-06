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
- No "consider maybe" hedging. Either it is wrong because X, or do not comment.

## What earns a comment

- Only a defect you can demonstrate: a concrete input or state, and the wrong output, crash, or data loss it produces in this diff. If you cannot name the input, do not comment.
- No speculative hardening: no "a hostile caller could", "consider validating", "future-proof", "for robustness", race conditions in a single-user tool, or defensive checks for inputs the code never receives.
- No style, naming, or structure opinions the repository's linter and formatter do not enforce, and nothing they already report.
- No restating the diff, no praise, no summaries.
