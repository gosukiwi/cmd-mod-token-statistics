// Unit tests for the token-statistics mod.
//
// These drive the real mod factory against a fake ModApi, so they exercise the actual
// event wiring, accumulation maths and report formatting rather than a reimplementation
// of it. Nothing touches the network and nothing is spawned.
//
// The mod resolves its state files from $HOME at import time, so this file points HOME at
// a throwaway directory BEFORE importing it — without that, tests would read and rewrite
// the developer's real ~/.commandcode/token-statistics.json.

import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'token-statistics-sandbox-'));
process.env.HOME = SANDBOX_HOME;
process.on('exit', () => rmSync(SANDBOX_HOME, {recursive: true, force: true}));

const {default: createMod} = await import('../token-statistics.ts');

const STATE_DIR = join(SANDBOX_HOME, '.commandcode');
const CONFIG = join(STATE_DIR, 'token-statistics.json');
const LOG = join(STATE_DIR, 'token-statistics.log.jsonl');

beforeEach(() => {
	rmSync(CONFIG, {force: true});
	rmSync(LOG, {force: true});
});

interface FakeMod {
	cmd: any;
	commands: Map<string, (args?: any) => any>;
	declaredFlags: Map<string, any>;
	events: Set<string>;
	notices: string[];
	statuses: (string | null)[];
	entries: {type: string; data: any}[];
	renderers: Map<string, (data: any) => readonly string[]>;
	emit: (event: string, payload?: any) => void;
	hook: (name: string, arg?: any) => any;
}

function makeFakeCmd(
	options: {flags?: Record<string, any>; cwd?: string; statusCapability?: boolean; confirm?: boolean} = {},
): FakeMod {
	const handlers = new Map<string, ((payload: any) => void)[]>();
	const commands = new Map<string, (args?: any) => any>();
	const declaredFlags = new Map<string, any>();
	const events = new Set<string>();
	const notices: string[] = [];
	const statuses: (string | null)[] = [];
	const entries: {type: string; data: any}[] = [];
	const renderers = new Map<string, (data: any) => readonly string[]>();
	const registeredHooks: any[] = [];
	const flags = new Map<string, any>(Object.entries(options.flags ?? {}));
	const confirmAnswer = options.confirm ?? false;

	const cmd: any = {
		name: 'token-statistics',
		cwd: options.cwd ?? '/Users/dev/projects/my-app',
		ui: {
			notify: (message: string) => notices.push(message),
			// Stands in for the interactive TUI footer; the mod writes here and the test
			// reads the last value back.
			setStatus: (text: string | null) => {
				statuses.push(text);
				return {dispose: () => {}};
			},
			confirm: async () => confirmAnswer,
			capabilities: {status: options.statusCapability ?? true},
		},
		hooks: (hooks: any) => {
			registeredHooks.push(hooks);
			return {dispose: () => {}};
		},
		on: (event: string, handler: (payload: any) => void) => {
			events.add(event);
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		addFlag: (name: string, definition: any) => declaredFlags.set(name, definition),
		getFlag: (name: string) => flags.get(name),
		addCommand: ({name, handler}: {name: string; handler: (args?: any) => any}) =>
			commands.set(name, handler),
		addRenderer: (type: string, render: any) => renderers.set(type, render),
		showEntry: (type: string, data: any) => entries.push({type, data}),
	};

	return {
		cmd,
		commands,
		declaredFlags,
		events,
		notices,
		statuses,
		entries,
		renderers,
		emit: (event, payload) => {
			for (const handler of handlers.get(event) ?? []) handler(payload);
		},
		hook: (name, arg) => {
			let result: any;
			for (const hooks of registeredHooks) {
				if (typeof hooks[name] === 'function') result = hooks[name](arg);
			}
			return result;
		},
	};
}

function setup(options: Parameters<typeof makeFakeCmd>[0] = {}): FakeMod {
	const fake = makeFakeCmd(options);
	createMod(fake.cmd);
	return fake;
}

// The flat, CLI-normalized usage object the harness hands to mods.
function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): any {
	return {inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite};
}

