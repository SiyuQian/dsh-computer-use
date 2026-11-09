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
function spec() { return { target: { ...target }, mode: 'background', ttlMs: 120_000, idleTimeoutMs: 120_000, maxActions: 3, allowedOperations: ['set_value'],
  targets: [{ handle: 'text_fixture', identifier: 'fixture.text', role: 'text-field', enabled: true, secure: false, impact: 'unknown' }] }; }
function fixture() {
  const agents = new Map<string, Agent>(); const sessions = new Map<string, Session>(); const dirs = new Map<Session, string>(); let turn = 1;
  const host = { agents: { get: (id: string) => agents.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: turn }) },
    sessions: { get: (id: string) => sessions.get(id) }, workingDirectory: { get: (session: Session) => dirs.get(session)! } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  const runtime = new FixtureControlRuntime(host); cleanups.push(() => runtime.dispose());
  function caller(id = 'session_fixture') { const session = Session.create(SessionId(id)); const agent = { id: session.id, session } as Agent;
    agents.set(id, agent); sessions.set(id, session); dirs.set(session, '/tmp/cu-runtime-approvals'); const abort = new AbortController();
    const exec: Call = { agent, callId: ToolCallId('call_fixture'), signal: abort.signal }; return { agent, session, exec, abort }; }
  const first = caller(); const lease = runtime.issueFromHost(first.exec, spec());
  const proposal = { actionId: 'action_fixture', leaseId: lease.taskLeaseId, observationId: 'observation_host_declared', materialContext: 'context_host_declared',
    target: { ...target }, action: { kind: 'set_value', targetHandle: 'text_fixture', value: 'public-approval-text' }, approvalMode: 'request', raiseRisk: false };
  return { runtime, ...first, lease, proposal, host, caller, turn(value: number) { turn = value; }, directory(value: string) { dirs.set(first.session, value); },
    prepare() { expect(runtime.prepareApprovalFromHost).toBeTypeOf('function'); return runtime.prepareApprovalFromHost(first.exec, proposal); },
  };
}

