import { Context } from '@deepseek-ai/cordis';
import { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent';
import { SessionStore, SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type Module = typeof import('../../src/host-adapter/control-lifecycle.js');
let module: Module;
beforeAll(async () => { const path = '../../src/host-adapter/control-lifecycle.js'; module = await import(path).catch(() => ({} as Module)); });
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
const spec = () => ({ target: { ...target }, mode: 'background', ttlMs: 30_000, idleTimeoutMs: 30_000, maxActions: 3, allowedOperations: ['press'],
  targets: [{ handle: 'submit_fixture', identifier: 'fixture.submit', role: 'button', enabled: true, secure: false, impact: 'ordinary' }] });
const request = (leaseId: string) => ({ leaseId, target: { ...target }, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' });
const roots: Context[] = [];
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose(); });
async function boot() {
  expect(module.installFixtureControlRuntime).toBeTypeOf('function');
  const ctx = new Context(); roots.push(ctx); await ctx.plugin(SessionStore).inertia;
  const session = ctx.sessions.prepare(SessionId('session_fixture')); const detach = ctx.sessions.enter(session); ctx.sessions.announce(session);
  const agent = { id: session.id, session, ctx } as Agent;
  const host = { agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: 1 }) }, sessions: ctx.sessions,
    workingDirectory: { get: (_session: Session) => '/tmp/cu-control-lifecycle' } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  let runtime!: ReturnType<Module['installFixtureControlRuntime']>;
  function plugin(scope: Context) { runtime = module.installFixtureControlRuntime(scope, host); }
  const instance = ctx.plugin(plugin); await instance.inertia;
  const exec = { agent, callId: ToolCallId('call_fixture'), signal: new AbortController().signal };
  return { ctx, session, detach, agent, host, runtime, instance, plugin, exec, current: () => runtime };
}