function useFakeTimers(t: any): void {
	// Start at a realistic wall clock; mocking from 0 would make the first request look
	// instantaneous and produce no tok/s sample.
	t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
}

function statusLine(fake: FakeMod): string {
	const latest = fake.statuses.at(-1);
	return typeof latest === 'string' ? latest : '';
}

function readState(): any {
	try {
		return JSON.parse(readFileSync(CONFIG, 'utf8'));
	} catch {
		return undefined;
	}
}

function readLogLines(): any[] {
	try {
		return readFileSync(LOG, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

// The durable log holds two record kinds: the per-run summary and one line per finalized
// sub-agent. These pick one kind out of the interleaved stream.
function runRecords(): any[] {
	return readLogLines().filter((record) => record.kind !== 'subagent');
}

function subagentRecords(): any[] {
	return readLogLines().filter((record) => record.kind === 'subagent');
}

function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

// One inference call: bracket a model_request_start / end pair around a tick.
function modelCall(fake: FakeMod, t: any, model: string, tokens: any, ms: number): void {
	fake.emit('model_request_start', {model});
	t.mock.timers.tick(ms);
	fake.emit('model_request_end', {model, usage: tokens, stopReason: 'end_turn'});
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('registers the flags, command, renderer and events it documents', () => {
	const fake = setup();

	for (const flag of ['token-stats-status', 'token-stats-summary', 'token-stats-log', 'token-stats-context']) {
		assert.ok(fake.declaredFlags.has(flag), `missing flag ${flag}`);
	}
	// The boolean flags must NOT declare a default, or a config file value could never win.
	for (const flag of ['token-stats-status', 'token-stats-summary', 'token-stats-log', 'token-stats-context']) {
		assert.equal(fake.declaredFlags.get(flag).default, undefined);
	}

	assert.ok(fake.commands.has('token-stats'), 'missing /token-stats');
	assert.ok(fake.renderers.has('token-stats'), 'missing the per-run renderer');

	for (const event of [
		'run_start',
		'model_request_start',
		'model_request_end',
		'subagent_start',
		'subagent_stop',
		'session_start',
		'session_shutdown',
		'run_end',
	]) {
		assert.ok(fake.events.has(event), `missing event subscription ${event}`);
	}
	// subagent_progress carries an estimate, not a measurement — it must never be read.
	assert.equal(fake.events.has('subagent_progress'), false, 'subagent_progress must not be subscribed');
});

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

test('the footer shows session totals, cache hit rate and tok/s', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'claude-sonnet-5', usage(20_000, 38, 12_400, 800), 1000);

	const line = statusLine(fake);
	assert.match(line, /▲ 20k/);
	assert.match(line, /▼ 38/);
	assert.match(line, /62% cached/);
	assert.match(line, /38 tok\/s/);
	// 20k of a 1M window is 2%.
	assert.match(line, /ctx 20k\/1M \(2%\)/);
});

test('tok/s is measured from the request wall-clock', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('model_request_start', {model: 'm'});
	t.mock.timers.tick(2000);
	fake.emit('model_request_end', {model: 'm', usage: usage(100, 100)});

	assert.match(statusLine(fake), /50 tok\/s/);
});

test('an unknown model degrades to a context token count with no percentage', (t) => {
	useFakeTimers(t);
	const fake = setup();

	modelCall(fake, t, 'some-new-model', usage(20_000, 5), 1000);

	assert.match(statusLine(fake), /ctx 20k(?!\/)/);
});

test('no footer is written when the host has no status surface', (t) => {
	useFakeTimers(t);
	const fake = setup({statusCapability: false});

	modelCall(fake, t, 'm', usage(10, 5), 100);

	assert.deepEqual(fake.statuses, []);
});

test('the config file can hide the footer, and a flag overrides it', (t) => {
	useFakeTimers(t);
	mkdirSync(STATE_DIR, {recursive: true});
	writeFileSync(CONFIG, JSON.stringify({status: false}));

	const hidden = setup();
	modelCall(hidden, t, 'm', usage(10, 5), 100);
	assert.deepEqual(hidden.statuses, [null], 'a disabled footer is cleared, not rendered');

	const forced = setup({flags: {'token-stats-status': true}});
	modelCall(forced, t, 'm', usage(10, 5), 100);
	assert.match(statusLine(forced), /▲ 10/);
});

test('session_shutdown clears the footer', (t) => {
	useFakeTimers(t);
	const fake = setup();

	modelCall(fake, t, 'm', usage(10, 5), 100);
	fake.emit('session_shutdown', {reason: 'shutdown'});

	assert.equal(fake.statuses.at(-1), null);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('a finished run appends a log line and folds into the lifetime totals', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'claude-sonnet-5', usage(20_000, 38, 12_400, 800), 1000);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const lines = readLogLines();
	assert.equal(lines.length, 1);
	assert.equal(lines[0].output, 38);
	assert.equal(lines[0].input, 20_000);
	assert.equal(lines[0].requests, 1);
	assert.equal(lines[0].stopReason, 'end_turn');
	assert.equal(lines[0].sessionId, 's1');
	assert.equal(lines[0].cwd, '/Users/dev/projects/my-app');
	assert.deepEqual(lines[0].models, ['claude-sonnet-5']);
	assert.equal(typeof lines[0].outputTokPerSec, 'number');

	const state = readState();
	assert.equal(state.lifetime.input, 20_000);
	assert.equal(state.lifetime.cacheRead, 12_400);
	assert.equal(state.lifetime.runs, 1);
	assert.equal(state.byModel['claude-sonnet-5'].output, 38);
});

test('lifetime totals persist across sessions', async (t) => {
	useFakeTimers(t);

	const first = setup();
	first.emit('run_start', {sessionId: 's1'});
	modelCall(first, t, 'm', usage(1000, 100), 1000);
	await first.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	// A fresh mod instance in the same HOME stands in for the next session.
	const second = setup();
	second.emit('run_start', {sessionId: 's2'});
	modelCall(second, t, 'm', usage(500, 50), 1000);
	await second.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const state = readState();
	assert.equal(state.lifetime.runs, 2);
	assert.equal(state.lifetime.input, 1500);
	assert.equal(state.lifetime.output, 150);
	assert.equal(readLogLines().length, 2);
});

test('onRunEnd and run_end never double-count one run', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(10, 5), 100);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	fake.emit('run_end', {result: {stopReason: 'end_turn'}});

	assert.equal(readLogLines().length, 1);
	assert.equal(readState().lifetime.runs, 1);
});

