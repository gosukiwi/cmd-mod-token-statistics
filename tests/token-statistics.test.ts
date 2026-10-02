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

	const record = readLogLines()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 4200);
	// Shown, never summed: lifetime input is only the parent call's 100.
	assert.equal(readState().lifetime.input, 100);
	assert.equal(readState().lifetime.output, 10);

	assert.match(report(fake), /subagents/);
	assert.match(report(fake), /4\.2k tokens/);
});

test('a foreground sub-agent finalizes only when its agent tool call completes', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});

	assert.doesNotMatch(report(fake), /subagents/, 'not final before the agent tool call finishes');

	// Some other tool finishing must not finalize it.
	finishAgentCall(fake, 'call-1', 'read');
	assert.doesNotMatch(report(fake), /subagents/);

	finishAgentCall(fake, 'call-1');
	assert.match(report(fake), /subagents/);
	assert.match(report(fake), /4\.2k tokens/);
});

test('a background sub-agent finalizes on its stop, with no agent tool call', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', tokensUsed: 1000});

	assert.match(report(fake), /subagents/);
	assert.match(report(fake), /1k tokens/);

	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	const record = readLogLines()[0];
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
	const record = readLogLines()[0];
	assert.equal(record.subagents, 0);
	assert.equal(record.subagentTokens, 0);
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

	const record = readLogLines()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 4200);
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

	assert.equal(readLogLines().length, 1);
	const record = readLogLines()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 4200);
	assert.match(report(fake), /1 run · 4\.2k tokens/);
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

	const lines = readLogLines();
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
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'explore', tokensUsed: 4200});
	assert.match(report(fake), /subagents/);

	fake.emit('session_start', {sessionId: 's2'});
	assert.doesNotMatch(report(fake), /subagents/);
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

test('/token-stats reports the session, lifetime, models and log path', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'claude-sonnet-5', usage(20_000, 38, 12_400, 800), 1000);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const message = fake.commands.get('token-stats')!().message;
	assert.match(message, /Token statistics · my-app/);
	assert.match(message, /session/);
	assert.match(message, /lifetime/);
	assert.match(message, /62% cached/);
	assert.match(message, /claude-sonnet-5/);
	assert.match(message, /token-statistics\.log\.jsonl/);
	assert.match(message, /1 record/);
});

test('/token-stats says so when nothing has been recorded', () => {
	const fake = setup();
	const message = fake.commands.get('token-stats')!().message;
	assert.match(message, /no requests recorded yet this session/);
	assert.match(message, /nothing recorded yet/);
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
