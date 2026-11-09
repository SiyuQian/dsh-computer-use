import { performance } from 'node:perf_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureControlRuntime } from '../../src/service/fixture-control-runtime.js';

const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); vi.restoreAllMocks(); });
function fixture() {
  const agents = new Map<string, Agent>(); const sessions = new Map<string, Session>(); let turn = 1;
  const host = { agents: { get: (id: string) => agents.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: turn }) },
    sessions: { get: (id: string) => sessions.get(id) }, workingDirectory: { get: () => '/tmp/cu-evaluation-receipts' } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  const runtime = new FixtureControlRuntime(host); cleanups.push(() => runtime.dispose());
  function caller(id = 'session_fixture') {
    const session = Session.create(SessionId(id)); const agent = { id: session.id, session } as Agent; agents.set(id, agent); sessions.set(id, session);
    const abort = new AbortController(); return { session, agent, abort, exec: { agent, callId: ToolCallId('call_fixture'), signal: abort.signal } };
  }
  const first = caller();
  function claimed(impact = 'ordinary', exec = first.exec, windowId = 7) {
    const lease = runtime.issueFromHost(exec, { target: { ...target, windowId }, mode: 'background', ttlMs: 30_000, idleTimeoutMs: 30_000, maxActions: 2, allowedOperations: ['press'],
      targets: [{ handle: 'submit_fixture', identifier: 'fixture.submit', role: 'button', enabled: true, secure: false, impact }] });
    const claim = runtime.claimTargetFromHost(exec, lease.taskLeaseId);
    return { lease, claim, request: { actionId: 'action_fixture', evaluation: { leaseId: lease.taskLeaseId, target: { ...target, windowId },
      action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' } } };
  }
  function run(c: ReturnType<typeof claimed>, raw: unknown = c.request, exec = first.exec) {
    expect(runtime.queueEvaluationReceiptFromHost).toBeTypeOf('function'); return runtime.queueEvaluationReceiptFromHost(exec, c.claim, raw);
  }
  return { runtime, ...first, claimed, run, host, caller, turn(value: number) { turn = value; } };
}
const inert = { execution: 'not_executed', target: 'unknown', effect: 'unverified', taskOutcome: 'not_evaluated', evidence: [] };

describe('CU-013a2: truthful terminal receipts for private fixed policy evaluations, never dispatch', () => {
  it('reports an allowed policy evaluation as not executed and unsupported rather than a successful input', async () => {
    const f = fixture(); const c = f.claimed(); const report = await f.run(c);
    expect(report).toEqual({ terminal: true, dispatchable: false, receipt: { actionId: 'action_fixture', ...inert, error: { code: 'CAPABILITY_UNAVAILABLE', phase: 'authorize', retry: 'never' } } });
    expect(f.runtime.coordinationStatusFromHost().state).toBe('idle'); expect(f.runtime).not.toHaveProperty('receipts');
    expect(f.runtime).not.toHaveProperty('acknowledgeFromHost'); expect(f.runtime).not.toHaveProperty('dispatchPendingFromHost');
  });

  it.each(['unknown', 'high-impact'] as const)('reports a host %s risk gate without claiming approval or target exactness', async (impact) => {
    const f = fixture(); const c = f.claimed(impact); const report = await f.run(c);
    expect(report.receipt).toMatchObject({ ...inert, error: { code: impact === 'unknown' ? 'APPROVAL_REQUIRED' : 'CONTROL_DENIED', phase: impact === 'unknown' ? 'approve' : 'authorize', retry: 'never' } });
  });

  it('reports never-policy approval refusal in authorize and never opens an approval prompt', async () => {
    const f = fixture(); const c = f.claimed('unknown'); const raw = { ...c.request, evaluation: { ...c.request.evaluation, approvalMode: 'never' } };
    expect((await f.run(c, raw)).receipt).toMatchObject({ ...inert, error: { code: 'APPROVAL_UNAVAILABLE', phase: 'authorize' } });
  });

  it.each(['agent', 'session', 'directory', 'policy', 'dispose', 'stop'] as const)('seals active and pending evaluations on %s before their late result can change the terminal', async (event) => {
    const f = fixture(); const c = f.claimed(); const first = f.run(c); const second = f.run(c, { ...c.request, actionId: 'action_second' });
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent); if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session); if (event === 'policy') f.runtime.policyChangedFromHost();
    if (event === 'dispose') f.runtime.dispose(); if (event === 'stop') f.runtime.stopFromHost();
    for (const report of await Promise.all([first, second])) expect(report).toMatchObject({ terminal: true, dispatchable: false, receipt: { ...inert, error: { code: 'CANCELLED', phase: 'cancel', retry: 'never' } } });
    expect(await f.runtime.waitForControlDrainFromHost()).toBe(true);
  });

  it('does not let one retired Session cancel an unrelated receipt, even though the global epoch rejects its old queued call', async () => {
    const f = fixture(); const a = f.claimed(); const other = f.caller('session_other'); const b = f.claimed('ordinary', other.exec, 8);
    const first = f.run(a); const second = f.run(b, { ...b.request, actionId: 'action_other' }, other.exec);
    f.runtime.sessionDisposedFromHost(f.session);
    expect((await first).receipt.error?.code).toBe('CANCELLED'); expect((await second).receipt).toMatchObject({ ...inert, error: { code: 'CONTROL_DENIED', phase: 'authorize' } });
  });

  it('retains action-ID tombstones after terminal or policy clear instead of silently redoing a scheduling request', async () => {
    const f = fixture(); const c = f.claimed(); await f.run(c);
    await expect(f.run(c)).rejects.toThrow('ACTION_ID_CONFLICT'); f.runtime.policyChangedFromHost(); const fresh = f.claimed();
    await expect(f.run(fresh)).rejects.toThrow('ACTION_ID_CONFLICT');
  });

  it('does not reinterpret a scheduling workStarted flag or queued caller cancellation as an attempted input', async () => {
    const f = fixture(); const c = f.claimed(); const independent = { ...f.exec, signal: new AbortController().signal };
    const first = f.run(c, c.request, independent); const queued = f.run(c, { ...c.request, actionId: 'action_cancelled' }); f.abort.abort();
    expect((await first).receipt).toMatchObject(inert); expect((await queued).receipt).toMatchObject({ ...inert, error: { code: 'CANCELLED', phase: 'cancel' } });
  });

  it('rejects raw-authority injection and getter source failures before creating a receipt or exposing private payload', async () => {
    const f = fixture(); const c = f.claimed(); expect(f.runtime.queueEvaluationReceiptFromHost).toBeTypeOf('function');
    await expect(f.run(c, { ...c.request, execution: 'completed', target: 'exact', evidence: ['invented'] })).rejects.toThrow('INVALID_REQUEST');
    await expect(f.run(c, { get evaluation() { throw new Error('PRIVATE_PAYLOAD'); } })).rejects.toThrow('INVALID_REQUEST');
    expect((await f.run(c)).receipt).toMatchObject(inert);
  });

  it('captures the original turn before proposal getters and never creates a receipt from a later rebind', async () => {
    const f = fixture(); const c = f.claimed(); expect(f.runtime.queueEvaluationReceiptFromHost).toBeTypeOf('function');
    await expect(f.run(c, { ...c.request, get evaluation() { f.turn(2); return c.request.evaluation; } })).rejects.toThrow();
    f.turn(1); expect((await f.run(c)).receipt).toMatchObject(inert);
  });

  it('reports a queue capacity refusal at authorize rather than fabricating a denied policy decision', async () => {
    const f = fixture(); const c = f.claimed(); const jobs = [f.runtime.queueEvaluationFromHost(f.exec, c.claim, c.request)];
    for (let i = 0; i < 64; i += 1) jobs.push(f.runtime.queueEvaluationFromHost(f.exec, c.claim, { ...c.request, actionId: `action_raw_${i}` }));
    const report = await f.run(c, { ...c.request, actionId: 'action_capacity' });
    expect(report.receipt).toMatchObject({ ...inert, error: { code: 'CONTROL_BUSY', phase: 'authorize', retry: 'never' } }); await Promise.all(jobs);
  });

  it('reports a queued expired lease without claiming it dispatched or passed native revalidation', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture(); const c = f.claimed();
    const first = f.run(c); const queued = f.run(c, { ...c.request, actionId: 'action_expired' }); now += 30_000;
    expect((await first).receipt).toMatchObject(inert); expect((await queued).receipt).toMatchObject({ ...inert, error: { code: 'CANCELLED', phase: 'cancel' } });
  });

  it('does not inspect arbitrary thrown values to classify queue errors or echo a forged capacity message', async () => {
    const f = fixture(); const c = f.claimed(); let enabled = false; let inspected = false;
    vi.spyOn(f.host.workingDirectory, 'get').mockImplementation(() => {
      if (enabled) throw { get message() { inspected = true; return 'CONTROL_CAPACITY: PRIVATE_RAW'; }, get code() { inspected = true; return 'CONTROL_CAPACITY'; } };
      return '/tmp/cu-evaluation-receipts';
    });
    const raw = { ...c.request, get evaluation() { queueMicrotask(() => { enabled = true; }); return c.request.evaluation; } };
    const report = await f.run(c, raw); expect(report.receipt).toMatchObject({ ...inert, error: { code: 'CONTROL_DENIED', phase: 'authorize' } });
    expect(inspected).toBe(false); expect(JSON.stringify(report)).not.toContain('PRIVATE_RAW');
  });

  it('bounds terminal receipt tombstones and does not regain capacity after policy clear', async () => {
    const f = fixture(); const c = f.claimed();
    for (let i = 0; i < 64; i += 1) await f.run(c, { ...c.request, actionId: `action_terminal_${i}` });
    await expect(f.run(c, { ...c.request, actionId: 'action_overflow' })).rejects.toThrow('RECEIPT_CAPACITY');
    f.runtime.policyChangedFromHost(); const next = f.claimed(); await expect(f.run(next, { ...next.request, actionId: 'action_after_policy' })).rejects.toThrow('RECEIPT_CAPACITY');
  });

  it('never reruns the original caller proposal getters during queue wait or receipt settlement', async () => {
    const f = fixture(); const c = f.claimed(); let calls = 0; const raw = { ...c.request, get evaluation() { calls += 1; return c.request.evaluation; } };
    const result = await f.run(c, raw); expect(calls).toBe(1); expect(result.receipt).toMatchObject(inert);
  });

  it('does not let a forged or foreign claim reveal another owner receipt by reusing its action ID', async () => {
    const f = fixture(); const c = f.claimed(); const original = await f.run(c); const other = f.caller('session_other');
    await expect(f.run(c, c.request, other.exec)).rejects.toThrow('ACTION_ID_CONFLICT'); expect(original.receipt).toMatchObject(inert);
    const report = await f.runtime.queueEvaluationReceiptFromHost(other.exec, { ...c.claim }, { ...c.request, actionId: 'action_foreign_claim' });
    expect(report.receipt).toMatchObject({ ...inert, error: { code: 'CONTROL_DENIED', phase: 'authorize' } });
  });

  it('does not reopen a cancelled receipt after stop/drain/resume with a fresh lease', async () => {
    const f = fixture(); const c = f.claimed(); const pending = f.run(c); f.runtime.stopFromHost();
    expect((await pending).receipt.error?.code).toBe('CANCELLED'); expect(await f.runtime.waitForControlDrainFromHost()).toBe(true); f.runtime.resumeFromHost();
    const fresh = f.claimed(); await expect(f.run(fresh)).rejects.toThrow('ACTION_ID_CONFLICT');
    expect((await f.run(fresh, { ...fresh.request, actionId: 'action_fresh_after_stop' })).receipt).toMatchObject(inert);
  });

  it('seals a receipt before a lease abort observer can submit a replacement action during policy cleanup', async () => {
    const f = fixture(); const c = f.claimed(); const signal = f.runtime.signalForHost(f.exec, c.lease.taskLeaseId); let reentrant: Promise<unknown> | undefined;
    const active = f.run(c);
    signal.addEventListener('abort', () => { reentrant = f.runtime.queueEvaluationReceiptFromHost(f.exec, c.claim, { ...c.request, actionId: 'action_reentry' }).catch(() => 'rejected'); }, { once: true });
    f.runtime.policyChangedFromHost(); expect(await reentrant).toBe('rejected'); expect((await active).receipt).toMatchObject({ ...inert, error: { code: 'CANCELLED', phase: 'cancel' } });
  });

  it('does not infer a task result or evidence when a completed policy evaluation is followed by a changed turn before settlement', async () => {
    const f = fixture(); const c = f.claimed(); const pending = f.run(c); f.turn(2);
    expect((await pending).receipt).toMatchObject({ ...inert, error: { code: 'CONTROL_DENIED', phase: 'authorize', retry: 'never' } });
  });

  it('does not charge the native attempt budget merely by producing unsupported evaluation receipts', async () => {
    const f = fixture(); const c = f.claimed();
    for (let i = 0; i < 3; i += 1) expect((await f.run(c, { ...c.request, actionId: `action_no_native_${i}` })).receipt.error?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(f.runtime.evaluate(f.exec, c.request.evaluation).decision).toBe('ALLOW_WITHIN_LEASE');
  });

  it('keeps a real fixed policy refusal distinct from an unavailable execution capability', async () => {
    const f = fixture(); const c = f.claimed(); const request = { ...c.request, evaluation: { ...c.request.evaluation, action: { kind: 'press', targetHandle: 'element_not_allowed' } } };
    expect((await f.run(c, request)).receipt).toMatchObject({ ...inert, error: { code: 'CONTROL_DENIED', phase: 'authorize', retry: 'never' } });
  });

  it('returns isolated receipts and never stores raw value payloads in a returned report', async () => {
    const f = fixture(); const c = f.claimed(); const report = await f.run(c); report.receipt.evidence.push({ kind: 'target_readback', evidenceId: 'evidence_fake' });
    const next = await f.run(c, { ...c.request, actionId: 'action_second' }); expect(next.receipt.evidence).toEqual([]); expect(JSON.stringify(next)).not.toContain('submit_fixture');
  });
});