test('a run with no model_request_end falls back to the harness usage', async (t) => {
	const fake = setup();
	fake.emit('run_start', {sessionId: 's1'});

	await fake.hook('onRunEnd', {result: {stopReason: 'interrupted', usage: usage(300, 20)}});

	const lines = readLogLines();
	assert.equal(lines.length, 1);
	assert.equal(lines[0].input, 300);
	assert.equal(lines[0].output, 20);
	assert.equal(lines[0].stopReason, 'interrupted');
	assert.equal(readState().lifetime.input, 300);
});

test('a corrupt state file is ignored rather than crashing the run', async (t) => {
	useFakeTimers(t);
	mkdirSync(STATE_DIR, {recursive: true});
	writeFileSync(CONFIG, '{ not valid json');

	const fake = setup();
	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(10, 5), 100);

	await assert.doesNotReject(() => fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}}));
	assert.equal(readLogLines().length, 1);
	assert.equal(readState().lifetime.input, 10);
});

// ---------------------------------------------------------------------------
// Defensive usage parsing
// ---------------------------------------------------------------------------

test('a usage object missing its fields is treated as zeros', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	fake.emit('model_request_start', {model: 'm'});
	fake.emit('model_request_end', {model: 'm', usage: {}});
	fake.emit('model_request_end', {});

	assert.match(statusLine(fake), /▲ 0/);
});

