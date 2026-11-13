<!--
The shape for a contract or a document: nothing runs, so the contract itself is
the picture.

The title, punctuation, and redaction rules are in the comment that opens
.github/PULL_REQUEST_TEMPLATE.md. Delete each comment as you fill its section.
-->

## What this specifies

<!-- the flow, when the contract changes one: a before: line and an after: line in one block, plain ASCII -->

```text
before: step -> step
after:  step -> check -> step
```

<!-- the contract itself: its schema, table, or layout, in a block, not in prose -->

```text
the contract, as the reader will see it
```

## How

<!-- 3 to 6 bullets, one sentence each, about 15 words, a bold lead-in; the mechanism, never the flow again -->

- **...**
- **...**
- **...**

## Proof

<!-- 2 to 4 bullets: the check that enforces the contract, and the gate -->

- **Check:** ...
- **Gate:** ...

<details>
<summary>Technical details</summary>

<!-- one fact per line; accepted deviations from the contract belong here. Delete the section when there is no such detail. -->

- **Accepted deviation:** ...

</details>
