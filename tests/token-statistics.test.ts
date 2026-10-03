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
	registeredHooks: any[];
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
		registeredHooks,
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

	for (const flag of ['token-stats-status', 'token-stats-summary', 'token-stats-log']) {
		assert.ok(fake.declaredFlags.has(flag), `missing flag ${flag}`);
	}
	// The boolean flags must NOT declare a default, or a config file value could never win.
	for (const flag of ['token-stats-status', 'token-stats-summary', 'token-stats-log']) {
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

test('registers onRunEnd and afterToolCall in a single merged cmd.hooks call', () => {
	const fake = setup();

	// One registration, both hooks on it — the mod must not rely on the host merging
	// successive cmd.hooks calls.
	assert.equal(fake.registeredHooks.length, 1, 'a single merged cmd.hooks registration');
	assert.equal(typeof fake.registeredHooks[0].onRunEnd, 'function');
	assert.equal(typeof fake.registeredHooks[0].afterToolCall, 'function');
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
	assert.match(line, /▲ 20k in/);
	assert.match(line, /▼ 38 out/);
	assert.match(line, /62% cached/);
	assert.match(line, /38 tok\/s/);
	// The context segment is gone; the footer is the session totals plus the sub-agent cluster.
	assert.doesNotMatch(line, /ctx/);
});

test('tok/s is measured from the request wall-clock', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('model_request_start', {model: 'm'});
	t.mock.timers.tick(2000);
	fake.emit('model_request_end', {model: 'm', usage: usage(100, 100)});

	assert.match(statusLine(fake), /50 tok\/s/);
});

test('the footer omits the sub-agent cluster until one has been counted', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	assert.doesNotMatch(statusLine(fake), /·  sub /);

	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCall(fake, 'call-1');

	// The finalize repaints the footer even with no further model call.
	assert.equal(statusLine(fake), '▲ 100 in  ▼ 10 out  ⚡ 100 tok/s  ⛁ 0% cached  ·  sub 4.2k tok · 1 run');
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
	// The per-model aggregate is gone: the model ids live only on the per-run log line.
	assert.equal(state.byModel, undefined);
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

test('a pre-existing byModel key is removed from the state file', async (t) => {
	useFakeTimers(t);
	mkdirSync(STATE_DIR, {recursive: true});
	writeFileSync(
		CONFIG,
		JSON.stringify({
			byModel: {'old-model': {input: 5}},
			lifetime: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1, runs: 1, since: '2020-01-01T00:00:00.000Z'},
		}),
	);

	const fake = setup();
	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	assert.equal(readState().byModel, undefined, 'the per-run fold drops byModel');

	// The reset path must drop it too, even when it was seeded just before.
	writeFileSync(CONFIG, JSON.stringify({byModel: {'old-model': {input: 5}}, lifetime: {input: 1}}));
	const resetting = setup({confirm: true});
	resetting.commands.get('token-stats')!({args: 'reset'});
	await settle();
	assert.equal(readState().byModel, undefined, 'the reset drops byModel');
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

test('tokens that only arrived via the run fallback are visible in the report', async (t) => {
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	// No model_request_end at all: the only numbers are the harness-reported usage.
	await fake.hook('onRunEnd', {result: {stopReason: 'interrupted', usage: usage(300, 20)}});

	const message = report(fake);
	assert.notEqual(message, 'no requests recorded yet');
	assert.match(message, /▲ 300 in/);
	assert.match(message, /▼ 20 out/);
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

// The `agent` tool's result content, exactly as the host hands it to `afterToolCall`: an
// array of content blocks (the harness's `textResult` builds `{ok, content:[{type:'text',text}]}`
// and passes `.content`), NOT the string the `<usage>` trailer lives in.
function agentContent(text: string): {type: 'text'; text: string}[] {
	return [{type: 'text', text}];
}

// The `agent` tool call that launched a sub-agent has finished. The plain case carries no
// `<usage>` trailer, so it stands for a launch ack or an ordinary completion.
function finishAgentCall(fake: FakeMod, toolCallId: string, toolName = 'agent'): void {
	fake.hook('afterToolCall', {toolCallId, toolName, result: agentContent('anything')});
}

// The same completion, but with specific result text — the `agent` tool's result text carries
// a `<usage>` trailer that the mod parses — wrapped in the real content-block array.
function finishAgentCallWithResult(fake: FakeMod, toolCallId: string, text: string, toolName = 'agent'): void {
	fake.hook('afterToolCall', {toolCallId, toolName, result: agentContent(text)});
}

// The raw result form, for the tolerance tests: a value that is neither the string nor the
// content-block array the host actually sends.
function finishAgentCallRaw(fake: FakeMod, toolCallId: string, result: unknown, toolName = 'agent'): void {
	fake.hook('afterToolCall', {toolCallId, toolName, result});
}

// The real trailer text, verbatim from the `agent` tool; the helper wraps it in the
// content-block array the host delivers.
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

	assert.match(statusLine(fake), /·  sub /);
	assert.match(statusLine(fake), /4\.2k tok · 1 run/);
});

test('a foreground sub-agent finalizes only when its agent tool call completes', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});

	assert.doesNotMatch(statusLine(fake), /·  sub /, 'not final before the agent tool call finishes');

	// Some other tool finishing must not finalize it.
	finishAgentCall(fake, 'call-1', 'read');
	assert.doesNotMatch(statusLine(fake), /·  sub /);

	finishAgentCall(fake, 'call-1');
	assert.match(statusLine(fake), /·  sub /);
	assert.match(statusLine(fake), /4\.2k tok · 1 run/);
});