describe('CU-008b1a: opt-in inert control lease lifecycle through real public SDK events', () => {
  it.each(['directory', 'session', 'agent', 'unload'] as const)('returns terminal non-execution receipts across a real %s lifecycle event', async (event) => {
    const f = await boot(); const lease = f.runtime.issueFromHost(f.exec, spec()); const claim = f.runtime.claimTargetFromHost(f.exec, lease.taskLeaseId);
    expect(f.runtime.queueEvaluationReceiptFromHost).toBeTypeOf('function'); const input = { actionId: 'action_receipt', evaluation: request(lease.taskLeaseId) };
    const active = f.runtime.queueEvaluationReceiptFromHost(f.exec, claim, input); const queued = f.runtime.queueEvaluationReceiptFromHost(f.exec, claim, { ...input, actionId: 'action_receipt_queued' });
    if (event === 'directory') f.session.append('working-directory/change', { cwd: '/tmp/receipt-event' });
    if (event === 'session') f.detach(); if (event === 'agent') emitAgentEvent(f.ctx, f.agent, 'agent/disposed', {}); if (event === 'unload') await f.instance.dispose();
    for (const report of await Promise.all([active, queued])) {
      expect(report).toMatchObject({ terminal: true, dispatchable: false, receipt: { execution: 'not_executed', target: 'unknown', effect: 'unverified', taskOutcome: 'not_evaluated', evidence: [] } });
      if (event !== 'unload') expect(report.receipt.error).toMatchObject({ code: 'CANCELLED', phase: 'cancel' });
    }
    if (event === 'unload') await expect(f.runtime.queueEvaluationReceiptFromHost(f.exec, claim, input)).rejects.toThrow();
  });

  it.each(['directory', 'session', 'agent', 'unload'] as const)('revokes private target claims and queued inert evaluations on a real %s event', async (event) => {
    const f = await boot(); const lease = f.runtime.issueFromHost(f.exec, spec()); expect(f.runtime.claimTargetFromHost).toBeTypeOf('function');
    const claim = f.runtime.claimTargetFromHost(f.exec, lease.taskLeaseId); const input = { actionId: 'action_first', evaluation: request(lease.taskLeaseId) };
    const active = f.runtime.queueEvaluationFromHost(f.exec, claim, input); const queued = f.runtime.queueEvaluationFromHost(f.exec, claim, { ...input, actionId: 'action_queued' });
    if (event === 'directory') f.session.append('working-directory/change', { cwd: '/tmp/after-queue' });
    if (event === 'session') f.detach(); if (event === 'agent') emitAgentEvent(f.ctx, f.agent, 'agent/disposed', {});
    if (event === 'unload') await f.instance.dispose();
    if (event === 'unload') {
      // Cordis disposal is asynchronous: fixed synchronous evaluations may finish before the close effect runs.
      expect(['returned', 'cancelled']).toContain((await active).outcome); expect(['returned', 'cancelled']).toContain((await queued).outcome);
      await expect(f.runtime.queueEvaluationFromHost(f.exec, claim, input)).rejects.toThrow();
    } else {
      expect(await active).toMatchObject({ outcome: 'cancelled', workStarted: true }); expect(await queued).toEqual({ outcome: 'cancelled', workStarted: false });
    }
    expect(await f.runtime.waitForControlDrainFromHost()).toBe(true); expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });

  it.each(['directory', 'session', 'agent', 'unload'] as const)('rejects a simulated approval answer arriving after a real %s event', async (event) => {
    const f = await boot(); const raw = spec(); raw.targets[0]!.impact = 'unknown'; const lease = f.runtime.issueFromHost(f.exec, raw);
    const proposal = { actionId: 'action_fixture', leaseId: lease.taskLeaseId, observationId: 'observation_host_declared', materialContext: 'context_host_declared',
      target: { ...target }, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request', raiseRisk: false };
    const pending = f.runtime.prepareApprovalFromHost(f.exec, proposal);
    let answer!: (value: string) => void; const response = new Promise<string>((resolve) => { answer = resolve; });
    const waiting = response.then((outcome) => f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, proposal, outcome));
    if (event === 'directory') f.session.append('working-directory/change', { cwd: '/tmp/after-prepare' });
    if (event === 'session') f.detach(); if (event === 'agent') emitAgentEvent(f.ctx, f.agent, 'agent/disposed', {});
    if (event === 'unload') await f.instance.dispose();
    answer('allowed-once'); await expect(waiting).rejects.toThrow();
    expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, proposal)).toThrow();
  });

  it('binds and consumes a simulated response through the lifecycle factory without an approval service or input callback', async () => {
    const f = await boot(); const raw = spec(); raw.targets[0]!.impact = 'unknown'; const lease = f.runtime.issueFromHost(f.exec, raw);
    const proposal = { actionId: 'action_fixture', leaseId: lease.taskLeaseId, observationId: 'observation_host_declared', materialContext: 'context_host_declared',
      target: { ...target }, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' };
    const pending = f.runtime.prepareApprovalFromHost(f.exec, proposal);
    f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, proposal, 'allowed-once');
    expect(f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, proposal)).toEqual({ status: 'consumed', dispatchable: false });
  });

  it.each(['agent', 'session', 'directory', 'unload'] as const)('invalidates leases on %s, closes admission before abort and does not replay on reload', async (event) => {
    const f = await boot(); const lease = f.runtime.issueFromHost(f.exec, spec()); const signal = f.runtime.signalForHost(f.exec, lease.taskLeaseId);
    expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId)).dispatchable).toBe(false);
    let notified = false;
    signal.addEventListener('abort', () => { notified = true; expect(() => f.runtime.issueFromHost(f.exec, spec())).toThrow('HOST_CONTEXT_UNAVAILABLE'); }, { once: true });
    if (event === 'agent') emitAgentEvent(f.ctx, f.agent, 'agent/disposed', {});
    if (event === 'session') f.detach();
    if (event === 'directory') f.session.append('working-directory/change', { cwd: '/tmp/untrusted-event-data' });
    if (event === 'unload') await f.instance.dispose();
    expect(notified).toBe(true); expect(signal.aborted).toBe(true);
    if (event === 'directory') {
      expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('DENY');
      expect(f.runtime.issueFromHost(f.exec, spec()).taskLeaseId).toMatch(/^lease_/);
    } else expect(() => f.runtime.evaluate(f.exec, request(lease.taskLeaseId))).toThrow('HOST_CONTEXT_UNAVAILABLE');
    if (event === 'unload') {
      const reload = f.ctx.plugin(f.plugin); await reload.inertia; const next = f.current(); expect(next).not.toBe(f.runtime);
      expect(next.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('DENY');
    }
  });

  it('closes control admission before removing the exact nested Session subscription on unload', async () => {
    const f = await boot(); const lease = f.runtime.issueFromHost(f.exec, spec()); let events = 0;
    const original = f.runtime.workspaceChangedFromHost.bind(f.runtime);
    f.runtime.workspaceChangedFromHost = (session) => { events += 1; original(session); };
    f.runtime.signalForHost(f.exec, lease.taskLeaseId).addEventListener('abort', () => {
      f.session.append('working-directory/change', { cwd: '/tmp/after-dispose-start' });
      expect(() => f.runtime.issueFromHost(f.exec, spec())).toThrow('HOST_CONTEXT_UNAVAILABLE');
    }, { once: true });
    await f.instance.dispose(); expect(events).toBe(1);
    f.session.append('working-directory/change', { cwd: '/tmp/after-dispose-end' }); expect(events).toBe(1);
  });

  it('ignores unrelated committed Session events and never trusts event.data as the current directory', async () => {
    const f = await boot(); const lease = f.runtime.issueFromHost(f.exec, spec());
    f.session.append('turn/start', { turn: 1 });
    expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('ALLOW_WITHIN_LEASE');
    f.session.append('working-directory/change', { cwd: '/tmp/model-provided-data' });
    expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('DENY');
    expect(f.runtime.issueFromHost(f.exec, spec()).owner.sessionId).toBe(f.session.id);
  });
});
