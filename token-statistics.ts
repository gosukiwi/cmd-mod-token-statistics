// Token statistics for Command Code — a live meter in the footer plus a durable log.
//
// Where the numbers come from: the agent emits a `model_request_start` /
// `model_request_end` pair around every inference call, and the end event carries a
// normalized `usage` object. This mod brackets each pair to time the call, so it can
// report tokens/sec on top of the raw counts.
//
// The shape of `usage` (verified against the bundled CLI and the AI SDK it wraps):
//
//   {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}
//
// `inputTokens` is the TOTAL prompt count; `cacheReadTokens` / `cacheWriteTokens` are
// SUBSETS of it (the AI SDK's inputTokenDetails.noCache/cacheRead/cacheWrite add up to
// the total). So cache-hit rate = cacheRead / input, and grand total = input + output.
// readUsage() below also accepts the raw nested AI-SDK shape, because the normalized
// object is not the only thing a provider can hand back.
//
// Everything lives in two files under ~/.commandcode/:
//
//   token-statistics.json       settings + lifetime aggregates (rewritten per run)
//   token-statistics.log.jsonl  append-only, one line per run — the long-term history
//
// The log is appended, never rewritten, so it stays honest over months. The JSON file is
// small (aggregates only) so it reads fast for the footer and /token-stats.
//
// Surfaces:
//   • footer segment (cmd.ui.setStatus) — live session totals, tok/s, and sub-agent usage
//   • /token-stats                     — lifetime totals, plus a sub-agent summary line
//   • a per-run feed row (opt-in via the "summary" setting)
//
// Headless (`cmd -p`) renders no footer and drops feed rows, but the log still writes —
// so stats accumulate from CI runs too.

import {appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import type {ModApi} from '@commandcode/harness';

const CONFIG_PATH = join(homedir(), '.commandcode', 'token-statistics.json');
const LOG_PATH = join(homedir(), '.commandcode', 'token-statistics.log.jsonl');

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	requests: number;
}

interface Lifetime extends Totals {
	runs: number;
	// Total generation wall-clock across every run, so /token-stats can report an all-time
	// tokens/second without re-reading the log.
	genMs: number;
	since: string;
}

interface Settings {
	readonly status: boolean;
	readonly summary: boolean;
	readonly log: boolean;
}

interface StateFile {
	readonly status?: boolean;
	readonly summary?: boolean;
	readonly log?: boolean;
	readonly lifetime?: Partial<Lifetime>;
}

interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

// The usage trailer the `agent` tool appends to its result text. Every field is optional:
// the whole block may be absent, or a key may be missing or not a number.
interface SubagentTrailer {
	readonly turns?: number;
	readonly toolUses?: number;
	readonly durationMs?: number;
	readonly totalTokens?: number;
}

// One in-flight sub-agent, keyed by the `agent` tool call that launched it. A stop carries
// the token count, but the entry is only finalizable once the sub-agent is known to be done:
// a background one is done when it stops, a foreground one when its tool call completes.
interface SubagentRun {
	toolCallId: string;
	subagentType: string | undefined;
	background: boolean;
	agentDone: boolean;
	tokensUsed: number;
	trailer: SubagentTrailer | undefined;
	finalized: boolean;
	// The run epoch this entry was launched in. A background sub-agent outlives the run that
	// launched it, so its finalize must be attributed to that run — not to whichever run
	// happens to be in flight when it stops.
	runNumber: number;
}

interface RunRecord {
	readonly ts: string;
	readonly sessionId: string | undefined;
	readonly cwd: string;
	readonly stopReason: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly requests: number;
	readonly models: readonly string[];
	readonly durationMs: number;
	readonly genMs: number;
	readonly outputTokPerSec: number;
	readonly subagents: number;
	readonly subagentTokens: number;
}

