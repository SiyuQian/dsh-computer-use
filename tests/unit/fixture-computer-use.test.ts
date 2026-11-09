import { performance } from 'node:perf_hooks';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionStore, SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { mkdtemp, realpath, rm, chmod } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

type Module = typeof import('../../src/service/fixture-computer-use.js');
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
function snapshot() {
  return { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'ok', snapshot: {
    ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 },
    nodes: [
      { nativeId: 'node_0', identifier: 'fixture.text', elementInstance: 'element_text', role: 'AXTextField', subrole: '', label: 'Fixture text', enabled: true, secure: false, actions: ['set_value'], depth: 1 },
      { nativeId: 'node_1', identifier: 'fixture.submit', elementInstance: 'element_submit', role: 'AXButton', subrole: '', label: 'Submit test value', enabled: true, secure: false, actions: ['press'], depth: 1 },
      { nativeId: 'node_2', identifier: 'fixture.save', elementInstance: 'element_save', role: 'AXButton', subrole: '', label: 'Save test copy', enabled: true, secure: false, actions: ['press'], depth: 1 },
      { nativeId: 'node_3', identifier: 'fixture.secure', role: 'AXTextField', subrole: 'AXSecureTextField', label: 'Simulated password', enabled: true, secure: true, actions: [], depth: 1 },
    ], truncated: false, reasons: [],
  } };
}
const roots: Context[] = []; const dirs: string[] = [];
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) if (dir.startsWith('/private/tmp/cu-e2e-ledger-')) await rm(dir, { recursive: true });
});

async function boot(overrides: Partial<Record<string, unknown>> = {}, serviceOptions: Record<string, unknown> = {}) {
  const path = '../../src/service/fixture-computer-use.js';
  const module = await import(path) as Module;
  const ctx = new Context(); roots.push(ctx); await ctx.plugin(SessionStore).inertia;
  const session = ctx.sessions.prepare(SessionId('session_fixture')); ctx.sessions.enter(session); ctx.sessions.announce(session);
  const agent = { id: session.id, session, ctx } as Agent;
  const host = { agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: 1 }) }, sessions: ctx.sessions,
    workingDirectory: { get: (_s: Session) => '/tmp/cu-e2e' } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  const ledgerDirectory = await realpath(await mkdtemp('/tmp/cu-e2e-ledger-')); await chmod(ledgerDirectory, 0o700); dirs.push(ledgerDirectory);
  const calls = { act: 0, approvals: 0, begins: 0, ends: 0, values: [] as Array<string | undefined> };
  const backends = {
    fixtureTarget: async () => target,
    observe: async () => snapshot(),
    act: async (_t: unknown, _e: unknown, value: string | undefined) => { calls.act += 1; calls.values.push(value); return { protocolVersion: 1, requestId: 'r', launchId: 'l', status: 'dispatched', execution: 'completed', readback: value === undefined ? 'not_applicable' : 'match' } as const; },
    beginControl: async () => { calls.begins += 1; return { signal: new AbortController().signal, end: async () => { calls.ends += 1; } }; },
    requestApproval: async () => { calls.approvals += 1; return 'unavailable' as const; },
    ...overrides,
  };
  const service = new module.FixtureComputerUse(host, backends as never, { ledgerDirectory, ...serviceOptions });
  const exec = { agent, callId: ToolCallId('call_fixture'), signal: new AbortController().signal };
  return { service, exec, calls, ctx, host, agent };
}
const handle = (observation: { elements: Array<{ name: string; handle: string }> }, name: string) => observation.elements.find((element) => element.name === name)!.handle;