test('a background sub-agent finalizes on its stop, with no agent tool call', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', tokensUsed: 1000});

	assert.match(statusLine(fake), /·  sub /);
	assert.match(statusLine(fake), /1k tok · 1 run/);

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

	assert.doesNotMatch(statusLine(fake), /·  sub /);
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
	assert.doesNotMatch(statusLine(fake), /·  sub /);

	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const record = runRecords()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 4200);
	assert.equal(subagentRecords().length, 1, 'the swept sub-agent still gets its own record');
});

// ---------------------------------------------------------------------------
// Refactor regressions — the sweep and subagent_start must not finalize early
// ---------------------------------------------------------------------------

// Regression 1: the run-end sweep used to stamp `agentDone = true` on EVERY ledger entry
// before finalizing. The flag persists, so a *foreground* sub-agent that stopped later —
// while no run was in flight — finalized through the `agentDone` branch, producing a
// subagents line and a durable record the old sweep never created. The sweep must only act
// on entries that already hold a token count, leaving a zero-token entry untouched.
test('the run-end sweep leaves a zero-token entry untouched', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'c1', subagentType: 'explore', background: false});
	// The run ends before the sub-agent has reported any tokens.
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	// The foreground sub-agent stops while the session is idle. Its `agent` tool call never
	// completed, so it is not done and must not be counted: no line, no durable record.
	stopSubagent(fake, {toolCallId: 'c1', subagentType: 'explore', tokensUsed: 5000});

	assert.doesNotMatch(statusLine(fake), /·  sub /, 'no subagents cluster is shown');
	assert.equal(subagentLine(fake), '');
	assert.equal(subagentRecords().length, 0, 'no kind:"subagent" record is written');
});