// One durable line per finalized sub-agent, alongside the per-run lines. The four trailer
// fields are dropped by JSON.stringify when undefined, so an unknown value never lands as
// null — the key is simply absent.
interface SubagentRecord {
	readonly ts: string;
	readonly kind: 'subagent';
	readonly sessionId: string | undefined;
	readonly toolCallId: string;
	readonly subagentType: string | undefined;
	readonly tokensUsed: number;
	readonly turns?: number;
	readonly toolUses?: number;
	readonly durationMs?: number;
	readonly totalTokens?: number;
}

function zeros(): Totals {
	return {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0};
}

// Run-scoped state — everything that restarts on a run_start. Bundled into one object built
// by one factory so a future run-scoped field cannot be added to one reset site (a new
// session) and forgotten in the other (a new run).
interface RunState {
	totals: Totals;
	// The model ids seen this run, for the per-run log line. Only the ids are needed — the
	// per-model totals were dropped along with the report's models row.
	models: Set<string>;
	startedAt: number | undefined;
	genMs: number;
	reportedEnd: boolean;
	// A run epoch, bumped on every run_start. A sub-agent records the epoch it launched in,
	// so its finalize can tell whether the launching run is still the active one — a
	// background sub-agent's stop may arrive during a later run.
	epoch: number;
}

function newRun(epoch: number, startedAt?: number): RunState {
	return {
		totals: zeros(),
		models: new Set(),
		startedAt,
		genMs: 0,
		reportedEnd: false,
		epoch,
	};
}

// Coerce anything that is not a finite number to 0 — usage fields arrive from providers
// and can legitimately be undefined.
function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readUsage(raw: unknown): Usage {
	const usage = (raw ?? {}) as Record<string, unknown>;
	const details =
		usage.inputTokenDetails && typeof usage.inputTokenDetails === 'object'
			? (usage.inputTokenDetails as Record<string, unknown>)
			: {};
	return {
		input: num(usage.inputTokens),
		output: num(usage.outputTokens),
		cacheRead: num(usage.cacheReadTokens ?? details.cacheReadTokens ?? usage.cachedInputTokens),
		cacheWrite: num(usage.cacheWriteTokens ?? details.cacheWriteTokens),
	};
}

// The hook's `result` is the tool's *content*, not a bare string: the harness builds tools
// with `textResult({text})`, which returns `{ok: true, content: [{type: 'text', text}]}`, and
// hands the `.content` array to `afterToolCall`. So the `agent` tool's result — the thing the
// `<usage>` trailer lives in — arrives as an array of content blocks. Normalize either shape
// down to its text; anything else has no trailer.
function trailerText(result: unknown): string | undefined {
	if (typeof result === 'string') return result; // tolerated, though the host never sends it
	if (Array.isArray(result)) {
		return result
			.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join('\n');
	}
	return undefined;
}

// Parse the `<usage>` trailer the `agent` tool appends to its result text:
//
//   <usage>total_tokens: 1256306
//   tool_uses: 63
//   turns: 19
//   duration_ms: 117189</usage>
//
// Tolerant by design: a result with no text (a non-string, non-array value; an empty block
// array), a missing block, or a key that is absent or not a number leaves that field (or the
// whole trailer) undefined — never an exception.
function parseSubagentTrailer(result: unknown): SubagentTrailer | undefined {
	const text = trailerText(result);
	if (text === undefined) return undefined;
	const block = text.match(/<usage>([\s\S]*?)<\/usage>/);
	if (block === null) return undefined;
	const body = block[1];
	const read = (key: string): number | undefined => {
		const match = body.match(new RegExp(`\\b${key}\\s*:\\s*([^\\s]+)`));
		if (match === null) return undefined;
		const value = Number(match[1]);
		return Number.isFinite(value) ? value : undefined;
	};
	return {
		totalTokens: read('total_tokens'),
		toolUses: read('tool_uses'),
		turns: read('turns'),
		durationMs: read('duration_ms'),
	};
}

function addTotals(target: Totals, usage: Usage, requests = 1): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.requests += requests;
}

function trimZero(text: string): string {
	return text.endsWith('.0') ? text.slice(0, -2) : text;
}

