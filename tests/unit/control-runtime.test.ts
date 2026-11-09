import { performance } from 'node:perf_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixtureReadRuntime } from '../../src/service/fixture-read-runtime.js';

type Module = typeof import('../../src/service/fixture-control-runtime.js');
let module: Module;
beforeAll(async () => { const path = '../../src/service/fixture-control-runtime.js'; module = await import(path).catch(() => ({} as Module)); });
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
function spec() { return { target: { ...target }, mode: 'background', ttlMs: 30_000, idleTimeoutMs: 30_000, maxActions: 3, allowedOperations: ['press'],
  targets: [{ handle: 'submit_fixture', identifier: 'fixture.submit', role: 'button', enabled: true, secure: false, impact: 'ordinary' }] }; }
function request(leaseId: string) { return { leaseId, target: { ...target }, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' }; }
type Call = Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
function fixture(maxScopes = 64) {
  expect(module.FixtureControlRuntime).toBeTypeOf('function');
  const agents = new Map<string, Agent>(); const sessions = new Map<string, Session>(); const directories = new Map<Session, string>(); let open = true;
  const host = { agents: { get: (id: string) => agents.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: open ? SessionSeq(1) : null, lastTurn: 1 }) },
    sessions: { get: (id: string) => sessions.get(id) }, workingDirectory: { get: (session: Session) => directories.get(session)! } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  const runtime = new module.FixtureControlRuntime(host, { maxScopes }); cleanups.push(() => runtime.dispose());
  function caller(id = 'session_fixture') { const session = Session.create(SessionId(id)); const agent = { id: session.id, session } as Agent;
    agents.set(id, agent); sessions.set(id, session); directories.set(session, '/tmp/cu-control-runtime');
    const abort = new AbortController(); const exec: Call = { agent, callId: ToolCallId('call_fixture'), signal: abort.signal }; return { session, agent, exec, abort }; }
  const first = caller();
  return { ...first, runtime, host, agents, sessions, caller, closeTurn() { open = false; }, directory(value: string) { directories.set(first.session, value); },
    issue(exec = first.exec) { return runtime.issueFromHost(exec, spec()); },
  };
}

describe('CU-008b1a: exact-host inert control lease lifecycle, no dispatch or approval execution', () => {
  it('denies invented leases and evaluates only explicit static host leases without exporting policy', () => {
    const f = fixture(); expect(f.runtime.evaluate(f.exec, request('lease_model')).decision).toBe('DENY');
    const lease = f.issue(); expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId))).toMatchObject({ decision: 'ALLOW_WITHIN_LEASE', dispatchable: false, requiresNativeRevalidation: true });
    expect(f.runtime).not.toHaveProperty('policy'); expect(f.runtime).not.toHaveProperty('execute');
  });

  it.each(['agent', 'session', 'directory', 'policy', 'dispose'] as const)('revokes the lease and closes new admission during %s abort notifications', (event) => {
    const f = fixture(); const lease = f.issue(); let notified = false;
    const signal = f.runtime.signalForHost(f.exec, lease.taskLeaseId);
    signal.addEventListener('abort', () => {
      notified = true; expect(() => f.issue()).toThrow('HOST_CONTEXT_UNAVAILABLE');
      expect(() => f.runtime.evaluate(f.exec, request(lease.taskLeaseId))).toThrow('HOST_CONTEXT_UNAVAILABLE');
    }, { once: true });
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent);
    if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session);
    if (event === 'policy') f.runtime.policyChangedFromHost();
    if (event === 'dispose') f.runtime.dispose();
    expect(notified).toBe(true); expect(signal.aborted).toBe(true);
    if (event === 'directory' || event === 'policy') {
      expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('DENY');
      expect(f.runtime.evaluate(f.exec, request(f.issue().taskLeaseId)).dispatchable).toBe(false);
    }
  });

  it('does not invalidate another exact Session and does not treat same-ID fake disposal as authority', () => {
    const f = fixture(); const first = f.issue(); const other = f.caller('session_other'); const second = f.issue(other.exec);
    f.runtime.sessionDisposedFromHost(Session.create(f.session.id));
    expect(f.runtime.evaluate(f.exec, request(first.taskLeaseId)).decision).toBe('ALLOW_WITHIN_LEASE');
    f.runtime.sessionDisposedFromHost(other.session);
    expect(f.runtime.evaluate(f.exec, request(first.taskLeaseId)).decision).toBe('ALLOW_WITHIN_LEASE');
    expect(() => f.runtime.evaluate(other.exec, request(second.taskLeaseId))).toThrow();
  });

  it('retires same-ID registry replacements before capacity checks and never transfers an old lease', () => {
    const f = fixture(1); const lease = f.issue(); const signal = f.runtime.signalForHost(f.exec, lease.taskLeaseId);
    const next = f.caller(); const fresh = f.issue(next.exec); expect(signal.aborted).toBe(true);
    expect(f.runtime.evaluate(next.exec, request(lease.taskLeaseId)).decision).toBe('DENY');
    expect(f.runtime.evaluate(next.exec, request(fresh.taskLeaseId)).decision).toBe('ALLOW_WITHIN_LEASE');
  });

  it('rejects scope capacity without evicting another live lease', () => {
    const f = fixture(1); const lease = f.issue(); const other = f.caller('session_other');
    expect(() => f.issue(other.exec)).toThrow('CONTROL_CAPACITY');
    expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('ALLOW_WITHIN_LEASE');
  });

  it('discovers a missed cwd change and never revives a lease after returning to the old directory', () => {
    const f = fixture(); const lease = f.issue(); const signal = f.runtime.signalForHost(f.exec, lease.taskLeaseId);
    f.directory('/tmp/cu-other'); expect(() => f.runtime.evaluate(f.exec, request(lease.taskLeaseId))).toThrow(); expect(signal.aborted).toBe(true);
    f.directory('/tmp/cu-control-runtime'); expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('DENY');
  });

  it.each(['policy', 'directory', 'dispose'] as const)('does not publish a lease across a %s transition in a spec getter', (event) => {
    const f = fixture(); let changed = false; const raw = spec();
    const input = { ...raw, get target() { if (!changed) { changed = true;
      if (event === 'policy') f.runtime.policyChangedFromHost();
      if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session);
      if (event === 'dispose') f.runtime.dispose();
    } return target; } };
    expect(() => f.runtime.issueFromHost(f.exec, input)).toThrow();
    if (event !== 'dispose') expect(f.issue().taskLeaseId).toMatch(/^lease_/);
  });

  it('does not return ALLOW if evaluation getters revoke the policy after the original host bind', () => {
    const f = fixture(); const lease = f.issue(); const input = { ...request(lease.taskLeaseId), get target() { f.runtime.policyChangedFromHost(); return target; } };
    expect(f.runtime.evaluate(f.exec, input).decision).toBe('DENY');
  });

  it('denies ordinary-looking high-impact metadata and never treats a request flag as approval', () => {
    const f = fixture(); const raw = spec(); raw.targets[0]!.impact = 'high-impact';
    const lease = f.runtime.issueFromHost(f.exec, raw); expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId))).toMatchObject({ decision: 'DENY', dispatchable: false });
    expect(() => f.runtime.evaluate(f.exec, { ...request(lease.taskLeaseId), approved: true })).toThrow('INVALID_REQUEST');
  });

  it.each(['closed_turn', 'abort', 'missing_agent'] as const)('requires actual open host context after %s', (fault) => {
    const f = fixture(); const lease = f.issue();
    if (fault === 'closed_turn') f.closeTurn(); if (fault === 'abort') f.abort.abort(); if (fault === 'missing_agent') f.agents.delete(f.agent.id);
    expect(() => f.runtime.evaluate(f.exec, request(lease.taskLeaseId))).toThrow('HOST_CONTEXT_UNAVAILABLE');
  });

  it.each(['issue', 'evaluate', 'signal'] as const)('redacts original exec getter errors on %s', (operation) => {
    const f = fixture(); const lease = f.issue(); const exec = { ...f.exec, get signal(): AbortSignal { throw new Error('public-exec-error'); } };
    let error: unknown;
    try {
      if (operation === 'issue') f.runtime.issueFromHost(exec, spec());
      if (operation === 'evaluate') f.runtime.evaluate(exec, request(lease.taskLeaseId));
      if (operation === 'signal') f.runtime.signalForHost(exec, lease.taskLeaseId);
    } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('public-exec-error');
  });

  it.each(['issue', 'evaluate'] as const)('redacts request getters during %s instead of escaping caller errors', (operation) => {
    const f = fixture(); const lease = f.issue();
    const raw = operation === 'issue' ? spec() : request(lease.taskLeaseId);
    const input = { ...raw, get target() { throw new Error('public-target-getter-error'); } };
    let error: unknown;
    try { if (operation === 'issue') f.runtime.issueFromHost(f.exec, input); else f.runtime.evaluate(f.exec, input); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('public-target-getter-error');
  });

  it.each(['issue', 'evaluate', 'signal'] as const)('refuses a host transition in the last policy clock read during %s', (operation) => {
    const f = fixture(); const lease = f.issue(); let calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      calls += 1; if (calls === (operation === 'signal' ? 1 : 2)) f.runtime.policyChangedFromHost(); return 10_000;
    });
    if (operation === 'issue') expect(() => f.issue()).toThrow();
    if (operation === 'evaluate') expect(f.runtime.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('DENY');
    if (operation === 'signal') expect(() => f.runtime.signalForHost(f.exec, lease.taskLeaseId)).toThrow();
  });

  it('does not publish a lease if the final host cwd getter closes the open turn after its first check', () => {
    const f = fixture(); let gets = 0;
    f.host.workingDirectory.get = () => { gets += 1; if (gets === 2) f.closeTurn(); return '/tmp/cu-control-runtime'; };
    expect(() => f.issue()).toThrow('HOST_CONTEXT_UNAVAILABLE');
  });

  it('does not bind evaluation to a mutable caller DTO after closed parsing', () => {
    const f = fixture(); const lease = f.issue(); let reads = 0;
    const raw = { ...request(lease.taskLeaseId), get leaseId() { reads += 1; return reads === 1 ? lease.taskLeaseId : 'lease_model'; } };
    expect(f.runtime.evaluate(f.exec, raw).decision).toBe('ALLOW_WITHIN_LEASE'); expect(reads).toBe(1);
  });

  it('does not revoke a static lease when a single caller aborts after a completed evaluation', () => {
    const f = fixture(); const lease = f.issue(); const signal = f.runtime.signalForHost(f.exec, lease.taskLeaseId);
    f.abort.abort(); expect(signal.aborted).toBe(false);
    const next = { ...f.exec, signal: new AbortController().signal };
    expect(f.runtime.evaluate(next, request(lease.taskLeaseId)).decision).toBe('ALLOW_WITHIN_LEASE');
  });

  it('does not convert a read grant into a control lease or a control lease into a read grant', async () => {
    const f = fixture(); const lease = f.issue(); let reads = 0;
    const read = new FixtureReadRuntime(f.host, { observe: async () => { reads += 1; throw new Error('unexpected backend'); }, revalidate: async () => { throw new Error('unused'); } });
    cleanups.push(() => read.dispose());
    const grant = read.grantFromHost(f.exec, target, { ttlMs: 30_000 });
    expect(f.runtime.evaluate(f.exec, request(grant)).decision).toBe('DENY');
    await expect(read.observe(f.exec, lease.taskLeaseId, target)).rejects.toThrow('READ_DENIED'); expect(reads).toBe(0);
    f.runtime.policyChangedFromHost();
    expect(read.grantFromHost(f.exec, target, { ttlMs: 30_000 })).toMatch(/^read_grant_/);
  });

  it('does not inherit a lease in a new generation', () => {
    const f = fixture(); const lease = f.issue(); f.runtime.dispose();
    const next = new module.FixtureControlRuntime(f.host); cleanups.push(() => next.dispose());
    expect(next.evaluate(f.exec, request(lease.taskLeaseId)).decision).toBe('DENY');
  });
});