// Regression 2: subagent_start used to route through the finalizing mutation point, so an
// out-of-order/duplicate start that arrived after the stop finalized the entry on the spot.
// The `finalized` latch then dropped the `afterToolCall` trailer, withholding the cache
// figure. A start must only declare its facts (run/epoch, background) without finalizing.
test('a duplicate subagent_start does not finalize before the trailer is parsed', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'c1', subagentType: 'explore', background: false});
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	stopSubagent(fake, {toolCallId: 'c1', subagentType: 'explore', tokensUsed: 9000});
	// The duplicate start flips the entry to background *after* the stop. It must not commit
	// the entry — the `agent` tool call's trailer is still to come.
	startSubagent(fake, {toolCallId: 'c1', subagentType: 'explore', background: true});
	finishAgentCallWithResult(
		fake,
		'c1',
		'x\n\n<usage>total_tokens: 4000\ntool_uses: 2\nturns: 1\nduration_ms: 5</usage>',
	);

	const [record] = subagentRecords();
	assert.ok(record, 'the entry finalizes on the agent tool-call completion');
	assert.equal(record.tokensUsed, 9000);
	assert.equal(record.totalTokens, 4000);
	assert.equal(record.turns, 1);
	assert.equal(record.toolUses, 2);
	assert.equal(record.durationMs, 5);
	// The trailer is known, so the cache cluster is shown (a floor of 0% here).
	assert.match(subagentLine(fake), /⛁ ≥0% cached/);
});

test('finalization is idempotent', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', background: true});
	// The launch ack is the background sub-agent's only `agent`-tool result: no trailer.
	finishAgentCall(fake, 'call-1');
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
	assert.match(statusLine(fake), /4\.2k tok · 1 run/);
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

// A sub-agent belongs to the run that *started* it, not the run that happens to be in
// flight when it finalizes. A background sub-agent outlives the tool call that launched it,
// so its stop can land in a later run, or while the session is idle.

test('a background sub-agent that finishes within its launching run lands in that run', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	// Launch and finish the background sub-agent while run 1 is still active.
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', tokensUsed: 4200});
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const record = runRecords()[0];
	assert.equal(record.subagents, 1);
	assert.equal(record.subagentTokens, 4200);
});

test('a background sub-agent that outlives its run is never claimed by a later run', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', background: true});
	// Run 1 ends before the background sub-agent finishes, so the sweep has no token count
	// to book: run 1 reports no sub-agent.
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	// Run 2 starts — it never launched this sub-agent.
	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	// The background sub-agent finally stops, during run 2.
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', tokensUsed: 4200});
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const lines = runRecords();
	assert.equal(lines.length, 2);
	assert.equal(lines[0].subagents, 0);
	assert.equal(lines[0].subagentTokens, 0);
	// The fix: run 2 must not claim a sub-agent it never launched.
	assert.equal(lines[1].subagents, 0);
	assert.equal(lines[1].subagentTokens, 0);

	// The session view and the per-sub-agent record still account for it.
	assert.equal(subagentLine(fake), 'sub 4.2k tok · 1 run');
	assert.equal(subagentRecords().length, 1);
});

test('a background sub-agent that stops while the session is idle is written to no run', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', background: true});
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	// The stop arrives with no run in flight.
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', tokensUsed: 4200});

	// Only run 1's record was written, and it does not include the late sub-agent.
	const lines = runRecords();
	assert.equal(lines.length, 1);
	assert.equal(lines[0].subagents, 0);
	assert.equal(lines[0].subagentTokens, 0);

	// The session line and the durable per-sub-agent record still account for it.
	assert.equal(subagentLine(fake), 'sub 4.2k tok · 1 run');
	assert.equal(subagentRecords().length, 1);
});

test('subagent_progress is never subscribed or summed', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	// The progress stream carries an estimate; it must not reach any total or counter.
	fake.emit('subagent_progress', {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 50_000});

	assert.doesNotMatch(statusLine(fake), /·  sub /);
	assert.match(statusLine(fake), /▲ 100 in/);
});

test('a new session starts with no sub-agent activity to report', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'bg-1', subagentType: 'explore', background: true});
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'explore', tokensUsed: 4200});
	assert.match(statusLine(fake), /·  sub /);

	fake.emit('session_start', {sessionId: 's2'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	assert.doesNotMatch(statusLine(fake), /·  sub /);
});

// ---------------------------------------------------------------------------
// Per-sub-agent durable log record
// ---------------------------------------------------------------------------

