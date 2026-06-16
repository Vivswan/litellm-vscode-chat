# Prompt Caching — Manual Validation Guide (v0.2.8)

This guide walks you through validating the v0.2.8 prompt-caching behaviour end-to-end
against a real LiteLLM-backed Claude model. You drive the chat turns; the validator
script reads the live VS Code output-channel log and gives a pass/fail verdict.

## Example validated results (LiteLLM gateway → Anthropic Claude)

These are representative outcomes from a real validation run against a LiteLLM gateway
fronting a cache-capable Claude model. Your numbers will vary by gateway and prompt size.

| Test                                | Result                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| Cross-turn reuse (agent session)    | ✅ 96–99% read every turn                                |
| Cross-turn reuse (fresh chat)       | ✅ 99.4% by the 3rd turn                                 |
| Partial-prefix reuse (new chat)     | ✅ ~60% (shared tools+system)                            |
| **1h extended TTL > 5-min idle**    | ✅ **96.9% read after a 6-minute gap** — 1h tier honored |
| `firstUser` floor on small messages | ✅ `firstUser=off` (< `minCacheTokens`)                  |
| rolling placement under default     | ✅ `placedOn` never `tool` (`stableTurnsOnly`)           |

**Conclusion:** when the gateway forwards the extended-cache-ttl beta, both the 5m and 1h
tiers work; gateways that strip it silently fall back to 5m (see Test B). Occasional
`read==0` on the first follow-up after a large cold write is the documented Anthropic
write→read propagation lag and self-corrects on the next turn — not an extension bug.

## Prerequisites

- Extension **v0.2.8** installed and active.
- A model that advertises `supports_prompt_caching` (e.g. `claude-opus-4-8`).
- The **LiteLLM output channel** open is *not* required — the log is written to disk
  regardless. The validator finds it automatically.

## The verify command

Run this after each step (it auto-discovers the newest live log):

```powershell
pwsh -File scripts/validate-cache-log.ps1 -Tail 8
```

Leave it running live while you test:

```powershell
pwsh -File scripts/validate-cache-log.ps1 -Tail 8 -Watch
```

What the verdicts mean:

| Verdict | Meaning |
|---|---|
| `COLD write (expected on 1st turn)` | `cache_read == 0`, `creation > 0` — the prefix was written for the first time. |
| `WARM read - PASS` | `cache_read > 0` — the cached prefix was reused. **This is the win.** |
| `MISS (read==0 on warm turn)` | A later turn failed to reuse cache — investigate. |
| `caching OFF (no read) - OK` | `mode: off` (or unsupported) and no read happened — correct. |

---

## Test A — Baseline cross-turn cache hit (the core claim)

**Goal:** prove turn 2+ reuses the prefix written on turn 1.

1. Set in `settings.json`:
   ```json
   { "litellm-vscode-chat.promptCaching.mode": "auto" }
   ```
2. Open a **brand-new chat** with the caching-capable model selected.
3. **Prompt 1 (verbatim):**
   > Reply with only the single word: READY
4. **Prompt 2 (verbatim):**
   > Reply with only the single word: AGAIN
5. **Verify:**
   ```powershell
   pwsh -File scripts/validate-cache-log.ps1 -Tail 2
   ```
   - Turn 1 → `COLD write` (or `WARM read` if a recent identical prefix is still cached).
   - Turn 2 → `WARM read - PASS`.

✅ **Pass criteria:** the second turn shows `read > 0`.

---

## Test B — 1h extended TTL survives the gateway

**Goal:** confirm the `1h` tier is honoured (not silently downgraded to 5m by the
gateway). This is the only check that needs wall-clock time.

1. Mode `auto` (system/tools resolve to `1h` once they meet `minCacheTokens` — confirm in the plan line).
2. **New chat.** Send **Prompt 1:**
   > Summarise in one sentence what prompt caching is.
   (This writes the cache.)
3. **Wait at least 6 minutes** (past the 5-minute TTL, well under 1 hour). Do nothing
   in that chat.
4. Send **Prompt 2:**
   > Now restate that in five words.
5. **Verify:**
   ```powershell
   pwsh -File scripts/validate-cache-log.ps1 -Tail 2
   ```
   - If Turn 2 → `WARM read - PASS` after the >5-min gap, the **1h tier is working**.
   - If Turn 2 → `MISS (read==0)`, the gateway stripped the 1h beta and it fell back to
     5m (harmless, but means the 1h tier is not in effect through your gateway).

✅ **Pass criteria:** `read > 0` after a 6-minute idle gap.
ℹ️ A `MISS` here is *not a code bug* — it is the documented gateway-dependent fallback.

---

## Test C — `firstUser` floor

**Goal:** prove `minCacheTokens` suppresses tiny anchors and larger stable anchors use `1h`.

1. Mode `auto`, defaults (`minCacheTokens: 4096`; `tokenSizeAutoBreakpoint` is deprecated).
2. **New chat.** Tiny first message:
   > hi
3. Send any follow-up so a request fires, then verify:
   ```powershell
   pwsh -File scripts/validate-cache-log.ps1 -Tail 1
   ```
   - Plan line should show `firstUser=off` (first user message < 4096 tokens).
4. **New chat.** Make the **first message large** — paste a long file or a >4096-token
   block of text, then ask a question about it.
5. Verify `-Tail 1`:
   - Plan line should show `firstUser=1h` (first user message ≥ `minCacheTokens`).

✅ **Pass criteria:** `firstUser` flips from `off` → `1h` as the first message grows.

---

## Test D — Mode matrix

**Goal:** prove each mode resolves the documented TTLs. Re-run the same 2-turn exchange
(Test A prompts) under each mode, checking the **plan line** in `-Tail 1`.

| `promptCaching.mode` | Expected plan line |
|---|---|
| `chat` | `tools=5m-or-off system=5m-or-off firstUser=5m-or-off rolling=5m/...` |
| `agent` | `tools=1h-or-off system=1h-or-off firstUser=1h-or-off rolling=5m/...` |
| `auto` | `tools=1h-or-off system=1h-or-off firstUser=1h-or-off rolling=5m/...` |
| `off` | `active=False` and every turn → `caching OFF (no read)` |

After changing the setting, **reload VS Code** (or start a new chat) so the new mode is
picked up, then send the two prompts and verify.

✅ **Pass criteria:** plan line matches the row; `off` shows zero reads.

---

## Test E — `rollingLastMessage` placement

**Goal:** prove the rolling anchor placement honours the setting and never lands on a
tool result under the default.

1. Mode `auto`, `rollingLastMessage: "stableTurnsOnly"` (default).
2. New chat; ask something that triggers a **tool call** (e.g. "read file X and
   summarise it"). Verify `-Tail 1`:
   - `placedOn` is `user` or `assistant` — **never** `tool`.
3. Set `"litellm-vscode-chat.promptCaching.rollingLastMessage": "never"`, reload, repeat:
   - Plan line shows `rolling=off`.
4. Set it to `"always"`, reload, repeat a tool-call turn:
   - `placedOn` may now be `tool`.

✅ **Pass criteria:** placement follows the setting; default never tags `tool`.

---

## Quick reference — one-liner tail

If you'd rather grep the raw log yourself:

```powershell
$log = Get-ChildItem "$env:APPDATA\Code\logs" -Recurse -Filter "*LiteLLM*" |
  Sort-Object LastWriteTime -Desc | Select-Object -First 1
Get-Content $log.FullName -Tail 200 |
  Select-String 'caching|cache_read_input_tokens|cache_creation_input_tokens|"mode"|firstUser|rollingPlacedOn'
```