test('the nested AI SDK usage shape is understood too', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('model_request_start', {model: 'm'});
	t.mock.timers.tick(1000);
	fake.emit('model_request_end', {
		model: 'm',
		usage: {inputTokens: 100, outputTokens: 10, inputTokenDetails: {cacheReadTokens: 80, cacheWriteTokens: 5}},
	});

	assert.match(statusLine(fake), /80% cached/);
});

// ---------------------------------------------------------------------------
// Sub-agents (informational only)
// ---------------------------------------------------------------------------

// A sub-agent is launched by an `agent` tool call, so its ledger is keyed by tool call id.
function startSubagent(fake: FakeMod, payload: Record<string, unknown>): void {
	fake.emit('subagent_start', {description: 'do a thing', background: false, showOutput: false, ...payload});
}

function stopSubagent(fake: FakeMod, payload: Record<string, unknown>): void {
	fake.emit('subagent_stop', {status: 'ok', ...payload});
}

// The `agent` tool call that launched a sub-agent has finished.
function finishAgentCall(fake: FakeMod, toolCallId: string, toolName = 'agent'): void {
	fake.hook('afterToolCall', {toolCallId, toolName, result: 'anything'});
}

// The same completion, but with a specific result — the `agent` tool's result text carries
// a `<usage>` trailer that the mod parses.
function finishAgentCallWithResult(fake: FakeMod, toolCallId: string, result: unknown, toolName = 'agent'): void {
	fake.hook('afterToolCall', {toolCallId, toolName, result});
}

// The real trailer shape, verbatim from the `agent` tool.
const USAGE_TRAILER =
	'Investigated the module.\n<usage>total_tokens: 1256306\ntool_uses: 63\nturns: 19\nduration_ms: 117189</usage>';

function report(fake: FakeMod): string {
	return fake.commands.get('token-stats')!().message;
}

test('sub-agent tokens are shown but never folded into the totals', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCall(fake, 'call-1');
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const record = runRecords()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 4200);
	// Shown, never summed: lifetime input is only the parent call's 100.
	assert.equal(readState().lifetime.input, 100);
	assert.equal(readState().lifetime.output, 10);

	assert.match(report(fake), /subagents/);
	assert.match(report(fake), /4\.2k tok · 1 run/);
});

test('a foreground sub-agent finalizes only when its agent tool call completes', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});

	assert.doesNotMatch(report(fake), /subagents/, 'not final before the agent tool call finishes');

	// Some other tool finishing must not finalize it.
	finishAgentCall(fake, 'call-1', 'read');
	assert.doesNotMatch(report(fake), /subagents/);

	finishAgentCall(fake, 'call-1');
	assert.match(report(fake), /subagents/);
	assert.match(report(fake), /4\.2k tok · 1 run/);
});

test('a background sub-agent finalizes on its stop, with no agent tool call', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', tokensUsed: 1000});

	assert.match(report(fake), /subagents/);
	assert.match(report(fake), /1k tok · 1 run/);

	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	const record = runRecords()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 1000);
});

test('a stop with no usable token count is ignored entirely', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 0});
	// Stops with no count, a bogus count, or no start at all must not create a run.
	stopSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', tokensUsed: Number.NaN});
	stopSubagent(fake, {toolCallId: 'call-3', subagentType: 'explore', tokensUsed: '1200'});
	stopSubagent(fake, {toolCallId: 'call-4', subagentType: 'explore'});
	finishAgentCall(fake, 'call-1');
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	assert.doesNotMatch(report(fake), /subagents/);
	const record = runRecords()[0];
	assert.equal(record.subagents, 0);
	assert.equal(record.subagentTokens, 0);
	// Nothing was finalized, so no per-sub-agent record was written either.
	assert.equal(subagentRecords().length, 0);
});

test('the run-end sweep finalizes a foreground sub-agent that never completed', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	assert.doesNotMatch(report(fake), /subagents/);

	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const record = runRecords()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 4200);
	assert.equal(subagentRecords().length, 1, 'the swept sub-agent still gets its own record');
});