// Fix A regression: the host hands `afterToolCall` the tool's content — for the `agent` tool
// an array of text blocks — so the mod must read the trailer out of that array rather than
// only off a bare string.
test('the real content-block result carries the usage trailer into the record and report', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCallRaw(fake, 'call-1', [
		{
			type: 'text',
			text: 'done\n\n<usage>total_tokens: 6300\ntool_uses: 4\nturns: 3\nduration_ms: 1200</usage>',
		},
	]);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const [record] = subagentRecords();
	assert.equal(record.turns, 3);
	assert.equal(record.toolUses, 4);
	assert.equal(record.durationMs, 1200);
	assert.equal(record.totalTokens, 6300);
	assert.equal(record.tokensUsed, 4200);
	// 6300 − 4200 = 2100 cached of 4200 spent is 50%.
	assert.equal(subagentLine(fake), 'sub 4.2k tok  ⛁ ≥50% cached · 1 run');
});

test('a bare-string agent result is still parsed for the trailer (tolerance)', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCallRaw(
		fake,
		'call-1',
		'done\n\n<usage>total_tokens: 6300\ntool_uses: 4\nturns: 3\nduration_ms: 1200</usage>',
	);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const [record] = subagentRecords();
	assert.equal(record.turns, 3);
	assert.equal(record.totalTokens, 6300);
});

test('an empty or non-text content array yields no trailer and does not throw', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);

	// An empty content array — the real shape, but with nothing to read.
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	assert.doesNotThrow(() => finishAgentCallRaw(fake, 'call-1', []));

	// Blocks that are not text, or text blocks with no string — none carries a trailer.
	startSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', tokensUsed: 500});
	assert.doesNotThrow(() =>
		finishAgentCallRaw(fake, 'call-2', [{type: 'image', data: 'x'}, {type: 'text'}, null]),
	);

	const records = subagentRecords();
	assert.equal(records.length, 2);
	for (const record of records) {
		assert.deepEqual(Object.keys(record), [
			'ts',
			'kind',
			'sessionId',
			'toolCallId',
			'subagentType',
			'tokensUsed',
		]);
	}
	assert.equal(subagentLine(fake), 'sub 4.7k tok · 2 runs');
});

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

test('a non-string, non-array agent result is tolerated and carries no trailer', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	assert.doesNotThrow(() =>
		finishAgentCallRaw(fake, 'call-1', {not: 'a string with a trailer'}),
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
	// A background launch's only `agent` result is the acknowledgement — no `<usage>` block.
	finishAgentCall(fake, 'bg-1');
	stopSubagent(fake, {toolCallId: 'bg-1', subagentType: 'review', tokensUsed: 1000});

	// The record lands at stop time, while the run is still going, with no trailer ever seen.
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
	// An unauditable sub-agent withholds the cache cluster entirely.
	assert.equal(subagentLine(fake), 'sub 1k tok · 1 run');
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
	assert.match(statusLine(fake), /·  sub /);
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

test('/token-stats prints the lifetime line, with no session, models or log rows', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'claude-sonnet-5', usage(20_000, 38, 12_400, 800), 1000);
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	const message = fake.commands.get('token-stats')!().message;
	// The durable lifetime totals, labelled, with the all-time run count and no sub-agent row.
	assert.equal(message, 'lifetime   ▲ 20k in  ▼ 38 out  ⚡ 38 tok/s  ⛁ 62% cached  ·  1 run');
});

test('/token-stats adds a subagents line once a sub-agent has been counted', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'claude-sonnet-5', usage(20_000, 38, 12_400, 800), 1000);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCall(fake, 'call-1');
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});

	assert.equal(
		fake.commands.get('token-stats')!().message,
		'lifetime   ▲ 20k in  ▼ 38 out  ⚡ 38 tok/s  ⛁ 62% cached  ·  1 run\nsubagents  4.2k tok · 1 run',
	);
});

test('/token-stats says so when nothing has been recorded', () => {
	const fake = setup();
	const message = fake.commands.get('token-stats')!().message;
	assert.equal(message, 'no requests recorded yet');
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
	assert.equal(readState().byModel, undefined);
	assert.match(confirmed.notices.at(-1)!, /reset/i);
});