function formatTokens(value: number): string {
	const n = Math.round(value);
	if (n < 1000) return String(n);
	if (n < 100_000) return `${trimZero((n / 1000).toFixed(1))}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function formatRate(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '0';
	return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function percent(part: number, whole: number): number {
	return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function humanDuration(ms: number): string {
	if (ms < 1000) return 'under a second';
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function plural(count: number, word: string): string {
	return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
}

export default function (cmd: ModApi): void {
	// No default on the booleans, so getFlag returns undefined when the flag was not passed
	// — that is how a value in the config file is allowed to win.
	cmd.addFlag('token-stats-status', {
		type: 'boolean',
		description: 'Show live token totals in the footer.',
	});
	cmd.addFlag('token-stats-summary', {
		type: 'boolean',
		description: 'Also print a per-run summary row in the feed.',
	});
	cmd.addFlag('token-stats-log', {
		type: 'boolean',
		description: 'Append a per-run record to the durable log.',
	});

	// Session-scoped state. This is volatile on purpose: the durable totals live in the
	// state file, and the session view is what the footer shows.
	const session = zeros();
	let sessionId: string | undefined;

	// Run-scoped state, built fresh by newRun on every run_start (see resetSession and the
	// run_start handler — the two reset sites cannot drift).
	let run = newRun(0);

	// Per-request timing for the "tokens per second" figures.
	let requestStartAt: number | undefined;
	let requestModel: string | undefined;
	const rates = {sum: 0, count: 0, min: 0, max: 0};

	// Sub-agents are informational — nested runs report their own token totals, which may or
	// may not already be folded into the parent's usage. Never summed into the session or
	// lifetime totals, only shown.
	//
	// The ledger is keyed by tool call id and holds every sub-agent that has started but not
	// yet been finalized, so that a stop's token count can wait for the sub-agent to actually
	// be done (see finalizeSubagent). subagentRuns / subagentTokens are session-wide (for the
	// report); a run's own sub-agent totals are derived from the ledger at run end.
	let subagentLedger = new Map<string, SubagentRun>();
	let subagentRuns = 0;
	let subagentTokens = 0;

	// Whether any request this session wrote to the prompt cache. Session-scoped, like the
	// sub-agent counters above, and one of the two conditions guarding the cache figure.
	let sawCacheWrite = false;

	let warnedWriteFailure = false;
	let cachedConfig: {mtimeMs: number; value: StateFile} | undefined;

	function readConfigFile(): StateFile {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(CONFIG_PATH).mtimeMs;
		} catch {
			cachedConfig = undefined;
			return {};
		}
		if (cachedConfig?.mtimeMs === mtimeMs) return cachedConfig.value;

		let value: StateFile = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				value = parsed as StateFile;
			}
		} catch {
			// A malformed state file is treated as empty rather than crashing the session —
			// stats are a convenience, never a reason to take the agent down.
			value = {};
		}
		cachedConfig = {mtimeMs, value};
		return value;
	}

	function readRawConfig(): Record<string, unknown> {
		try {
			const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Missing or malformed: start fresh rather than fail the write.
		}
		return {};
	}

	function resolveSettings(): Settings {
		const file = readConfigFile();
		const status = cmd.getFlag('token-stats-status');
		const summary = cmd.getFlag('token-stats-summary');
		const log = cmd.getFlag('token-stats-log');
		return {
			status: typeof status === 'boolean' ? status : file.status !== false,
			summary: typeof summary === 'boolean' ? summary : file.summary === true,
			log: typeof log === 'boolean' ? log : file.log !== false,
		};
	}

	// Rewrite the state file with a patch applied. Reads the raw JSON first so keys this
	// mod does not know about survive, and writes via a temp file + rename so an
	// interrupted write cannot leave a truncated file behind.
	function updateConfigFile(patch: Record<string, unknown>): void {
		const current = readRawConfig();

		let mode = 0o644;
		try {
			mode = statSync(CONFIG_PATH).mode & 0o777;
		} catch {
			// Brand new file — keep the default.
		}

		mkdirSync(dirname(CONFIG_PATH), {recursive: true});
		// The per-model aggregate was dropped, but an older version may have left the key in
		// the file. Delete it from the merged object so every rewrite (a per-run fold or the
		// reset) actually removes it, rather than carrying it forward.
		const merged: Record<string, unknown> = {...current, ...patch};
		delete merged.byModel;
		const temporary = `${CONFIG_PATH}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, {mode});
		renameSync(temporary, CONFIG_PATH);
		cachedConfig = undefined; // take effect at once, without waiting for an mtime change
	}

	// cmd.ui.notify draws a feed row in the interactive TUI but prints nothing at all under
	// `cmd -p`, and print mode is where a write failure still needs to be visible. So: feed
	// row in the TUI, stderr otherwise — never both, so a raw write can't garble the TUI.
	function warn(message: string): void {
		if (cmd.ui?.capabilities?.status === true) {
			cmd.ui.notify(message);
			return;
		}
		process.stderr.write(`\n${message}\n`);
	}

	function warnWriteFailure(error: unknown): void {
		if (warnedWriteFailure) return;
		warnedWriteFailure = true;
		warn(`token-statistics: could not save stats to ${CONFIG_PATH} (${describeError(error)}).`);
	}

	// Two record kinds share the one append-only log: the per-run summary and one line per
	// finalized sub-agent. Both go through here so the write path (and its failure mode) is
	// identical.
	function appendLog(record: RunRecord | SubagentRecord): void {
		mkdirSync(dirname(LOG_PATH), {recursive: true});
		appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`);
	}

	function averageRate(): number {
		return rates.count > 0 ? rates.sum / rates.count : 0;
	}

	// The live footer: the session totals, with the sub-agent cluster appended once one has
	// been counted. A session with no sub-agents stays a single segment.
	function footerText(): string {
		let line = `▲ ${formatTokens(session.input)} in  ▼ ${formatTokens(session.output)} out  ⚡ ${formatRate(averageRate())} tok/s  ⛁ ${percent(session.cacheRead, session.input)}% cached`;
		if (subagentRuns > 0) line += `  ·  sub ${subagentTail()}`;
		return line;
	}

	function refreshStatus(): void {
		if (cmd.ui?.capabilities?.status !== true) return;
		if (!resolveSettings().status) {
			cmd.ui.setStatus(null);
			return;
		}
		cmd.ui.setStatus(footerText());
	}

	function resetSession(): void {
		Object.assign(session, zeros());
		sessionId = undefined;
		// One atomic reset of every run-scoped field; the epoch starts over for the session.
		run = newRun(0);
		requestStartAt = undefined;
		requestModel = undefined;
		rates.sum = 0;
		rates.count = 0;
		rates.min = 0;
		rates.max = 0;
		subagentLedger = new Map();
		subagentRuns = 0;
		subagentTokens = 0;
		sawCacheWrite = false;
	}

	// Look up (or open) the ledger entry for a tool call id. A stop or a completion can
	// arrive without its start; the entry is still harmless — it only ever counts once it
	// has both a token count and a completion signal. An entry opened lazily this way is
	// attributed to the current run.
	function subagentEntry(toolCallId: string, subagentType?: string): SubagentRun {
		let entry = subagentLedger.get(toolCallId);
		if (entry === undefined) {
			entry = {
				toolCallId,
				subagentType,
				background: false,
				agentDone: false,
				tokensUsed: 0,
				trailer: undefined,
				finalized: false,
				runNumber: run.epoch,
			};
			subagentLedger.set(toolCallId, entry);
		}
		if (entry.subagentType === undefined && subagentType !== undefined) entry.subagentType = subagentType;
		return entry;
	}

	// The one mutation point for a ledger entry: a finalized entry is immutable, so a late
	// stop or completion can never rewrite the numbers its committed totals (and its durable
	// record) were built from. Handlers declare only the facts they learned; the invariant
	// lives here. The entry is opened lazily, so an event with no prior subagent_start still
	// records what it knows.
	//
	// `shouldFinalize` separates a fact that could complete the entry (a stop, a tool-call
	// completion, the run-end sweep) from one that never can (a start, which only declares
	// where and how the sub-agent runs). A start that finalized would commit the entry before
	// its token count — or its trailer — had a chance to arrive.
	function updateSubagent(
		toolCallId: string,
		patch: Partial<SubagentRun>,
		subagentType?: string,
		shouldFinalize = false,
	): void {
		const entry = subagentEntry(toolCallId, subagentType);
		if (entry.finalized) return;
		Object.assign(entry, patch);
		if (shouldFinalize) finalizeSubagent(entry);
	}

	// A sub-agent counts exactly once, and only once its tokens are known AND it is known to
	// be done: a background one is done when it stops, a foreground one when its `agent` tool
	// call completes. This is the one place that books an entry into the session totals and
	// writes its durable record; `finalized` latches on the first call, so every later path —
	// a second stop, or the run-end sweep after a normal finalize — is a no-op rather than a
	// double count.
	function finalizeSubagent(entry: SubagentRun): void {
		if (entry.finalized || entry.tokensUsed <= 0) return;
		if (!entry.background && !entry.agentDone) return;
		entry.finalized = true;
		subagentRuns += 1;
		subagentTokens += entry.tokensUsed;
		writeSubagentRecord(entry);
		// The footer now carries the sub-agent cluster, so a finalize has to repaint it —
		// otherwise the cluster would only appear at the next model call or run end.
		refreshStatus();
	}

	// One durable line per finalized sub-agent, alongside the per-run lines. Gated by the
	// same `log` setting as the per-run record, and routed through the same warn-on-failure
	// path so a bad write can never take the session down.
	function writeSubagentRecord(entry: SubagentRun): void {
		if (!resolveSettings().log) return;
		const record: SubagentRecord = {
			ts: new Date().toISOString(),
			kind: 'subagent',
			sessionId,
			toolCallId: entry.toolCallId,
			subagentType: entry.subagentType,
			tokensUsed: entry.tokensUsed,
			// The trailer fields are optional; undefined values are dropped by JSON.stringify,
			// so an unknown one is simply absent rather than null.
			turns: entry.trailer?.turns,
			toolUses: entry.trailer?.toolUses,
			durationMs: entry.trailer?.durationMs,
			totalTokens: entry.trailer?.totalTokens,
		};
		try {
			appendLog(record);
		} catch (error) {
			warnWriteFailure(error);
		}
	}

	// The end of a run is the last chance to account for anything still in the ledger — the
	// run ending is itself a completion signal, so an entry with a token count is booked even
	// if its stop or completion never arrived (an aborted run, or a host that does not emit
	// afterToolCall).
	function sweepSubagents(): void {
		for (const entry of subagentLedger.values()) {
			// Only an entry that already holds a token count is this run's to book. A
			// zero-token entry is left entirely untouched: marking it done would let a *later*
			// stop finalize a foreground sub-agent whose `agent` tool call never completed —
			// something the run ending is not a completion signal for.
			if (entry.tokensUsed <= 0) continue;
			// The run ending is itself a completion signal; updateSubagent keeps the
			// finalized-immutability rule in one place and skips anything already booked.
			updateSubagent(entry.toolCallId, {agentDone: true}, undefined, true);
		}
	}

	// The cache figure on the subagents line. A sub-agent's trailer `total_tokens` is the
	// whole bill for its run and `tokensUsed` is the part the agent itself measured, so the
	// difference is the prompt the parent had already cached. Summed over the finalized
	// sub-agents — the very entries the durable per-sub-agent records are written from, so
	// both numbers stay auditable from the log without new report fields.
	//
	// Only shown when the reading holds everywhere: every finalized sub-agent carries a
	// finite trailer total (a missing one leaves that run unauditable), and no request this
	// session wrote to the cache (a write means a prompt was billed fresh, so the gap is not
	// a cache hit). Otherwise the figure is withheld rather than guessed at.
	function subagentCacheTokens(): number | undefined {
		if (sawCacheWrite) return undefined;
		let cached = 0;
		let documented = 0;
		for (const entry of subagentLedger.values()) {
			if (!entry.finalized) continue;
			const total = entry.trailer?.totalTokens;
			if (total === undefined || !Number.isFinite(total)) continue;
			documented += 1;
			cached += Math.max(0, total - entry.tokensUsed);
		}
		// Every counted run must be one whose record carries a total, or the bound is a bound
		// on an unknown quantity.
		return documented === subagentRuns ? cached : undefined;
	}

	// The sub-agent figures shared by the footer cluster and the /token-stats subagents row:
	// the summed token count, the optional `≥N% cached` bound, and the run count. The footer
	// prefixes it with `sub `; the command row labels it `subagents`.
	function subagentTail(): string {
		const cached = subagentCacheTokens();
		const cache = cached === undefined ? '' : `  ⛁ ≥${percent(cached, subagentTokens)}% cached`;
		return `${formatTokens(subagentTokens)} tok${cache} · ${plural(subagentRuns, 'run')}`;
	}

	// Fold the finished run into the durable aggregates. The per-run log line is written
	// separately (appendLog), so this only touches the small JSON. `genMs` is the run's
	// effective generation time (see finalizeRun), accumulated so /token-stats can report an
	// all-time rate.
	function foldLifetime(genMs: number): void {
		const file = readConfigFile();
		const prior = file.lifetime ?? {};
		const lifetime: Lifetime = {
			input: num(prior.input) + run.totals.input,
			output: num(prior.output) + run.totals.output,
			cacheRead: num(prior.cacheRead) + run.totals.cacheRead,
			cacheWrite: num(prior.cacheWrite) + run.totals.cacheWrite,
			requests: num(prior.requests) + run.totals.requests,
			// foldLifetime only runs for a run that produced tokens, so every call is one run.
			runs: num(prior.runs) + 1,
			genMs: num(prior.genMs) + genMs,
			since: typeof prior.since === 'string' ? prior.since : new Date().toISOString(),
		};

		updateConfigFile({lifetime});
	}

	function finalizeRun(result: unknown): void {
		if (run.reportedEnd) return;
		run.reportedEnd = true;

		// Anything still in the ledger holding a token count is this run's to report.
		sweepSubagents();

		const typed = (result ?? {}) as Record<string, unknown>;
		const stopReason = typeof typed.stopReason === 'string' ? typed.stopReason : 'unknown';

		// The run's own per-request tally is the source of truth. Fall back to the
		// harness-reported usage only when no model_request_end was observed (an
		// interrupted run, or a provider that does not emit it).
		if (run.totals.requests === 0) {
			const fallback = readUsage(typed.usage);
			if (fallback.input + fallback.output > 0) {
				addTotals(run.totals, fallback, 0);
				// Mirror it into the session view too. The run fallback carries no request
				// count (it is not a real request), but the tokens are real and would
				// otherwise be counted by the lifetime totals yet invisible to /token-stats.
				addTotals(session, fallback, 0);
			}
		}

		const wallMs = run.startedAt === undefined ? 0 : Date.now() - run.startedAt;
		const genMs = run.genMs > 0 ? run.genMs : wallMs;
		const outputTokPerSec = genMs > 0 ? round1((run.totals.output / genMs) * 1000) : 0;

		// The run's sub-agent totals are derived here, after the sweep has booked anything
		// still in the ledger: every finalized entry that was launched in this run. A
		// background sub-agent that outlived its run carries an earlier epoch, so a later
		// run can never claim it.
		let subagents = 0;
		let subagentTokenTotal = 0;
		for (const entry of subagentLedger.values()) {
			if (entry.finalized && entry.runNumber === run.epoch) {
				subagents += 1;
				subagentTokenTotal += entry.tokensUsed;
			}
		}

		const record: RunRecord = {
			ts: new Date().toISOString(),
			sessionId,
			cwd: cmd.cwd,
			stopReason,
			input: run.totals.input,
			output: run.totals.output,
			cacheRead: run.totals.cacheRead,
			cacheWrite: run.totals.cacheWrite,
			requests: run.totals.requests,
			models: [...run.models],
			durationMs: wallMs,
			genMs,
			outputTokPerSec,
			subagents,
			subagentTokens: subagentTokenTotal,
		};

		if (run.totals.requests > 0 || run.totals.input + run.totals.output > 0) {
			const settings = resolveSettings();
			if (settings.log) {
				try {
					appendLog(record);
				} catch (error) {
					warnWriteFailure(error);
				}
			}
			try {
				foldLifetime(genMs);
			} catch (error) {
				warnWriteFailure(error);
			}
			if (settings.summary) cmd.showEntry('token-stats', record);
		}

		refreshStatus();
	}

	// ── events ────────────────────────────────────────────────────────────────────────

	cmd.on('run_start', ({sessionId: id} = {}) => {
		// Rebuilding through newRun resets every run-scoped field at once. The bumped epoch
		// makes any sub-agent still in flight from a previous run stale — it must not be
		// attributed to this one.
		run = newRun(run.epoch + 1, Date.now());
		if (typeof id === 'string') sessionId = id;
	});

	cmd.on('model_request_start', ({model} = {}) => {
		requestStartAt = Date.now();
		requestModel = typeof model === 'string' ? model : undefined;
	});

	cmd.on('model_request_end', ({model, usage} = {}) => {
		const parsed = readUsage(usage);
		const modelId = typeof model === 'string' ? model : (requestModel ?? 'unknown');
		const elapsedMs = requestStartAt === undefined ? 0 : Date.now() - requestStartAt;
		requestStartAt = undefined;

		addTotals(session, parsed);
		addTotals(run.totals, parsed);
		run.models.add(modelId);
		run.genMs += elapsedMs;
		if (parsed.cacheWrite > 0) sawCacheWrite = true;

		const seconds = elapsedMs / 1000;
		if (parsed.output > 0 && seconds > 0) {
			const rate = parsed.output / seconds;
			rates.sum += rate;
			rates.count += 1;
			rates.min = rates.count === 1 ? rate : Math.min(rates.min, rate);
			rates.max = Math.max(rates.max, rate);
		}

		refreshStatus();
	});

	cmd.on('subagent_start', ({toolCallId, subagentType, background} = {}) => {
		if (typeof toolCallId !== 'string') return;
		// Declare the facts only: the run the sub-agent was launched in (for attribution when
		// it finalizes), and that a background one outlives the tool call that launched it —
		// so its stop is already its completion signal. A start never finalizes: the entry's
		// token count and its trailer are still to come (and a duplicate/out-of-order start
		// must not commit the entry before them).
		updateSubagent(
			toolCallId,
			{runNumber: run.epoch, background: background === true},
			typeof subagentType === 'string' ? subagentType : undefined,
		);
	});

	cmd.on('subagent_stop', ({toolCallId, subagentType, tokensUsed} = {}) => {
		// A stop with no measured token count is noise, not a run: it must never create an
		// entry, finalize anything, or move a total. (`subagent_progress` carries an
		// estimate and is deliberately never subscribed to, for the same reason.)
		const tokens = num(tokensUsed);
		if (tokens <= 0 || typeof toolCallId !== 'string') return;
		// The finalized-entry immutability rule lives in updateSubagent: a late stop cannot
		// rewrite the count its committed totals (and its durable record) were built from, or
		// the report's cache numerator would drift away from its latched denominator.
		updateSubagent(
			toolCallId,
			{tokensUsed: tokens},
			typeof subagentType === 'string' ? subagentType : undefined,
			true,
		);
	});

	cmd.on('session_start', () => resetSession());
	cmd.on('session_shutdown', () => {
		resetSession();
		if (cmd.ui?.capabilities?.status === true) cmd.ui.setStatus(null);
	});

	// onRunEnd is the awaited hook, so the log write is guaranteed to complete before the
	// process moves on. The run_end observer is a fallback for the rare path where the
	// hook does not fire; finalizeRun's guard keeps the two from double-reporting.
	//
	// Both hooks are registered in one call: the mod must not depend on the host merging
	// successive cmd.hooks calls into one object.
	cmd.hooks({
		onRunEnd: async ({result} = {}) => {
			finalizeRun(result);
		},
		afterToolCall: ({toolCallId, toolName, result} = {}) => {
			// Declare the facts: a foreground sub-agent is done when the `agent` tool call that
			// launched it completes, and its result text carries the usage trailer. Recording
			// the trailer before finalizing lets the durable record include it. A trailer
			// arriving after commit is dropped by updateSubagent — it could only make the
			// report claim a cache figure the durable record cannot support.
			if (toolName !== 'agent' || typeof toolCallId !== 'string') return;
			updateSubagent(toolCallId, {trailer: parseSubagentTrailer(result), agentDone: true}, undefined, true);
		},
	});

	cmd.on('run_end', ({result} = {}) => finalizeRun(result));

	// ── surfaces ──────────────────────────────────────────────────────────────────────

	cmd.addRenderer('token-stats', (data) => {
		const record = data as RunRecord;
		const cache = record.input > 0 ? `  ⛁ ${percent(record.cacheRead, record.input)}%` : '';
		const speed = record.genMs > 0 ? `  ⚡ ${formatRate(record.outputTokPerSec)} tok/s` : '';
		return [
			`◆ tokens  ▲ ${formatTokens(record.input)} ▼ ${formatTokens(record.output)}${cache}${speed}  ${humanDuration(record.genMs)}`,
		];
	});

	cmd.addCommand({
		name: 'token-stats',
		description: 'Lifetime token totals, plus a sub-agent summary line when sub-agents ran',
		handler: ({args}: {args?: unknown} = {}) => {
			const sub = String(args ?? '').trim().toLowerCase();
			if (sub === 'reset') {
				void cmd.ui
					.confirm({
						title: 'Reset lifetime token statistics?',
						message: `This clears the lifetime totals in ${CONFIG_PATH} and the run log. Session stats are not affected.`,
					})
					.then((confirmed) => {
						if (!confirmed) return;
						try {
							updateConfigFile({lifetime: undefined});
							cmd.ui.notify('token-statistics: lifetime totals reset.');
						} catch (error) {
							warn(`token-statistics: could not reset stats (${describeError(error)}).`);
						}
					});
				return {message: 'Confirm the reset in the dialog…'};
			}
			return {message: reportText()};
		},
	});

	// Two labelled lines: the durable lifetime totals, plus a sub-agent summary row when one
	// has been counted this session. The live session totals live in the footer instead.
	function reportText(): string {
		const lifetime = readConfigFile().lifetime;
		// `runs`, not `requests`: a run recovered from the harness fallback carries tokens but
		// no request count, and it still folds into the lifetime totals.
		if (lifetime === undefined || num(lifetime.runs) === 0) {
			return 'no requests recorded yet';
		}
		const lines = [row('lifetime', lifetimeLine(lifetime))];
		if (subagentRuns > 0) lines.push(row('subagents', subagentTail()));
		return lines.join('\n');
	}

	function row(label: string, value: string): string {
		return `${label.padEnd(11)}${value}`;
	}

	// The all-time line: durable totals across every session, with an all-time tok/s read off
	// the accumulated output and generation time.
	function lifetimeLine(lifetime: Partial<Lifetime>): string {
		const output = num(lifetime.output);
		const genMs = num(lifetime.genMs);
		const rate = genMs > 0 ? (output / genMs) * 1000 : 0;
		return `▲ ${formatTokens(num(lifetime.input))} in  ▼ ${formatTokens(output)} out  ⚡ ${formatRate(rate)} tok/s  ⛁ ${percent(num(lifetime.cacheRead), num(lifetime.input))}% cached  ·  ${plural(num(lifetime.runs), 'run')}`;
	}
}
