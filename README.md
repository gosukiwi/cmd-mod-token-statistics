# token-statistics

A [Command Code](https://commandcode.ai/docs/mods) mod that meters tokens — input, output,
cache reads/writes, cache-hit rate, tokens per second and context usage — with a live footer
segment and a durable log that accumulates across sessions and over months.

## Install

```bash
bin/install
```

This copies the mod to `~/.commandcode/mods/` (so it loads in every project). Restart Command
Code, or run `/reload`.

## What you get

**A footer segment** under the input, updating after every model call:

```
▲ 128k  ▼ 12.3k  ⚡ 41 tok/s  ⛁ 78% cached  ctx 128k/1M (13%)
```

**`/token-stats`** for the full breakdown:

```
Token statistics · my-app
  session   ▲ 128k in  ▼ 12.3k out  ⛁ 78% cached  ·  24 requests
  lifetime  ▲ 4.2M in  ▼ 318k out  ⛁ 81% cached (62k written)  ·  412 runs since 2026-03-04
  speed     avg 41 tok/s  ·  range 12–78  ·  over 24 requests
  context   128k / 1M (13%)  ·  claude-sonnet-5
  models    claude-sonnet-5  ▲ 4.1M ▼ 300k  (390 requests)
  log       ~/.commandcode/token-statistics.log.jsonl · 412 records
```

**A durable log** — `~/.commandcode/token-statistics.log.jsonl`, one JSON line per run, never
rewritten:

```json
{"ts":"2026-09-27T09:31:02.114Z","sessionId":"…","cwd":"/Users/me/app","stopReason":"end_turn",
 "input":128400,"output":12300,"cacheRead":100200,"cacheWrite":6100,"requests":24,
 "models":["claude-sonnet-5"],"durationMs":8400,"genMs":3100,"outputTokPerSec":41.2,
 "subagents":1,"subagentTokens":4200}
```

Because the log is append-only and the aggregates live in a small companion JSON, both the
footer and `/token-stats` stay fast however long you have been running.

## Footer legend

| Part | Meaning |
|---|---|
| `▲ 128.4k` | input (prompt) tokens this session — cache reads/writes included |
| `▼ 12.3k` | output (completion) tokens |
| `⚡ 41 tok/s` | average output tokens/second over the session's model calls |
| `⛁ 78% cached` | share of input tokens served from the prompt cache (`cacheRead / input`) |
| `ctx 128.4k/1M (13%)` | context size of the most recent request, as a share of the model's window |

Context % needs to know the model's window. A small built-in table covers common Command Code
models; an unknown model degrades to a raw `ctx 128.4k` with no percentage.

## Configure

Settings live in `~/.commandcode/token-statistics.json` alongside the aggregates:

```json
{
  "status": true,
  "summary": false,
  "log": true,
  "contextInStatus": true,
  "lifetime": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "requests": 0, "runs": 0 },
  "byModel": {}
}
```

| Field | Default | What it does |
|---|---|---|
| `status` | `true` | Show the footer segment. |
| `summary` | `false` | Also print a one-line summary row in the feed after each run. |
| `log` | `true` | Append a record to the JSONL log. |
| `contextInStatus` | `true` | Include context usage in the footer. |

Each setting has a launch-time override that wins over the file:

```bash
cmd --mod-option token-stats-summary=true --mod-option token-stats-status=false
```

The file is re-read when it changes, so edits land without a reload.

## Commands

| Command | What it does |
|---|---|
| `/token-stats` | Full breakdown — session, lifetime, speed, context, per-model, log path. |
| `/token-stats reset` | Ask to confirm, then clear the lifetime totals and per-model breakdown. |

## How the numbers are counted

- **Source.** Numbers come from the `model_request_end` event's `usage` object —
  `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`. `inputTokens` is the total
  prompt count and the two cache figures are subsets of it, so cache-hit rate is
  `cacheRead / input` and the grand total is `input + output`.
- **Tokens/sec** is output tokens divided by the wall-clock of the model call (bracketed by
  `model_request_start` / `model_request_end`), so it measures generation speed, not tool time.
- **Lifetime totals** live in a small JSON file; the per-run history lives in the append-only
  JSONL. Both are global — shared across every project — so `/token-stats` shows your all-time
  numbers. Each run record keeps its `cwd`, so per-project grouping is possible later.
- **Sub-agents** are reported for information only (`subagents` / `subagentTokens`), never added
  to the lifetime totals: a nested run reports its own usage, which may already be included in
  the parent's.
- **Fallback.** If a run records no `model_request_end` (an interrupted run, or a provider that
  does not emit one), the run's total is taken from the harness-reported `result.usage`.

## Files

| Path | What it is |
|---|---|
| `~/.commandcode/token-statistics.json` | Settings + lifetime/per-model aggregates (rewritten per run, atomically). |
| `~/.commandcode/token-statistics.log.jsonl` | Append-only, one record per run. Safe to keep, grep, or chart. |

Both are created on first run. Nothing is sent anywhere — the mod makes no network calls.

## Uninstall

```bash
bin/uninstall           # remove the mod, keep your stats and log
bin/uninstall --purge   # also delete the state file and the log
```

## Tests

```bash
npm test
```

Zero dependencies — the suite runs on Node's built-in test runner, driving the real mod factory
against a fake `ModApi`. It covers the accumulation maths, the footer formatting, tokens/sec
timing, the persistence round-trip (including cross-session), the defensive usage parsing, and
`/token-stats`. Nothing touches the network, and the tests redirect `$HOME` to a throwaway
directory so they can never read or rewrite your real stats. Requires Node 24+, which imports
the TypeScript source directly via native type stripping.

## Notes

- The `usage` shape is read defensively: the flat normalized object and the raw nested AI-SDK
  shape (`inputTokenDetails.cacheReadTokens`, …) are both understood.
- The mod observes the event stream; it never blocks or rewrites anything.
- The context-window table is seeded from Command Code's model catalog and needs occasional
  refreshing as new models ship — unknown models simply omit the percentage.