test('finalization is idempotent', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	// A repeated stop, the run-end sweep and a late tool-call completion must all no-op.
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	fake.emit('run_end', {result: {stopReason: 'end_turn'}});
	finishAgentCall(fake, 'call-1');

	// A repeated stop, the run-end sweep and a late tool-call completion must all no-op —
	// including the durable per-sub-agent record, which lands exactly once.
	assert.equal(runRecords().length, 1);
	assert.equal(subagentRecords().length, 1);
	const record = runRecords()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 4200);
	assert.match(report(fake), /4\.2k tok · 1 run/);
});

test('the per-run sub-agent count does not leak into the next run', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'explore', tokensUsed: 4200});
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const lines = runRecords();
	assert.equal(lines[0].subagents, 1);
	assert.equal(lines[0].subagentTokens, 4200);
	assert.equal(lines[1].subagents, 0);
	assert.equal(lines[1].subagentTokens, 0);
});

test('subagent_progress is never subscribed or summed', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	// The progress stream carries an estimate; it must not reach any total or counter.
	fake.emit('subagent_progress', {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 50_000});

	assert.doesNotMatch(report(fake), /subagents/);
	assert.match(report(fake), /▲ 100 in/);
});

test('a new session starts with no sub-agent activity to report', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'explore', tokensUsed: 4200});
	assert.match(report(fake), /subagents/);

	fake.emit('session_start', {sessionId: 's2'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	assert.doesNotMatch(report(fake), /subagents/);
});

// ---------------------------------------------------------------------------
// Per-sub-agent durable log record
// ---------------------------------------------------------------------------

test('a finalized sub-agent appends one durable record with its parsed usage trailer', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 667762});
	finishAgentCallWithResult(fake, 'call-1', USAGE_TRAILER);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const records = subagentRecords();
	assert.equal(records.length, 1);
	const [record] = records;
	// Key order is part of the contract.
	assert.deepEqual(Object.keys(record), [
		'ts',
		'kind',
		'sessionId',
		'toolCallId',
		'subagentType',
		'tokensUsed',
		'turns',
		'toolUses',
		'durationMs',
		'totalTokens',
	]);
	assert.equal(typeof record.ts, 'string');
	assert.equal(record.kind, 'subagent');
	assert.equal(record.sessionId, 's1');
	assert.equal(record.toolCallId, 'call-1');
	assert.equal(record.subagentType, 'explore');
	assert.equal(record.tokensUsed, 667762);
	assert.equal(record.turns, 19);
	assert.equal(record.toolUses, 63);
	assert.equal(record.durationMs, 117189);
	assert.equal(record.totalTokens, 1256306);
});

test('the per-run record keeps its subagent fields alongside the subagent record', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 667762});
	finishAgentCallWithResult(fake, 'call-1', USAGE_TRAILER);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const [run] = runRecords();
	assert.equal(run.subagents, 1);
	assert.equal(run.subagentTokens, 667762);
	assert.equal(run.kind, undefined, 'the per-run line is unchanged — no kind field');
	assert.equal(subagentRecords().length, 1);
});

test('a missing usage trailer leaves the extra fields off the record', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCallWithResult(fake, 'call-1', 'done, nothing to report here');
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const [record] = subagentRecords();
	assert.deepEqual(Object.keys(record), [
		'ts',
		'kind',
		'sessionId',
		'toolCallId',
		'subagentType',
		'tokensUsed',
	]);
	assert.equal(record.tokensUsed, 4200);
});

test('a trailer with a missing or non-numeric key keeps only the known fields', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCallWithResult(fake, 'call-1', '<usage>total_tokens: not-a-number\nturns: 19</usage>');
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const [record] = subagentRecords();
	assert.deepEqual(Object.keys(record), [
		'ts',
		'kind',
		'sessionId',
		'toolCallId',
		'subagentType',
		'tokensUsed',
		'turns',
	]);
	assert.equal(record.turns, 19);
	assert.equal(record.totalTokens, undefined);
});

