<!--
The shape for a change that is read rather than run, whose effect an evaluation
measures. The part above <details> runs to about 200 words here, not 150.

The title, punctuation, and redaction rules are in the comment that opens
.github/PULL_REQUEST_TEMPLATE.md. Delete each comment as you fill its section.
-->

## Problem

<!-- two or three sentences, the one prose opening: what went wrong, as the evaluation saw it -->

...

## Fix

<!-- the flow before and after, one text block, plain ASCII, arrows between steps -->

```text
before: step -> step -> step
after:  step -> changed step -> step
```

## Reasoning

<!-- 3 to 4 bullets with a bold lead-in: why this change should move the behavior, since the fix alone does not say.
When the diff touches a library-shaped category, the last of them is **Library:** package, covers what (or: searched where; none fits because) -->

- **...**
- **...**
- **...**

## Results

<!-- a measured before/after table; a cell not yet measured says "not yet" and why -->

| Metric | Before | After |
| ------ | ------ | ----- |
| ...    | ...    | ...   |

<!-- one footer line: the judge, the runs, the aggregation -->

Judge: ..., N prompts, N runs each, mean.

## Proof

<!-- 2 to 4 bullets, usually the tests and the gate, latest totals only -->

- **Tests:** ...
- **Gate:** ...

<details>
<summary>Technical details</summary>

<!-- one fact per line, for a bot reviewer or the next agent; nothing part one already says. Delete the section when there is no such detail. -->

- **...**

</details>
