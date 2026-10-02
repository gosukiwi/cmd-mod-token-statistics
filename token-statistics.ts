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
//   • footer segment (cmd.ui.setStatus) — live session totals, tok/s, context usage
//   • /token-stats                     — full breakdown: session, lifetime, cache, models
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

// Context-window sizes, keyed by the model id the harness reports. Only used to turn the
// last request's prompt size into a percentage; an unknown model degrades to a raw token
// count. Seeded from Command Code's model catalog (models.md) — refresh occasionally.
const CONTEXT_WINDOWS: Record<string, number> = {
	'claude-sonnet-5': 1_000_000,
	'claude-sonnet-4-6': 1_000_000,
	'claude-opus-5-5': 1_000_000,
	'claude-opus-5': 1_000_000,
	'claude-opus-4-8': 1_000_000,
	'claude-opus-4-7': 1_000_000,
	'claude-fable-5-1': 1_000_000,
	'claude-fable-5': 1_000_000,
	'claude-haiku-4-5-20251001': 200_000,
};

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	requests: number;
}

interface Lifetime extends Totals {
	runs: number;
	since: string;
}

interface Settings {
	readonly status: boolean;
	readonly summary: boolean;
	readonly log: boolean;
	readonly contextInStatus: boolean;
}

interface StateFile {
	readonly status?: boolean;
	readonly summary?: boolean;
	readonly log?: boolean;
	readonly contextInStatus?: boolean;
	readonly lifetime?: Partial<Lifetime>;
	readonly byModel?: Record<string, Partial<Totals>>;
}

interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