describe('CU-009a2: private approval binding to live inert control leases, never user consent or execution', () => {
  it('requires an explicit exact simulated host answer and consumes only once with dispatch disabled', () => {
    const f = fixture(); const pending = f.prepare();
    expect(JSON.stringify(pending)).not.toContain('public-approval-text'); expect(pending).not.toHaveProperty('fingerprint');
    f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    expect(f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toEqual({ status: 'consumed', dispatchable: false });
    expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toThrow('APPROVAL_INVALIDATED');
    expect(f.runtime).not.toHaveProperty('approvals'); expect(f.runtime).not.toHaveProperty('execute');
  });

  it('does not treat a summary or pending ID as an approval', () => {
    const f = fixture(); const pending = f.prepare();
    expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toThrow('APPROVAL_INVALIDATED');
    expect(() => f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
  });

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('does not turn %s into a later allowed-once answer', (outcome) => {
    const f = fixture(); const pending = f.prepare(); f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, outcome);
    expect(() => f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once')).toThrow();
    expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toThrow();
  });

  it.each(['input', 'actionId', 'leaseId', 'observationId', 'materialContext', 'target', 'risk'] as const)('rejects a host answer for changed %s and cannot return to the original proposal', (field) => {
    const f = fixture(); const pending = f.prepare(); const changed = structuredClone(f.proposal);
    if (field === 'input') changed.action.value += '!'; if (field === 'actionId') changed.actionId = 'action_other'; if (field === 'leaseId') changed.leaseId = 'lease_other';
    if (field === 'observationId') changed.observationId = 'observation_other'; if (field === 'materialContext') changed.materialContext = 'context_other';
    if (field === 'target') changed.target.windowInstance = 'window_other'; if (field === 'risk') changed.raiseRisk = true;
    expect(() => f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, changed, 'allowed-once')).toThrow();
    expect(() => f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once')).toThrow();
  });

  it.each(['agent', 'session', 'directory', 'policy', 'dispose'] as const)('invalidates pending and decided approval records before %s lease-abort notifications', (event) => {
    const f = fixture(); const pending = f.prepare(); f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    let notified = false; f.runtime.signalForHost(f.exec, f.lease.taskLeaseId).addEventListener('abort', () => {
      notified = true; expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toThrow('HOST_CONTEXT_UNAVAILABLE');
    }, { once: true });
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent); if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session); if (event === 'policy') f.runtime.policyChangedFromHost(); if (event === 'dispose') f.runtime.dispose();
    expect(notified).toBe(true); expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toThrow();
  });

  it('does not destroy a surviving Session approval when another Session is revoked', () => {
    const f = fixture(); const first = f.prepare(); const other = f.caller('session_other'); const lease = f.runtime.issueFromHost(other.exec, spec());
    const proposal = { ...structuredClone(f.proposal), leaseId: lease.taskLeaseId }; const second = f.runtime.prepareApprovalFromHost(other.exec, proposal);
    f.runtime.sessionDisposedFromHost(other.session);
    expect(() => f.runtime.consumeApprovalFromHost(other.exec, second.approvalId, proposal)).toThrow();
    f.runtime.decideApprovalFromHost(f.exec, first.approvalId, f.proposal, 'allowed-once'); expect(f.runtime.consumeApprovalFromHost(f.exec, first.approvalId, f.proposal).status).toBe('consumed');
  });

  it.each(['decide', 'consume'] as const)('does not let a foreign scope %s or destroy the owner approval using a copied ID', (operation) => {
    const f = fixture(); const pending = f.prepare(); const other = f.caller('session_other'); const lease = f.runtime.issueFromHost(other.exec, spec());
    const proposal = { ...structuredClone(f.proposal), leaseId: lease.taskLeaseId };
    if (operation === 'decide') expect(() => f.runtime.decideApprovalFromHost(other.exec, pending.approvalId, proposal, 'allowed-once')).toThrow();
    else expect(() => f.runtime.consumeApprovalFromHost(other.exec, pending.approvalId, proposal)).toThrow();
    f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    expect(f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal).status).toBe('consumed');
  });

  it('cannot decide an approval after its short-lived lease expires before the approval deadline', () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const raw = { ...spec(), ttlMs: 5_000, idleTimeoutMs: 5_000 };
    const lease = f.runtime.issueFromHost(f.exec, raw); const proposal = { ...f.proposal, leaseId: lease.taskLeaseId };
    const pending = f.runtime.prepareApprovalFromHost(f.exec, proposal); now += 5_000;
    expect(() => f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, proposal, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
  });

  it('never approves never-policy, a denied target, or a lease whose risk no longer requires approval', () => {
    const f = fixture(); expect(f.runtime.prepareApprovalFromHost).toBeTypeOf('function');
    expect(() => f.runtime.prepareApprovalFromHost(f.exec, { ...f.proposal, approvalMode: 'never' })).toThrow('APPROVAL_INVALIDATED');
    const raw = spec(); raw.targets[0]!.impact = 'ordinary'; const ordinary = f.runtime.issueFromHost(f.exec, raw);
    expect(() => f.runtime.prepareApprovalFromHost(f.exec, { ...f.proposal, leaseId: ordinary.taskLeaseId })).toThrow('APPROVAL_INVALIDATED');
    raw.targets[0]!.impact = 'high-impact'; const high = f.runtime.issueFromHost(f.exec, raw);
    expect(() => f.runtime.prepareApprovalFromHost(f.exec, { ...f.proposal, leaseId: high.taskLeaseId })).toThrow('APPROVAL_INVALIDATED');
  });

  it('expires approval at sixty seconds even though its control lease is still live', () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const pending = f.prepare(); f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once'); now += 60_000;
    expect(f.runtime.evaluate(f.exec, { leaseId: f.lease.taskLeaseId, target, action: f.proposal.action, approvalMode: 'request' }).decision).toBe('REQUIRE_APPROVAL');
    expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toThrow('APPROVAL_INVALIDATED');
  });

  it('rejects a later turn and a same-ID replacement without transferring approved state', () => {
    const f = fixture(); const pending = f.prepare(); f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    f.turn(2); expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toThrow();
    const next = f.caller(); expect(() => f.runtime.consumeApprovalFromHost(next.exec, pending.approvalId, f.proposal)).toThrow();
  });

  it.each(['policyVersion', 'revocationVersion', 'riskReason', 'approved', 'mode'] as const)('rejects injected %s rather than trusting model policy metadata', (field) => {
    const f = fixture(); expect(f.runtime.prepareApprovalFromHost).toBeTypeOf('function');
    expect(() => f.runtime.prepareApprovalFromHost(f.exec, { ...f.proposal, [field]: 'public-injection' })).toThrow('INVALID_REQUEST');
  });

  it.each(['prepare', 'decide', 'consume'] as const)('pins the original turn before a %s proposal getter can silently advance it', (phase) => {
    const f = fixture(); const pending = f.prepare();
    if (phase === 'consume') f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    const raw = { ...f.proposal, get action() { f.turn(2); return f.proposal.action; } };
    expect(() => {
      if (phase === 'prepare') f.runtime.prepareApprovalFromHost(f.exec, raw);
      if (phase === 'decide') f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, raw, 'allowed-once');
      if (phase === 'consume') f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, raw);
    }).toThrow();
  });

  it.each(['prepare', 'decide', 'consume'] as const)('redacts proposal getter errors during %s and removes a failed decision ticket', (phase) => {
    const f = fixture(); const pending = f.prepare();
    if (phase === 'consume') f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    const raw = { ...f.proposal, get action() { throw new Error('PUBLIC_PROPOSAL_GETTER_ERROR'); } }; let failure: unknown;
    try {
      if (phase === 'prepare') f.runtime.prepareApprovalFromHost(f.exec, raw);
      if (phase === 'decide') f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, raw, 'allowed-once');
      if (phase === 'consume') f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, raw);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain('PUBLIC_PROPOSAL_GETTER_ERROR');
    if (phase !== 'prepare') expect(() => f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once')).toThrow();
  });

  it('does not consume an approved record if the final host getter retires its scope', () => {
    const f = fixture(); const pending = f.prepare(); f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    let reads = 0; const current = f.host.workingDirectory.get.bind(f.host.workingDirectory);
    f.host.workingDirectory.get = (session) => { reads += 1; if (reads === 6) f.runtime.workspaceChangedFromHost(session); return current(session); };
    expect(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal)).toThrow();
  });

  it('releases a full pending registry on scope revocation without retaining a hidden capacity leak', () => {
    const f = fixture(); for (let i = 0; i < 64; i += 1) f.prepare();
    expect(() => f.prepare()).toThrow('APPROVAL_INVALIDATED');
    f.runtime.workspaceChangedFromHost(f.session); const lease = f.runtime.issueFromHost(f.exec, spec());
    const proposal = { ...f.proposal, leaseId: lease.taskLeaseId };
    for (let i = 0; i < 64; i += 1) expect(f.runtime.prepareApprovalFromHost(f.exec, proposal).approvalId).toMatch(/^approval_/);
  });

  it('has only one consumer for an approved runtime binding under concurrent scheduling', async () => {
    const f = fixture(); const pending = f.prepare(); f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    const results = await Promise.allSettled([1, 2].map(() => Promise.resolve().then(() => f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it.each(['prepare', 'decide', 'consume'] as const)('rechecks the host when the last policy clock call changes during %s', (phase) => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const pending = f.prepare();
    if (phase === 'consume') f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
    let reads = 0; vi.spyOn(performance, 'now').mockImplementation(() => { reads += 1; if (reads === (phase === 'prepare' ? 7 : 8)) f.runtime.policyChangedFromHost(); return now; });
    expect(() => {
      if (phase === 'prepare') f.runtime.prepareApprovalFromHost(f.exec, f.proposal);
      if (phase === 'decide') f.runtime.decideApprovalFromHost(f.exec, pending.approvalId, f.proposal, 'allowed-once');
      if (phase === 'consume') f.runtime.consumeApprovalFromHost(f.exec, pending.approvalId, f.proposal);
    }).toThrow();
    now += 1;
  });

  it('cancels pending binding when its original caller or lease signal aborts', () => {
    const f = fixture(); const pending = f.prepare(); f.abort.abort();
    const exec = { ...f.exec, signal: new AbortController().signal };
    expect(() => f.runtime.decideApprovalFromHost(exec, pending.approvalId, f.proposal, 'allowed-once')).toThrow();
  });
});