test('a non-string agent result is tolerated and carries no trailer', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	assert.doesNotThrow(() =>
		finishAgentCallWithResult(fake, 'call-1', {not: 'a string with a trailer'}),
	);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const [record] = subagentRecords();
	assert.deepEqual(Object.keys(record), [
		'ts',
		'kind',
		'sessionId',
		'toolCallId',
		'subagentType',
		'tokensUsed',
	]);
	assert.equal(record.tokensUsed, 4200);
});

test('a background sub-agent logs on its stop, before any trailer is known', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', tokensUsed: 1000});

	// The record lands at stop time, while the run is still going, with no trailer yet.
	const [record] = subagentRecords();
	assert.ok(record, 'the stop alone is enough to write the record');
	assert.equal(record.toolCallId, 'bg-1');
	assert.equal(record.subagentType, 'review');
	assert.equal(record.tokensUsed, 1000);
	assert.deepEqual(Object.keys(record), [
		'ts',
		'kind',
		'sessionId',
		'toolCallId',
		'subagentType',
		'tokensUsed',
	]);
});

test('the log setting suppresses per-sub-agent records too', async (t) => {
	useFakeTimers(t);
	const fake = setup({flags: {'token-stats-log': false}});

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCallWithResult(fake, 'call-1', USAGE_TRAILER);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	assert.deepEqual(readLogLines(), [], 'the whole log stays empty when logging is off');
});

test('a failed sub-agent log write warns without crashing the finalize', async (t) => {
	useFakeTimers(t);
	// Put a directory where the log file belongs, so every append throws.
	mkdirSync(LOG, {recursive: true});
	t.after(() => rmSync(LOG, {recursive: true, force: true}));
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});

	assert.doesNotThrow(() => finishAgentCallWithResult(fake, 'call-1', USAGE_TRAILER));
	assert.ok(
		fake.notices.some((notice) => /could not save/.test(notice)),
		'the write failure goes through the existing warn path',
	);
	// The run still reports its own totals despite the failed log write.
	await assert.doesNotReject(() => fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}}));
	assert.match(report(fake), /subagents/);
});

// ---------------------------------------------------------------------------
// Per-run feed row
// ---------------------------------------------------------------------------

test('the per-run summary row is printed only when enabled', async (t) => {
	useFakeTimers(t);

	const quiet = setup();
	quiet.emit('run_start', {sessionId: 's1'});
	modelCall(quiet, t, 'claude-sonnet-5', usage(20_000, 38, 12_400), 1000);
	await quiet.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	assert.equal(quiet.entries.length, 0, 'the row is off by default');

	const loud = setup({flags: {'token-stats-summary': true}});
	loud.emit('run_start', {sessionId: 's1'});
	modelCall(loud, t, 'claude-sonnet-5', usage(20_000, 38, 12_400), 1000);
	await loud.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	assert.equal(loud.entries.length, 1);
	assert.equal(loud.entries[0].type, 'token-stats');
	const rendered = loud.renderers.get('token-stats')!(loud.entries[0].data);
	assert.match(rendered[0], /▲ 20k ▼ 38/);
	assert.match(rendered[0], /62%/);
	assert.match(rendered[0], /38 tok\/s/);
});

// ---------------------------------------------------------------------------
// /token-stats
// ---------------------------------------------------------------------------

test('/token-stats prints exactly one session line, and no lifetime, models or log rows', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'claude-sonnet-5', usage(20_000, 38, 12_400, 800), 1000);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const message = fake.commands.get('token-stats')!().message;
	// One line, no header, and neither the `(N written)` nor the `· N requests` suffix.
	assert.equal(message, '  session   ▲ 20k in  ▼ 38 out  ⚡ 38 tok/s  ⛁ 62% cached');
});

