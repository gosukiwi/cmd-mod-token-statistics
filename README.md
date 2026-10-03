# token-statistics

A [Command Code](https://commandcode.ai/docs/mods) mod that meters tokens — input, output,
cache reads/writes, cache-hit rate and tokens per second — with a live footer
segment and a durable log that accumulates across sessions and over months.

## Install

```bash
cmd mods add -g gosukiwi/cmd-mod-token-statistics
```

`-g` installs it user-wide, so it loads in every project — drop it to scope the mod to the
current project instead. `cmd mods update` refreshes it after a new commit or tag
(`cmd mods add gosukiwi/cmd-mod-token-statistics@v1` pins a ref).

To try it without installing anything, load the file straight from a checkout:

```bash
cmd --mod ./token-statistics.ts
```

Either way, restart Command Code or run `/reload`.

## What you get

**A footer segment** under the input, updating after every model call. It carries the session
totals and the context used by the last request, and — once a sub-agent has been counted — the
sub-agent cluster:

```
▲ 128k in  ▼ 12.3k out  ⚡ 41 tok/s  ⛁ 78% cached  ctx 128.4k  ·  sub 4.2k tok  ⛁ ≥25% cached · 1 run
```

The `ctx …` segment is omitted until a request has been measured, and appears as a raw count —
the mod carries no model→window table, so it never reports a share of a window it does not know.
The `·  sub …` cluster is omitted until a sub-agent is finalized, and its `⛁ ≥…` part is
withheld unless the reading holds for every run shown (see below).

**`/token-stats`** shows the durable lifetime totals, plus a sub-agent summary line once one
has been counted:

```
lifetime   ▲ 3.9M in  ▼ 69.4k out  ⚡ 87 tok/s  ⛁ 96% cached  ·  12 runs
subagents  16.1M tok  ⛁ ≥88% cached · 5 runs
```

The `lifetime` row is all-time, across every session; the `subagents` row covers the current
session only.

Before anything has been recorded it answers with a notice instead:

```
no requests recorded yet
```

**A durable log** — `~/.commandcode/token-statistics.log.jsonl`, one JSON line per run plus one
per finalized sub-agent, never rewritten:

```json
{"ts":"2026-09-27T09:31:02.114Z","sessionId":"…","cwd":"/Users/me/app","stopReason":"end_turn",
 "input":128400,"output":12300,"cacheRead":100200,"cacheWrite":6100,"requests":24,
 "models":["claude-sonnet-5"],"durationMs":8400,"genMs":3100,"outputTokPerSec":41.2,
 "subagents":1,"subagentTokens":4200}
{"ts":"2026-09-27T09:31:04.006Z","kind":"subagent","sessionId":"…","toolCallId":"call-7",
 "subagentType":"explore","tokensUsed":667762,"turns":19,"toolUses":63,"durationMs":117189,
 "totalTokens":1256306}
```

The per-sub-agent line carries the counts from the `agent` tool's usage trailer; the trailer
fields are omitted when the tool did not report them.

Because the log is append-only and the aggregates live in a small companion JSON, both the
footer and `/token-stats` stay fast however long you have been running.

## Footer legend

| Part | Meaning |
|---|---|
| `▲ 128.4k in` | input (prompt) tokens this session — cache reads/writes included |
| `▼ 12.3k out` | output (completion) tokens |
| `⚡ 41 tok/s` | average output tokens/second over the session's model calls |
| `⛁ 78% cached` | share of input tokens served from the prompt cache (`cacheRead / input`) |
| `ctx 128.4k` | context used by the most recent request — its prompt size, as a raw count |
| `·  sub 4.2k tok` | summed input + output of the finalized sub-agents (informational) |
| `⛁ ≥25% cached` | lower bound on the sub-agents' cache-hit rate (see below) |

## Configure

Settings live in `~/.commandcode/token-statistics.json` alongside the aggregates:

```json
{
  "status": true,
  "summary": false,
  "log": true,
  "lifetime": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "requests": 0, "runs": 0 }
}
```

| Field | Default | What it does |
|---|---|---|
| `status` | `true` | Show the footer segment. |
| `summary` | `false` | Also print a one-line summary row in the feed after each run. |
| `log` | `true` | Append a record to the JSONL log. |

Each setting has a launch-time override that wins over the file:

```bash
cmd --mod-option token-stats-summary=true --mod-option token-stats-status=false
```

The file is re-read when it changes, so edits land without a reload.

## Commands

| Command | What it does |
|---|---|
| `/token-stats` | Lifetime totals, plus a sub-agent summary line when one has been counted. |
| `/token-stats reset` | Ask to confirm, then clear the lifetime totals. |

## How the numbers are counted

- **Source.** Numbers come from the `model_request_end` event's `usage` object —
  `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`. `inputTokens` is the total
  prompt count and the two cache figures are subsets of it, so cache-hit rate is
  `cacheRead / input` and the grand total is `input + output`.
- **Tokens/sec** is output tokens divided by the wall-clock of the model call (bracketed by
  `model_request_start` / `model_request_end`), so it measures generation speed, not tool time.
- **Lifetime totals** live in a small JSON file; the per-run history lives in the append-only
  JSONL. Both are global — shared across every project — and accumulate over months. The lifetime
  aggregates are the first line of `/token-stats`: its `⚡` is the average output tokens/second over
  the runs the mod has *timed* — the output those runs produced (`timed.output`) divided by their
  accumulated generation time (`timed.genMs`). The pair is recorded only for a run with a real
  `model_request_end`, so a run recovered from the `result.usage` fallback never contributes and
  its whole wall clock never pollutes the denominator. History from before timing existed carries
  no `timed` pair at all, so it cannot back that average and the `⚡` segment is omitted until the
  first timed run. Each run record keeps its `cwd`, so per-project grouping is possible later.
- **Sub-agents** are reported for information only — `subagentTokens` is their input + output
  (cache reads/writes included), never folded into the session or `lifetime` totals: a nested run
  reports its own usage, which may already be included in the parent's. The footer and
  `/token-stats` sum the finalized sub-agents into one `N tok` figure and count them as `N runs`.
  A `⛁ ≥N% cached` cluster is added only when every finalized sub-agent carries a parsed `<usage>`
  trailer with a known `total_tokens` *and* no request this session wrote to the cache; the `≥`
  marks a bound — `cached = Σ max(0, total_tokens − tokensUsed)`, so the true hit rate is at least
  `cached / tokensUsed`. No `⚡` rate appears in the sub-agent cluster: the harness exposes neither a
  sub-agent's output tokens nor its generation time. A `subagent_stop` that reports
  `tokensUsed === 0` never counts, and a background sub-agent counts only when its non-zero stop
  lands; `subagent_progress` carries an estimate and is never summed.
- **Fallback.** If a run records no `model_request_end` (an interrupted run, or a provider that
  does not emit one), the run's total is taken from the harness-reported `result.usage`.

## Files

| Path | What it is |
|---|---|
| `~/.commandcode/token-statistics.json` | Settings + lifetime aggregates (rewritten per run, atomically). |
| `~/.commandcode/token-statistics.log.jsonl` | Append-only, one record per run plus one per sub-agent. Safe to keep, grep, or chart. |

Both are created on first run. The lifetime aggregates in the JSON are what the first line of
`/token-stats` reports; the per-run log stays the long-term history. Nothing is sent anywhere —
the mod makes no network calls.

## Uninstall

```bash
cmd mods remove token-statistics
```

That removes the mod; your stats are deliberately left alone. Delete them too with:

```bash
rm ~/.commandcode/token-statistics.json ~/.commandcode/token-statistics.log.jsonl
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