// ---------------------------------------------------------------------------
// Subagent cache figure
// ---------------------------------------------------------------------------

// The inline sub-agent cluster of the footer, e.g. `sub 4.2k tok · 1 run`; empty when none.
function subagentLine(fake: FakeMod): string {
	const line = statusLine(fake);
	const at = line.indexOf('·  sub ');
	return at === -1 ? '' : line.slice(at + 3);
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

	assert.equal(subagentLine(fake), 'sub 1M tok  ⛁ ≥25% cached · 1 run');
});

test('the cache figure is withheld when a finalized sub-agent has no trailer total', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', 'done, nothing to report here');

	assert.equal(subagentLine(fake), 'sub 1M tok · 1 run');
});

test('one unauditable sub-agent withholds the figure for the whole line', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);
	// A background sub-agent's only `agent`-tool result is the launch ack — no trailer is ever
	// observable — so its run is measured but unauditable, and the figure cannot be taken for
	// all of them.
	startSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', background: true});
	finishAgentCall(fake, 'call-2');
	stopSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', tokensUsed: 500_000});

	assert.equal(subagentLine(fake), 'sub 1.5M tok · 2 runs');
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

	assert.equal(subagentLine(fake), 'sub 1M tok · 1 run');
});

test('a cache write only withholds the figure for the session it happened in', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 800), 100);
	// Foreground: the trailer arrives when the `agent` tool call completes, after the stop.
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);
	assert.equal(subagentLine(fake), 'sub 1M tok · 1 run');

	fake.emit('session_start', {sessionId: 's2'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	startSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-2', CACHED_TRAILER);

	assert.equal(subagentLine(fake), 'sub 1M tok  ⛁ ≥25% cached · 1 run');
});

test('the figure sums the per-sub-agent gaps and clamps a shortfall to zero', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10, 90, 0), 100);
	// Both foreground: each trailer arrives when its `agent` tool call completes.
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 1_000_000});
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);
	// A trailer total below the measured spend contributes nothing — never a negative.
	startSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-2', subagentType: 'explore', tokensUsed: 500_000});
	finishAgentCallWithResult(fake, 'call-2', '<usage>total_tokens: 400000</usage>');

	// 250k cached of 1.5M spent.
	assert.equal(subagentLine(fake), 'sub 1.5M tok  ⛁ ≥17% cached · 2 runs');
});

// A trailer whose total sits a little above the measured spend, so the cache figure works
// out to a sane, exact percentage.
const MEASURED_TRAILER = '<usage>total_tokens: 6300</usage>';

test('a late subagent_stop cannot rewrite an already-finalized sub-agent', (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	finishAgentCallWithResult(fake, 'call-1', MEASURED_TRAILER);
	// The entry is finalized now; a second stop with a different count must be a no-op.
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 9000});

	// The measured 4200 is what both the line and the cache figure are built from.
	assert.equal(subagentLine(fake), 'sub 4.2k tok  ⛁ ≥50% cached · 1 run');
	assert.match(statusLine(fake), /4\.2k tok/);

	const records = subagentRecords();
	assert.equal(records.length, 1);
	assert.equal(records[0].tokensUsed, 4200, 'the committed record keeps the original count');
});

test('a trailer that arrives after the run-end sweep never reaches the report', async (t) => {
	useFakeTimers(t);
	const fake = setup();

	fake.emit('run_start', {sessionId: 's1'});
	modelCall(fake, t, 'm', usage(100, 10), 100);
	startSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore'});
	stopSubagent(fake, {toolCallId: 'call-1', subagentType: 'explore', tokensUsed: 4200});
	// The sweep finalizes it with no trailer and writes the durable record without a total.
	await fake.hook('onRunEnd', {result: {stopReason: 'end_turn'}});
	// The agent tool call completes late, carrying a trailer the record will never have.
	finishAgentCallWithResult(fake, 'call-1', CACHED_TRAILER);

	assert.equal(subagentLine(fake), 'sub 4.2k tok · 1 run');
	assert.equal(subagentRecords()[0].totalTokens, undefined);
});