test('/token-stats adds a subagents line once a sub-agent has been counted', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'claude-sonnet-5', usage(20_000, 38, 12_400, 800), 1000);
	assert.equal(
		fake.commands.get('token-stats')!().message.split('\n').length,
		1,
		'no subagents line before any sub-agent is counted',
	);

	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCall(fake, 'call-1');

	const message = fake.commands.get('token-stats')!().message;
	assert.equal(
		message,
		['  session   ▲ 20k in  ▼ 38 out  ⚡ 38 tok/s  ⛁ 62% cached', '  subagents 4.2k tok · 1 run'].join('\n'),
	);
});

test('/token-stats says so when nothing has been recorded', () => {
	const fake = setup();
	const message = fake.commands.get('token-stats')!().message;
	assert.equal(message, 'no requests recorded yet this session');
});

test('/token-stats reset clears the lifetime only after confirmation', async (t) => {
	useFakeTimers(t);

	const declined = setup({confirm: false});
	declined.emit('run_start', {sessionId: 's1'});
	modelCall(declined, t, 'm', usage(100, 10), 100);
	await declined.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	declined.commands.get('token-stats')!({args: 'reset'});
	await settle();
	assert.ok(readState().lifetime, 'declining must leave the totals alone');

	const confirmed = setup({confirm: true});
	confirmed.emit('run_start', {sessionId: 's2'});
	modelCall(confirmed, t, 'm', usage(100, 10), 100);
	await confirmed.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const result = confirmed.commands.get('token-stats')!({args: 'reset'});
	assert.match(result.message, /Confirm/);
	await settle();

	assert.equal(readState().lifetime, undefined);
	assert.deepEqual(readState().byModel, {});
	assert.match(confirmed.notices.at(-1)!, /reset/i);
});

// ---------------------------------------------------------------------------
// Subagent cache figure
// ---------------------------------------------------------------------------

// The subagents line of /token-stats — the second line, present once a sub-agent counts.
function subagentLine(fake: FakeMod): string {
	return report(fake).split('\n')[1] ?? '';
}

// A sub-agent whose trailer total exceeds what it spent: the difference is the prompt
// served from cache, and the only way the mod can see it.
const CACHED_TRAILER = '<usage>total_tokens: 1250000\n turns: 19</usage>';

test('the subagents line shows the cache figure when every trailer total is known', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);

	assert.equal(subagentLine(fake), '  subagents 1M tok  ⛁ ≥25% cached · 1 run');
});

test('the cache figure is withheld when a finalized sub-agent has no trailer total', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', 'done, nothing to report here');

	assert.equal(subagentLine(fake), '  subagents 1M tok · 1 run');
});

test('one unauditable sub-agent withholds the figure for the whole line', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);
	// Measured, but with no trailer total: the figure cannot be taken for all of them.
	startSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', tokensUsed: 500_000});

	assert.equal(subagentLine(fake), '  subagents 1.5M tok · 2 runs');
});

test('the cache figure is withheld once a parent request wrote to the cache', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	// A prompt billed as a cache write is not a cache hit, so the figure loses its meaning.
	modelCall(fake, t, 'm', usage(100, 10, 90, 800), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);

	assert.equal(subagentLine(fake), '  subagents 1M tok · 1 run');
});

test('a cache write only withholds the figure for the session it happened in', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 800), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);
	assert.equal(subagentLine(fake), '  subagents 1M tok · 1 run');

	fake.emit('session_start', {sessionId: 's2'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	startSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-2', CACHED_TRAILER);

	assert.equal(subagentLine(fake), '  subagents 1M tok  ⛁ ≥25% cached · 1 run');
});

test('the figure sums the per-sub-agent gaps and clamps a shortfall to zero', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);
	// A trailer total below the measured spend contributes nothing — never a negative.
	startSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', tokensUsed: 500_000});
	finishAgentCallWithResult(fake, 'call-2', '<usage>total_tokens: 400000</usage>');

	// 250k cached of 1.5M spent.
	assert.equal(subagentLine(fake), '  subagents 1.5M tok  ⛁ ≥17% cached · 2 runs');
});