// One in-flight sub-agent, keyed by the `agent` tool call that launched it. A stop carries
// the token count, but the entry is only finalizable once the sub-agent is known to be done:
// a background one is done when it stops, a foreground one when its tool call completes.
interface SubagentRun {
	subagentType: string | undefined;
	background: boolean;
	agentDone: boolean;
	tokensUsed: number;
	finalized: boolean;
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

function zeros(): Totals {
	return {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0};
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

function projectName(cwd: string): string {
	const parts = cwd.split('/').filter(Boolean);
	return parts.at(-1) ?? cwd;
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
	cmd.addFlag('token-stats-context', {
		type: 'boolean',
		description: 'Include context-window usage in the footer.',
	});

	// Session-scoped state. This is volatile on purpose: the durable totals live in the
	// state file, and the session view is what the footer shows.
	const session = zeros();
	let sessionId: string | undefined;

	// Run-scoped state, reset on every run_start.
	let run = zeros();
	let runByModel = new Map<string, Totals>();
	let runStartedAt: number | undefined;
	let runGenMs = 0;
	let reportedRunEnd = false;

	// Per-request timing for the "tokens per second" figures.
	let requestStartAt: number | undefined;
	let requestModel: string | undefined;
	const rates = {sum: 0, count: 0, min: 0, max: 0};

	// Context usage proxy: the prompt size of the most recent request.
	let lastContextTokens = 0;
	let lastContextModel: string | undefined;

	// Sub-agents are informational — nested runs report their own token totals, which may or
	// may not already be folded into the parent's usage. Never summed into the session or
	// lifetime totals, only shown.
	//
	// The ledger is keyed by tool call id and holds every sub-agent that has started but not
	// yet been finalized, so that a stop's token count can wait for the sub-agent to actually
	// be done (see finalizeSubagent). subagentRuns / subagentTokens are session-wide (for the
	// report); runSubagentRuns / runSubagentTokens are run-scoped (for the log line).
	let subagentLedger = new Map<string, SubagentRun>();
	let subagentRuns = 0;
	let subagentTokens = 0;
	let runSubagentRuns = 0;
	let runSubagentTokens = 0;

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
		const context = cmd.getFlag('token-stats-context');
		return {
			status: typeof status === 'boolean' ? status : file.status !== false,
			summary: typeof summary === 'boolean' ? summary : file.summary === true,
			log: typeof log === 'boolean' ? log : file.log !== false,
			contextInStatus: typeof context === 'boolean' ? context : file.contextInStatus !== false,
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
		const temporary = `${CONFIG_PATH}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({...current, ...patch}, null, 2)}\n`, {mode});
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

	function appendLog(record: RunRecord): void {
		mkdirSync(dirname(LOG_PATH), {recursive: true});
		appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`);
	}

	function readLog(): RunRecord[] {
		let text: string;
		try {
			text = readFileSync(LOG_PATH, 'utf8');
		} catch {
			return [];
		}
		const records: RunRecord[] = [];
		for (const line of text.split('\n')) {
			if (line.trim() === '') continue;
			try {
				records.push(JSON.parse(line) as RunRecord);
			} catch {
				// A torn last line is ignored rather than failing the whole report.
			}
		}
		return records;
	}

	function averageRate(): number {
		return rates.count > 0 ? rates.sum / rates.count : 0;
	}

	function contextWindowFor(model: string | undefined): number | undefined {
		return model === undefined ? undefined : CONTEXT_WINDOWS[model];
	}

	function footerText(): string {
		const settings = resolveSettings();
		const parts = [
			`▲ ${formatTokens(session.input)}`,
			`▼ ${formatTokens(session.output)}`,
			`⚡ ${formatRate(averageRate())} tok/s`,
		];
		if (session.input > 0) parts.push(`⛁ ${percent(session.cacheRead, session.input)}% cached`);
		if (settings.contextInStatus && lastContextTokens > 0) {
			const window = contextWindowFor(lastContextModel);
			parts.push(
				window === undefined
					? `ctx ${formatTokens(lastContextTokens)}`
					: `ctx ${formatTokens(lastContextTokens)}/${formatTokens(window)} (${percent(lastContextTokens, window)}%)`,
			);
		}
		return parts.join('  ');
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
		run = zeros();
		runByModel = new Map();
		runStartedAt = undefined;
		runGenMs = 0;
		reportedRunEnd = false;
		requestStartAt = undefined;
		requestModel = undefined;
		rates.sum = 0;
		rates.count = 0;
		rates.min = 0;
		rates.max = 0;
		lastContextTokens = 0;
		lastContextModel = undefined;
		subagentLedger = new Map();
		subagentRuns = 0;
		subagentTokens = 0;
		runSubagentRuns = 0;
		runSubagentTokens = 0;
	}

	// Look up (or open) the ledger entry for a tool call id. A stop or a completion can
	// arrive without its start; the entry is still harmless — it only ever counts once it
	// has both a token count and a completion signal.
	function subagentEntry(toolCallId: string, subagentType?: string): SubagentRun {
		let entry = subagentLedger.get(toolCallId);
		if (entry === undefined) {
			entry = {subagentType, background: false, agentDone: false, tokensUsed: 0, finalized: false};
			subagentLedger.set(toolCallId, entry);
		}
		if (entry.subagentType === undefined && subagentType !== undefined) entry.subagentType = subagentType;
		return entry;
	}

	// A sub-agent counts exactly once, and only once its tokens are known AND it is known to
	// be done: a background one is done when it stops, a foreground one when its `agent` tool
	// call completes. The `finalized` flag is what makes a second stop — or the run-end sweep
	// after a normal finalize — a no-op rather than a double count.
	function finalizeSubagent(entry: SubagentRun): void {
		if (entry.finalized || entry.tokensUsed <= 0) return;
		if (!entry.background && !entry.agentDone) return;
		commitSubagent(entry);
	}

	// Book the entry into the session and run accumulators. Idempotent: `finalized` latches
	// on the first call, so every later path is a no-op.
	function commitSubagent(entry: SubagentRun): void {
		if (entry.finalized) return;
		entry.finalized = true;
		subagentRuns += 1;
		subagentTokens += entry.tokensUsed;
		runSubagentRuns += 1;
		runSubagentTokens += entry.tokensUsed;
	}

	// The end of a run is the last chance to account for anything still in the ledger — the
	// run ending is itself a completion signal, so an entry with a token count is booked even
	// if its stop or completion never arrived (an aborted run, or a host that does not emit
	// afterToolCall).
	function sweepSubagents(): void {
		for (const entry of subagentLedger.values()) {
			if (entry.tokensUsed > 0) commitSubagent(entry);
		}
	}

	function modelTotals(map: Map<string, Totals>, model: string): Totals {
		let totals = map.get(model);
		if (totals === undefined) {
			totals = zeros();
			map.set(model, totals);
		}
		return totals;
	}

	// Fold the finished run into the durable aggregates. The per-run log line is written
	// separately (appendLog), so this only touches the small JSON.
	function foldLifetime(): void {
		const file = readConfigFile();
		const prior = file.lifetime ?? {};
		const lifetime: Lifetime = {
			input: num(prior.input) + run.input,
			output: num(prior.output) + run.output,
			cacheRead: num(prior.cacheRead) + run.cacheRead,
			cacheWrite: num(prior.cacheWrite) + run.cacheWrite,
			requests: num(prior.requests) + run.requests,
			// foldLifetime only runs for a run that produced tokens, so every call is one run.
			runs: num(prior.runs) + 1,
			since: typeof prior.since === 'string' ? prior.since : new Date().toISOString(),
		};

		const byModel: Record<string, Partial<Totals>> = {...(file.byModel ?? {})};
		for (const [model, totals] of runByModel) {
			const existing = byModel[model] ?? {};
			byModel[model] = {
				input: num(existing.input) + totals.input,
				output: num(existing.output) + totals.output,
				cacheRead: num(existing.cacheRead) + totals.cacheRead,
				cacheWrite: num(existing.cacheWrite) + totals.cacheWrite,
				requests: num(existing.requests) + totals.requests,
			};
		}

		updateConfigFile({lifetime, byModel});
	}

	function finalizeRun(result: unknown): void {
		if (reportedRunEnd) return;
		reportedRunEnd = true;

		// Anything still in the ledger holding a token count is this run's to report.
		sweepSubagents();

		const typed = (result ?? {}) as Record<string, unknown>;
		const stopReason = typeof typed.stopReason === 'string' ? typed.stopReason : 'unknown';

		// The run's own per-request tally is the source of truth. Fall back to the
		// harness-reported usage only when no model_request_end was observed (an
		// interrupted run, or a provider that does not emit it).
		if (run.requests === 0) {
			const fallback = readUsage(typed.usage);
			if (fallback.input + fallback.output > 0) addTotals(run, fallback, 0);
		}

		const wallMs = runStartedAt === undefined ? 0 : Date.now() - runStartedAt;
		const genMs = runGenMs > 0 ? runGenMs : wallMs;
		const outputTokPerSec = genMs > 0 ? round1((run.output / genMs) * 1000) : 0;

		const record: RunRecord = {
			ts: new Date().toISOString(),
			sessionId,
			cwd: cmd.cwd,
			stopReason,
			input: run.input,
			output: run.output,
			cacheRead: run.cacheRead,
			cacheWrite: run.cacheWrite,
			requests: run.requests,
			models: [...runByModel.keys()],
			durationMs: wallMs,
			genMs,
			outputTokPerSec,
			subagents: runSubagentRuns,
			subagentTokens: runSubagentTokens,
		};

		if (run.requests > 0 || run.input + run.output > 0) {
			const settings = resolveSettings();
			if (settings.log) {
				try {
					appendLog(record);
				} catch (error) {
					warnWriteFailure(error);
				}
			}
			try {
				foldLifetime();
			} catch (error) {
				warnWriteFailure(error);
			}
			if (settings.summary) cmd.showEntry('token-stats', record);
		}

		refreshStatus();
	}

	// ── events ────────────────────────────────────────────────────────────────────────

	cmd.on('run_start', ({sessionId: id} = {}) => {
		run = zeros();
		runByModel = new Map();
		runStartedAt = Date.now();
		runGenMs = 0;
		runSubagentRuns = 0;
		runSubagentTokens = 0;
		reportedRunEnd = false;
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
		addTotals(run, parsed);
		addTotals(modelTotals(runByModel, modelId), parsed);
		runGenMs += elapsedMs;

		const seconds = elapsedMs / 1000;
		if (parsed.output > 0 && seconds > 0) {
			const rate = parsed.output / seconds;
			rates.sum += rate;
			rates.count += 1;
			rates.min = rates.count === 1 ? rate : Math.min(rates.min, rate);
			rates.max = Math.max(rates.max, rate);
		}

		if (parsed.input > 0) {
			lastContextTokens = parsed.input;
			lastContextModel = modelId;
		}

		refreshStatus();
	});

	cmd.on('subagent_start', ({toolCallId, subagentType, background} = {}) => {
		if (typeof toolCallId !== 'string') return;
		const entry = subagentEntry(toolCallId, typeof subagentType === 'string' ? subagentType : undefined);
		// A background sub-agent outlives the tool call that launched it, so its stop is
		// already its completion signal.
		entry.background = background === true;
	});

	cmd.on('subagent_stop', ({toolCallId, subagentType, tokensUsed} = {}) => {
		// A stop with no measured token count is noise, not a run: it must never create an
		// entry, finalize anything, or move a total. (`subagent_progress` carries an
		// estimate and is deliberately never subscribed to, for the same reason.)
		const tokens = num(tokensUsed);
		if (tokens <= 0 || typeof toolCallId !== 'string') return;
		const entry = subagentEntry(toolCallId, typeof subagentType === 'string' ? subagentType : undefined);
		entry.tokensUsed = tokens;
		finalizeSubagent(entry);
	});

	cmd.on('session_start', () => resetSession());
	cmd.on('session_shutdown', () => {
		resetSession();
		if (cmd.ui?.capabilities?.status === true) cmd.ui.setStatus(null);
	});

	// onRunEnd is the awaited hook, so the log write is guaranteed to complete before the
	// process moves on. The run_end observer is a fallback for the rare path where the
	// hook does not fire; finalizeRun's guard keeps the two from double-reporting.
	cmd.hooks({
		onRunEnd: async ({result} = {}) => {
			finalizeRun(result);
		},
	});

	cmd.hooks({
		afterToolCall: ({toolCallId, toolName} = {}) => {
			// A foreground sub-agent is done when the `agent` tool call that launched it
			// completes. The result is not needed for the accounting (a later change parses
			// it), only the fact that the call is over.
			if (toolName !== 'agent' || typeof toolCallId !== 'string') return;
			const entry = subagentEntry(toolCallId);
			entry.agentDone = true;
			finalizeSubagent(entry);
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
		description: 'Show token statistics — session, lifetime, cache hits and tokens/sec',
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
							updateConfigFile({lifetime: undefined, byModel: {}});
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

	function reportText(): string {
		const file = readConfigFile();
		const lifetime = file.lifetime;
		const byModel = file.byModel ?? {};
		const log = readLog();
		const lines: string[] = [
			`Token statistics · ${projectName(cmd.cwd)}`,
			row('session', sessionLine()),
			row('lifetime', lifetimeLine(lifetime)),
			row('speed', speedLine()),
			row('context', contextLine()),
			row('models', modelLines(byModel)),
		];
		if (subagentRuns > 0) {
			lines.push(row('subagents', `${plural(subagentRuns, 'run')} · ${formatTokens(subagentTokens)} tokens`));
		}
		lines.push(row('log', `${LOG_PATH} · ${plural(log.length, 'record')}`));
		return lines.join('\n');
	}

	function row(label: string, value: string): string {
		return `  ${label.padEnd(10)}${value}`;
	}

	function sessionLine(): string {
		if (session.requests === 0) return 'no requests recorded yet this session';
		return `${totalsLine(session)}  ·  ${plural(session.requests, 'request')}`;
	}

	function lifetimeLine(lifetime: Partial<Lifetime> | undefined): string {
		if (lifetime === undefined || num(lifetime.requests) === 0) return 'nothing recorded yet';
		return `${totalsLine(lifetime)}  ·  ${plural(num(lifetime.runs), 'run')} since ${shortDate(lifetime.since)}`;
	}

	function speedLine(): string {
		if (rates.count === 0) return 'no timings yet';
		const base = `avg ${formatRate(averageRate())} tok/s`;
		if (rates.count === 1) return `${base}  ·  over 1 request`;
		return `${base}  ·  range ${formatRate(rates.min)}–${formatRate(rates.max)}  ·  over ${plural(rates.count, 'request')}`;
	}

	function contextLine(): string {
		if (lastContextTokens === 0) return 'not measured yet';
		const window = contextWindowFor(lastContextModel);
		const suffix = lastContextModel === undefined ? '' : `  ·  ${lastContextModel}`;
		return window === undefined
			? `${formatTokens(lastContextTokens)} tokens (window unknown)${suffix}`
			: `${formatTokens(lastContextTokens)} / ${formatTokens(window)} (${percent(lastContextTokens, window)}%)${suffix}`;
	}

	function modelLines(byModel: Record<string, Partial<Totals>>): string {
		const entries = Object.entries(byModel)
			.map(([model, totals]) => ({model, totals}))
			.filter((entry) => num(entry.totals.requests) > 0)
			.sort((a, b) => num(b.totals.input) + num(b.totals.output) - (num(a.totals.input) + num(a.totals.output)))
			.slice(0, 5);

		if (entries.length === 0) return 'nothing recorded yet';
		return entries
			.map(
				({model, totals}) =>
					`${model}  ▲ ${formatTokens(num(totals.input))} ▼ ${formatTokens(num(totals.output))}  (${plural(num(totals.requests), 'request')})`,
			)
			.join('\n            ');
	}

	function totalsLine(totals: Pick<Totals, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): string {
		const cache = `⛁ ${percent(totals.cacheRead, totals.input)}% cached`;
		const write = totals.cacheWrite > 0 ? ` (${formatTokens(totals.cacheWrite)} written)` : '';
		return `▲ ${formatTokens(totals.input)} in  ▼ ${formatTokens(totals.output)} out  ${cache}${write}`;
	}

	function shortDate(value: unknown): string {
		if (typeof value !== 'string') return 'unknown';
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
	}
}
