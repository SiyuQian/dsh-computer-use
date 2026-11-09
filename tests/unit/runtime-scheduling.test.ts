import { performance } from 'node:perf_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureControlRuntime } from '../../src/service/fixture-control-runtime.js';

const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
type Call = Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>;
function spec(windowId = 7) { return { target: { ...target, windowId }, mode: 'background', ttlMs: 30_000, idleTimeoutMs: 30_000, maxActions: 3, allowedOperations: ['press'],
  targets: [{ handle: 'submit_fixture', identifier: 'fixture.submit', role: 'button', enabled: true, secure: false, impact: 'ordinary' }] }; }
function evaluation(leaseId: string, windowId = 7) { return { leaseId, target: { ...target, windowId }, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' }; }
function fixture() {
  const agents = new Map<string, Agent>(); const sessions = new Map<string, Session>(); const dirs = new Map<Session, string>(); let turn = 1;
  const host = { agents: { get: (id: string) => agents.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: turn }) },
    sessions: { get: (id: string) => sessions.get(id) }, workingDirectory: { get: (session: Session) => dirs.get(session)! } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  const runtime = new FixtureControlRuntime(host); cleanups.push(() => runtime.dispose());
  function caller(id = 'session_fixture') { const session = Session.create(SessionId(id)); const agent = { id: session.id, session } as Agent;
    agents.set(id, agent); sessions.set(id, session); dirs.set(session, '/tmp/cu-runtime-scheduling'); const abort = new AbortController();
    const exec: Call = { agent, callId: ToolCallId('call_fixture'), signal: abort.signal }; return { agent, session, exec, abort }; }
  const first = caller();
  function claim(exec = first.exec, windowId = 7) {
    expect(runtime.claimTargetFromHost).toBeTypeOf('function'); const lease = runtime.issueFromHost(exec, spec(windowId));
    return { lease, claim: runtime.claimTargetFromHost(exec, lease.taskLeaseId), request: { actionId: 'action_host_declared', evaluation: evaluation(lease.taskLeaseId, windowId) } };
  }
  return { runtime, ...first, host, caller, claim, turn(value: number) { turn = value; }, directory(value: string) { dirs.set(first.session, value); } };
}

describe('CU-010a2: private host scheduling of fixed inert evaluations, no caller work or native executor', () => {
  it.each(['claim', 'evaluate'] as const)('pins the original turn before parsing or looking up the %s source', async (operation) => {
    let calls = 0; let changeTurn = false; let f!: ReturnType<typeof fixture>;
    vi.spyOn(performance, 'now').mockImplementation(() => { calls += 1; if (changeTurn && calls === 3) f.turn(2); return 100; });
    f = fixture(); const c = f.claim();
    const request = { ...c.request, get evaluation() { f.turn(2); return c.request.evaluation; } };
    if (operation === 'evaluate') await expect(f.runtime.queueEvaluationFromHost(f.exec, c.claim, request)).rejects.toThrow();
    else {
      const lease = f.runtime.issueFromHost(f.exec, spec(8)); calls = 0; changeTurn = true;
      expect(() => f.runtime.claimTargetFromHost(f.exec, lease.taskLeaseId)).toThrow();
    }
  });

  it.each(['agent', 'session', 'directory', 'policy', 'dispose'] as const)('closes lease-observer admission before %s notifications and clears sibling claims first', (event) => {
    const f = fixture(); const c = f.claim(); const sibling = f.claim(f.exec, 8); const signal = f.runtime.signalForHost(f.exec, c.lease.taskLeaseId);
    let notified = false;
    signal.addEventListener('abort', () => {
      notified = true; expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
      expect(() => f.runtime.claimTargetFromHost(f.exec, sibling.lease.taskLeaseId)).toThrow();
      expect(() => f.runtime.resumeFromHost()).toThrow();
    }, { once: true });
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent); if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session); if (event === 'policy') f.runtime.policyChangedFromHost(); if (event === 'dispose') f.runtime.dispose();
    expect(notified).toBe(true);
  });

  it('revokes prepared approvals during stop so draining and resuming cannot resurrect an old answer', async () => {
    const f = fixture(); const raw = spec(); raw.targets[0]!.impact = 'unknown'; const lease = f.runtime.issueFromHost(f.exec, raw);
    const proposal = { ...evaluation(lease.taskLeaseId), actionId: 'action_approval', observationId: 'observation_host_declared', materialContext: 'context_host_declared' };
    const pending = f.runtime.prepareApprovalFromHost(f.exec, proposal); f.runtime.stopFromHost();
    expect(() => f.runtime.prepareApprovalFromHost(f.exec, proposal)).toThrow('CONTROL_STOPPED');
    expect(await f.runtime.waitForControlDrainFromHost()).toBe(true); f.runtime.resumeFromHost();
    expect(() => f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, proposal, 'allowed-once')).toThrow();
  });

  it('does not turn a scheduling evaluation into approval or consume an action budget', async () => {
    const f = fixture(); const raw = spec(); raw.targets[0]!.impact = 'unknown'; raw.maxActions = 1;
    const lease = f.runtime.issueFromHost(f.exec, raw); expect(f.runtime.claimTargetFromHost).toBeTypeOf('function');
    const claim = f.runtime.claimTargetFromHost(f.exec, lease.taskLeaseId); const request = { actionId: 'action_no_charge', evaluation: evaluation(lease.taskLeaseId) };
    for (let i = 0; i < 2; i += 1) expect(await f.runtime.queueEvaluationFromHost(f.exec, claim, request)).toMatchObject({ outcome: 'returned', value: { decision: 'REQUIRE_APPROVAL', dispatchable: false } });
  });

  it('does not leak raw proposal getter errors or retain a replaced caller signal while queued', async () => {
    const f = fixture(); const c = f.claim(); const first = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request);
    const second = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request); Object.defineProperty(f.exec, 'signal', { value: new AbortController().signal }); f.abort.abort();
    expect(await first).toMatchObject({ outcome: 'cancelled' }); expect(await second).toMatchObject({ outcome: 'cancelled', workStarted: false });
    await expect(f.runtime.queueEvaluationFromHost(f.exec, c.claim, { get actionId() { throw new Error('PRIVATE_RAW_VALUE'); } })).rejects.toThrow('INVALID_REQUEST');
  });

  it('releases pending queue capacity on caller cancellation while retaining the lease-owned claim for another call', async () => {
    const f = fixture(); const c = f.claim(); const independent = { ...f.exec, signal: new AbortController().signal };
    const active = f.runtime.queueEvaluationFromHost(independent, c.claim, c.request);
    const pending = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request); f.abort.abort();
    expect(await pending).toEqual({ outcome: 'cancelled', workStarted: false }); expect(await active).toMatchObject({ outcome: 'returned' });
    expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(1);
    expect(await f.runtime.queueEvaluationFromHost(independent, c.claim, c.request)).toMatchObject({ outcome: 'returned' });
  });

  it('refuses queued evaluation when its own lease expires before the head job releases the slot', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const c = f.claim(); const active = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request);
    const queued = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request); now += 30_000;
    expect(await active).toMatchObject({ outcome: 'returned' }); expect((await queued).workStarted).toBe(false);
    expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });

  it('does not let a missed cwd event or same-ID replacement reuse old target claims', async () => {
    const f = fixture(); const c = f.claim(); f.directory('/tmp/changed');
    await expect(f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request)).rejects.toThrow(); expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
    const replacement = f.caller(); const fresh = f.claim(replacement.exec);
    await expect(f.runtime.queueEvaluationFromHost(f.exec, fresh.claim, fresh.request)).rejects.toThrow();
    expect(await f.runtime.queueEvaluationFromHost(replacement.exec, fresh.claim, fresh.request)).toMatchObject({ outcome: 'returned' });
  });

  it('allows a lease claim to be used in a later host call but pins each enqueued evaluation to its own current turn', async () => {
    const f = fixture(); const c = f.claim(); f.turn(2);
    expect(await f.runtime.queueEvaluationFromHost({ ...f.exec, callId: ToolCallId('call_later') }, c.claim, c.request)).toMatchObject({ outcome: 'returned' });
  });

  it('bounds pending evaluations without silently evicting live work', async () => {
    const f = fixture(); const c = f.claim(); const jobs = [f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request)];
    for (let i = 0; i < 64; i += 1) jobs.push(f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, actionId: `action_${i}` }));
    const overflow = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request);
    f.runtime.stopFromHost(); await expect(overflow).rejects.toThrow('CONTROL_CAPACITY');
    const results = await Promise.all(jobs); expect(results.every((result) => result.outcome === 'cancelled')).toBe(true);
    expect(f.runtime.coordinationStatusFromHost()).toMatchObject({ state: 'paused', pendingCount: 0, claimedTargets: 0 });
  });

  it('checks the pinned host turn after the last policy lookup used to validate a claim', () => {
    let reads = 0; let invalidate = false; let f!: ReturnType<typeof fixture>;
    vi.spyOn(performance, 'now').mockImplementation(() => { reads += 1; if (invalidate && reads === 3) f.turn(2); return 100; });
    f = fixture(); const lease = f.runtime.issueFromHost(f.exec, spec()); reads = 0; invalidate = true;
    expect(() => f.runtime.claimTargetFromHost(f.exec, lease.taskLeaseId)).toThrow(); expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });

  it('does not mint a new lease if an execution getter stops control after the entry check', () => {
    const f = fixture(); const raw = { ...f.exec, get agent() { f.runtime.stopFromHost(); return f.agent; } };
    expect(() => f.runtime.issueFromHost(raw, spec())).toThrow('CONTROL_STOPPED');
    f.runtime.resumeFromHost(); expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });

  it('does not carry an admission call through stop and immediate drained resume inside an execution getter', () => {
    const f = fixture(); const raw = { ...f.exec, get agent() { f.runtime.stopFromHost(); f.runtime.resumeFromHost(); return f.agent; } };
    expect(() => f.runtime.issueFromHost(raw, spec())).toThrow();
  });

  it('refuses a claim after the final host getter expires its lease without firing a timer', () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const lease = f.runtime.issueFromHost(f.exec, spec()); let reads = 0;
    vi.spyOn(f.host.workingDirectory, 'get').mockImplementation(() => { reads += 1; if (reads === 4) now = 30_100; return '/tmp/cu-runtime-scheduling'; });
    expect(() => f.runtime.claimTargetFromHost(f.exec, lease.taskLeaseId)).toThrow();
    expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });

  it('derives claims only from a live exact lease and exposes a fixed non-dispatchable policy result', async () => {
    const f = fixture(); const c = f.claim();
    const result = await f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request);
    expect(result).toMatchObject({ outcome: 'returned', workStarted: true, value: { decision: 'ALLOW_WITHIN_LEASE', dispatchable: false } });
    expect(f.runtime.coordinationStatusFromHost()).toMatchObject({ state: 'idle', pendingCount: 0, claimedTargets: 1 });
    expect(f.runtime).not.toHaveProperty('queue'); expect(f.runtime).not.toHaveProperty('execute');
    f.runtime.releaseTargetFromHost(f.exec, c.claim); expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });

  it('excludes another Session from the same physical target but permits an unrelated window', () => {
    const f = fixture(); f.claim(); const other = f.caller('session_other');
    expect(() => f.claim(other.exec)).toThrow('CONTROL_BUSY'); expect(f.claim(other.exec, 8).claim).toBeDefined();
  });

  it('rejects copied/foreign claims and a request whose target or lease differs from the claim', async () => {
    const f = fixture(); const c = f.claim();
    await expect(f.runtime.queueEvaluationFromHost(f.exec, { ...c.claim }, c.request)).rejects.toThrow();
    await expect(f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, evaluation: evaluation(c.lease.taskLeaseId, 8) })).rejects.toThrow();
    const other = f.runtime.issueFromHost(f.exec, spec());
    await expect(f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, evaluation: evaluation(other.taskLeaseId) })).rejects.toThrow();
  });

  it('does not accept an execution function, approved flag or injected dispatch metadata', async () => {
    const f = fixture(); const c = f.claim(); let invoked = false;
    await expect(f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, work() { invoked = true; } })).rejects.toThrow('INVALID_REQUEST');
    await expect(f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, approved: true })).rejects.toThrow('INVALID_REQUEST'); expect(invoked).toBe(false);
  });

  it.each(['agent', 'session', 'directory', 'policy', 'dispose'] as const)('cancels queued fixed evaluations and retires claims on %s without starting the second item', async (event) => {
    const f = fixture(); const c = f.claim();
    const first = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request);
    const second = f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, actionId: 'action_second' });
    expect(f.runtime.coordinationStatusFromHost()).toMatchObject({ state: 'running', pendingCount: 1 });
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent); if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session); if (event === 'policy') f.runtime.policyChangedFromHost(); if (event === 'dispose') f.runtime.dispose();
    expect(await second).toEqual({ outcome: 'cancelled', workStarted: false }); expect(await first).toEqual({ outcome: 'cancelled', workStarted: true });
    expect(await f.runtime.waitForControlDrainFromHost()).toBe(true); expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });

  it('cancels a retired Session, conservatively rejects other in-flight epochs, but keeps the other lease usable by a fresh call', async () => {
    const f = fixture(); const c = f.claim(); const other = f.caller('session_other'); const d = f.claim(other.exec, 8);
    const first = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request); const second = f.runtime.queueEvaluationFromHost(other.exec, d.claim, d.request);
    f.runtime.sessionDisposedFromHost(f.session);
    expect(await first).toMatchObject({ outcome: 'cancelled', workStarted: true });
    expect(await second).toMatchObject({ outcome: 'rejected', workStarted: false });
    expect(await f.runtime.queueEvaluationFromHost(other.exec, d.claim, d.request)).toMatchObject({ outcome: 'returned', value: { dispatchable: false } });
  });

  it('stops outside the work queue, holds the slot until settle, then requires fresh lease and claim after resume', async () => {
    const f = fixture(); const c = f.claim(); const signal = f.runtime.signalForHost(f.exec, c.lease.taskLeaseId);
    const active = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request);
    const pending = f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, actionId: 'action_pending' });
    f.runtime.stopFromHost(); expect(signal.aborted).toBe(true);
    expect(f.runtime.coordinationStatusFromHost().state).toBe('stopping'); expect(() => f.runtime.resumeFromHost()).toThrow();
    await expect(f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request)).rejects.toThrow(); expect(() => f.runtime.issueFromHost(f.exec, spec())).toThrow('CONTROL_STOPPED');
    expect(await pending).toMatchObject({ outcome: 'cancelled', workStarted: false }); expect(await active).toMatchObject({ outcome: 'cancelled', workStarted: true });
    expect(await f.runtime.waitForControlDrainFromHost()).toBe(true); f.runtime.resumeFromHost();
    expect(f.runtime.evaluate(f.exec, evaluation(c.lease.taskLeaseId)).decision).toBe('DENY');
    const fresh = f.claim(); expect(await f.runtime.queueEvaluationFromHost(f.exec, fresh.claim, fresh.request)).toMatchObject({ outcome: 'returned' });
  });

  it('rechecks a later turn before starting a queued evaluation without leaking an allowed result', async () => {
    const f = fixture(); const c = f.claim(); const active = f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request);
    const queued = f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, actionId: 'action_other' }); f.turn(2);
    expect(await active).toMatchObject({ outcome: 'returned' }); expect(await queued).toMatchObject({ outcome: 'rejected', workStarted: false });
  });

  it('links a claim to lease expiry even when the staging caller finishes, without extending its idle TTL', () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const c = f.claim(); now += 30_000;
    expect(() => f.runtime.signalForHost(f.exec, c.lease.taskLeaseId)).toThrow();
    expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });

  it('lets an aborted owner release its own claim but denies cross-Session release authority', () => {
    const f = fixture(); const c = f.claim(); const other = f.caller('session_other');
    expect(() => f.runtime.releaseTargetFromHost(other.exec, c.claim)).toThrow();
    f.abort.abort(); f.runtime.releaseTargetFromHost(f.exec, c.claim); expect(f.runtime.coordinationStatusFromHost().claimedTargets).toBe(0);
  });
});