describe('CU-015: fixture-only vertical composition with injected native seams', () => {
  it('observes, then sets the public field and presses submit once each through the controller slot', async () => {
    const f = await boot();
    const observation = await f.service.observe(f.exec, {});
    expect(observation.elements.find((element) => element.name === 'Simulated password')).toMatchObject({ secure: true });
    const set = await f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'set_value', targetHandle: handle(observation, 'Fixture text'), value: 'PUBLIC_TEST' } });
    expect(set.receipt).toMatchObject({ execution: 'completed', target: 'exact', effect: 'unverified', taskOutcome: 'not_evaluated' });
    expect(set.readback).toBe('match');
    expect(JSON.stringify(set)).not.toContain('PUBLIC_TEST');
    const press = await f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'press', targetHandle: handle(observation, 'Submit test value') } });
    expect(press.receipt.execution).toBe('completed');
    expect(f.calls).toMatchObject({ act: 2, begins: 2, ends: 2, approvals: 0 });
  });

  it('requires approval for an unclassified effect and does not dispatch when approval is unavailable (never policy)', async () => {
    const f = await boot();
    const observation = await f.service.observe(f.exec, {});
    const result = await f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'press', targetHandle: handle(observation, 'Save test copy') } });
    expect(result.receipt).toMatchObject({ execution: 'not_executed', error: { code: 'APPROVAL_UNAVAILABLE', phase: 'approve' } });
    expect(f.calls).toMatchObject({ approvals: 1, act: 0, begins: 0 });
  });

  it('dispatches an approved unclassified effect exactly once', async () => {
    const f = await boot({ requestApproval: async () => 'allowed-once' });
    const observation = await f.service.observe(f.exec, {});
    const result = await f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'press', targetHandle: handle(observation, 'Save test copy') } });
    expect(result.receipt.execution).toBe('completed'); expect(f.calls.act).toBe(1);
  });

  it.each([
    ['unknown observation', (_o: { observationId: string }, h: string) => ({ observationId: 'observation_forged', action: { kind: 'press', targetHandle: h } })],
    ['forged handle', (o: { observationId: string }) => ({ observationId: o.observationId, action: { kind: 'press', targetHandle: 'element_forged' } })],
    ['secure field', (o: { observationId: string; elements: Array<{ name: string; handle: string }> }) => ({ observationId: o.observationId, action: { kind: 'set_value', targetHandle: handle(o, 'Simulated password'), value: 'x' } })],
    ['operation mismatch', (o: { observationId: string; elements: Array<{ name: string; handle: string }> }) => ({ observationId: o.observationId, action: { kind: 'set_value', targetHandle: handle(o, 'Submit test value'), value: 'x' } })],
  ] as const)('refuses %s without any native call', async (_name, build) => {
    const f = await boot();
    const observation = await f.service.observe(f.exec, {});
    const result = await f.service.act(f.exec, build(observation as never, handle(observation, 'Submit test value')) as never);
    expect(result.receipt.execution).toBe('not_executed');
    expect(f.calls).toMatchObject({ act: 0, begins: 0 });
  });

  it('rejects injected identity, risk or approval fields at the schema boundary', async () => {
    const f = await boot();
    const observation = await f.service.observe(f.exec, {});
    await expect(f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'press', targetHandle: handle(observation, 'Submit test value') }, approved: true })).rejects.toThrow('INVALID_REQUEST');
    await expect(f.service.observe(f.exec, { window: 'primary', pid: 1 })).rejects.toThrow('INVALID_REQUEST');
    expect(f.calls.act).toBe(0);
  });

  it('does not dispatch when the controller is stopped or busy', async () => {
    const f = await boot({ beginControl: async () => { throw new Error('CONTROL_STOPPED: revoked'); } });
    const observation = await f.service.observe(f.exec, {});
    const result = await f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'press', targetHandle: handle(observation, 'Submit test value') } });
    expect(result.receipt).toMatchObject({ execution: 'not_executed', error: { phase: 'lock' } }); expect(f.calls.act).toBe(0);
  });

  it('reports unknown and never retries when the native call fails after handoff', async () => {
    let acts = 0;
    const f = await boot({ act: async () => { acts += 1; throw new Error('EXECUTION_UNKNOWN'); } });
    const observation = await f.service.observe(f.exec, {});
    const result = await f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'press', targetHandle: handle(observation, 'Submit test value') } });
    expect(result.receipt).toMatchObject({ execution: 'unknown', effect: 'unknown', error: { code: 'EFFECT_UNKNOWN', retry: 'never' } });
    expect(acts).toBe(1); expect(f.calls.ends).toBe(1);
  });

  it('maps a helper pre-input refusal to not_executed with observe_first', async () => {
    const f = await boot({ act: async () => ({ protocolVersion: 1, requestId: 'r', launchId: 'l', status: 'error', code: 'TARGET_CHANGED' }) });
    const observation = await f.service.observe(f.exec, {});
    const result = await f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'press', targetHandle: handle(observation, 'Submit test value') } });
    expect(result.receipt).toMatchObject({ execution: 'not_executed', target: 'invalid', error: { code: 'TARGET_CHANGED', retry: 'observe_first' } });
  });

  it('invalidates observations after a fixture restart so old handles cannot act on the new process', async () => {
    let current = target;
    const f = await boot({ fixtureTarget: async () => current });
    const observation = await f.service.observe(f.exec, {});
    current = { ...target, pid: 42, processStart: 'process_restarted' };
    await expect(f.service.observe(f.exec, {})).rejects.toThrow();
    const result = await f.service.act(f.exec, { observationId: observation.observationId, action: { kind: 'press', targetHandle: handle(observation, 'Submit test value') } });
    expect(result.receipt.execution).toBe('not_executed'); expect(f.calls.act).toBe(0);
  });

  it('re-grants read access after the cached grant expires instead of failing permanently', async () => {
    const f = await boot();
    await f.service.observe(f.exec, {});
    const realNow = performance.now.bind(performance); let offset = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => realNow() + offset });
    try {
      offset = 601_000; // past the 10 minute static read grant
      const later = await f.service.observe(f.exec, {});
      const result = await f.service.act(f.exec, { observationId: later.observationId, action: { kind: 'press', targetHandle: handle(later, 'Submit test value') } });
      expect(result.receipt.execution).toBe('completed');
    } finally { Object.defineProperty(performance, 'now', { configurable: true, value: realNow }); }
  });

  it('uses the caller scope grant, so a second agent observing the same window can act', async () => {
    const f = await boot();
    const sessionB = f.ctx.sessions.prepare(SessionId('session_other')); f.ctx.sessions.enter(sessionB); f.ctx.sessions.announce(sessionB);
    const agentB = { id: sessionB.id, session: sessionB, ctx: f.ctx } as Agent;
    (f.host as unknown as { agents: { get: (id: string) => Agent } }).agents.get = (id: string) => (id === agentB.id ? agentB : f.agent);
    const execB = { agent: agentB, callId: ToolCallId('call_other'), signal: new AbortController().signal };
    await f.service.observe(f.exec, {});
    const observationB = await f.service.observe(execB, {});
    const result = await f.service.act(execB, { observationId: observationB.observationId, action: { kind: 'press', targetHandle: handle(observationB, 'Submit test value') } });
    expect(result.receipt.execution).toBe('completed');
  });
});
