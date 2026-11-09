import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type Module = typeof import('../../src/service/fixture-read-runtime.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/service/fixture-read-runtime.js';
  module = await import(path).catch(() => ({} as Module));
});
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
const element = { identifier: 'fixture.text', instance: 'element_text_lifetime', operation: 'set_value' };
const snapshot = { ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 },
  nodes: [{ nativeId: 'node_0', identifier: 'fixture.text', elementInstance: 'element_text_lifetime', role: 'AXTextField', subrole: '', label: 'Fixture text', enabled: true, secure: false, actions: ['set_value'], depth: 1 }], truncated: false, reasons: [] };
function observed() { return { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'ok', snapshot: structuredClone(snapshot) }; }
function exact() { return { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'exact', dispatchable: false, target: structuredClone(target), element: structuredClone(element) }; }
type Call = Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(maxScopes = 64) {
  expect(module.FixtureReadRuntime).toBeTypeOf('function');
  const agents = new Map<string, Agent>(); const sessions = new Map<string, Session>(); const directories = new Map<Session, string>();
  let open = true;
  const host = { agents: { get: (id: string) => agents.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: open ? SessionSeq(1) : null, lastTurn: 1 }) },
    sessions: { get: (id: string) => sessions.get(id) }, workingDirectory: { get: (session: Session) => directories.get(session)! } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  let observeCalls = 0; let revalidateCalls = 0;
  let observe: (signal: AbortSignal) => Promise<unknown> = async () => observed();
  let revalidate: (signal: AbortSignal) => Promise<unknown> = async () => exact();
  const runtime = new module.FixtureReadRuntime(host, {
    observe: async (received, signal) => { observeCalls += 1; expect(received).toEqual(target); return observe(signal); },
    revalidate: async (received, descriptor, signal) => { revalidateCalls += 1; expect(received).toEqual(target); expect(descriptor).toEqual(element); return revalidate(signal); },
  }, { maxScopes });
  cleanups.push(() => runtime.dispose());
  function caller(id = 'session_fixture') {
    const session = Session.create(SessionId(id)); const agent = { id: session.id, session } as Agent;
    agents.set(id, agent); sessions.set(id, session); directories.set(session, '/tmp/cu-read-runtime');
    const abort = new AbortController(); const exec: Call = { agent, callId: ToolCallId('call_fixture'), signal: abort.signal };
    return { session, agent, exec, abort };
  }
  const first = caller();
  return { runtime, ...first, caller, agents, sessions, host,
    directory(session: Session, value: string) { directories.set(session, value); }, closeTurn() { open = false; },
    observe(fn: typeof observe) { observe = fn; }, revalidate(fn: typeof revalidate) { revalidate = fn; },
    counts: () => ({ observe: observeCalls, revalidate: revalidateCalls }),
    grant(exec = first.exec) { return runtime.grantFromHost(exec, target, { ttlMs: 30_000 }); },
  };
}
async function member(f: ReturnType<typeof fixture>, grant: string, exec = f.exec) {
  const observation = await f.runtime.observe(exec, grant, target);
  return { observationId: observation.observationId, handle: observation.elements[0]!.handle, operation: 'set_value' as const };
}

describe('CU-008a2: internal read runtime lifecycle, never control or consent', () => {
  it('denies by default, binds fresh host context and composes observation/private handle revalidation', async () => {
    const f = fixture(); await expect(f.runtime.observe(f.exec, 'model_grant', target)).rejects.toThrow('READ_DENIED');
    expect(f.counts()).toEqual({ observe: 0, revalidate: 0 });
    const grant = f.grant(); const request = await member(f, grant);
    expect(await f.runtime.revalidate(f.exec, grant, request)).toEqual({ status: 'exact', dispatchable: false, requiresNativeRevalidation: true, ...request });
    expect(f.counts()).toEqual({ observe: 1, revalidate: 1 });
    expect(f.runtime).not.toHaveProperty('authority'); expect(f.runtime).not.toHaveProperty('observations');
  });

  it.each(['agent', 'session', 'directory', 'dispose', 'policy'] as const)('cancels an in-flight read on %s and rejects its late result', async (event) => {
    const f = fixture(); const grant = f.grant(); let finish!: (value: unknown) => void; let backendSignal!: AbortSignal;
    f.observe((signal) => { backendSignal = signal; return new Promise((resolve) => { finish = resolve; }); });
    const promise = f.runtime.observe(f.exec, grant, target);
    expect(backendSignal.aborted).toBe(false);
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent);
    if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session);
    if (event === 'policy') f.runtime.policyChangedFromHost();
    if (event === 'dispose') f.runtime.dispose();
    expect(backendSignal.aborted).toBe(true);
    finish(observed()); await expect(promise).rejects.toThrow();
    await expect(f.runtime.observe(f.exec, grant, target)).rejects.toThrow(); expect(f.counts().observe).toBe(1);
  });

  it.each(['agent', 'session', 'directory', 'dispose', 'policy'] as const)('invalidates old handles and refuses late exact after %s', async (event) => {
    const f = fixture(); const grant = f.grant(); const request = await member(f, grant);
    let finish!: (value: unknown) => void; let backendSignal!: AbortSignal;
    f.revalidate((signal) => { backendSignal = signal; return new Promise((resolve) => { finish = resolve; }); });
    const promise = f.runtime.revalidate(f.exec, grant, request);
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent);
    if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session);
    if (event === 'policy') f.runtime.policyChangedFromHost();
    if (event === 'dispose') f.runtime.dispose();
    expect(backendSignal.aborted).toBe(true); finish(exact()); await expect(promise).rejects.toThrow();
    if (event === 'directory' || event === 'policy') {
      const fresh = f.grant(); await expect(f.runtime.revalidate(f.exec, fresh, request)).rejects.toThrow('OBSERVATION_EXPIRED');
    }
    expect(f.counts().revalidate).toBe(1);
  });

  it.each(['agent', 'session'] as const)('retires the exact %s even if a stale host registry still lists it; same-ID new objects do not inherit', async (event) => {
    const f = fixture(); const grant = f.grant();
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent); else f.runtime.sessionDisposedFromHost(f.session);
    expect(() => f.grant()).toThrow('HOST_CONTEXT_UNAVAILABLE');
    const fresh = f.caller();
    await expect(f.runtime.observe(fresh.exec, grant, target)).rejects.toThrow('READ_DENIED');
    const next = f.grant(fresh.exec); expect((await f.runtime.observe(fresh.exec, next, target)).elements).toHaveLength(1);
    // A late disposal notification for the old object cannot revoke its replacement.
    f.runtime.agentDisposedFromHost(f.agent); f.runtime.sessionDisposedFromHost(f.session);
    expect((await f.runtime.observe(fresh.exec, next, target)).elements).toHaveLength(1);
  });

  it('retires a same-ID replaced Agent without a disposal event before applying scope capacity', async () => {
    const f = fixture(1); const grant = f.grant(); let finish!: (value: unknown) => void; let signal!: AbortSignal;
    f.observe((current) => { signal = current; return new Promise((resolve) => { finish = resolve; }); });
    const pending = f.runtime.observe(f.exec, grant, target);
    const replacement = f.caller();
    const next = f.grant(replacement.exec);
    expect(signal.aborted).toBe(true); expect(next).not.toBe(grant);
    finish(observed()); await expect(pending).rejects.toThrow();
    f.observe(async () => observed());
    expect((await f.runtime.observe(replacement.exec, next, target)).elements).toHaveLength(1);
    expect(() => f.grant()).toThrow('HOST_CONTEXT_UNAVAILABLE');
  });

  it('preserves an unrelated live Session while revoking every sibling grant for the selected scope', async () => {
    const f = fixture(); const second = f.caller('session_other'); const first = f.grant(); const sibling = f.grant(); const other = f.grant(second.exec);
    f.runtime.sessionDisposedFromHost(f.session);
    await expect(f.runtime.observe(f.exec, first, target)).rejects.toThrow(); await expect(f.runtime.observe(f.exec, sibling, target)).rejects.toThrow();
    expect((await f.runtime.observe(second.exec, other, target)).elements).toHaveLength(1); expect(f.counts().observe).toBe(1);
  });

  it('never revives a grant or old handle after cwd A to B to A, even when the first change event is missing', async () => {
    const f = fixture(); const grant = f.grant(); const request = await member(f, grant);
    f.directory(f.session, '/tmp/cu-other');
    await expect(f.runtime.observe(f.exec, grant, target)).rejects.toThrow('READ_DENIED');
    f.directory(f.session, '/tmp/cu-read-runtime');
    await expect(f.runtime.observe(f.exec, grant, target)).rejects.toThrow('READ_DENIED');
    const fresh = f.grant(); await expect(f.runtime.revalidate(f.exec, fresh, request)).rejects.toThrow('OBSERVATION_EXPIRED');
    expect(f.counts()).toEqual({ observe: 1, revalidate: 0 });
  });

  it.each(['directory', 'dispose', 'policy'] as const)('closes admission before synchronous abort listeners reenter during %s', async (event) => {
    const f = fixture(); const first = f.grant(); const sibling = f.grant(); let finish!: (value: unknown) => void;
    let minted = false; let reentrant!: Promise<unknown>;
    f.observe((signal) => {
      signal.addEventListener('abort', () => {
        try { f.grant(); minted = true; } catch { /* gate already closed */ }
        reentrant = f.runtime.observe(f.exec, sibling, target).then(() => true, () => false);
      }, { once: true });
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = f.runtime.observe(f.exec, first, target);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session);
    if (event === 'dispose') f.runtime.dispose();
    if (event === 'policy') f.runtime.policyChangedFromHost();
    expect(minted).toBe(false); expect(await reentrant).toBe(false); finish(observed()); await expect(pending).rejects.toThrow();
    expect(f.counts().observe).toBe(1);
  });

  it('refuses capacity overflow rather than evicting a still-authorized tracked scope', async () => {
    const f = fixture(1); const grant = f.grant(); const second = f.caller('session_other');
    expect(() => f.grant(second.exec)).toThrow('READ_CAPACITY');
    expect((await f.runtime.observe(f.exec, grant, target)).elements).toHaveLength(1);
    f.runtime.sessionDisposedFromHost(f.session); const other = f.grant(second.exec);
    expect((await f.runtime.observe(second.exec, other, target)).elements).toHaveLength(1);
  });

  it.each(['registry', 'closed_turn', 'abort'] as const)('rebinds live host state at publication after %s changes', async (fault) => {
    const f = fixture(); const grant = f.grant();
    f.observe(async () => {
      if (fault === 'registry') f.agents.delete(f.agent.id);
      if (fault === 'closed_turn') f.closeTurn();
      if (fault === 'abort') f.abort.abort();
      return observed();
    });
    await expect(f.runtime.observe(f.exec, grant, target)).rejects.toThrow(); expect(f.counts().observe).toBe(1);
  });

  it('refuses publication if a synchronous host getter dispatches a lifecycle transition while binding', async () => {
    const f = fixture(); const grant = f.grant();
    const working = f.host.workingDirectory.get.bind(f.host.workingDirectory);
    let dispatched = false;
    f.host.workingDirectory.get = (session) => {
      if (!dispatched) { dispatched = true; f.runtime.workspaceChangedFromHost(session); }
      return working(session);
    };
    await expect(f.runtime.observe(f.exec, grant, target)).rejects.toThrow('HOST_CONTEXT_UNAVAILABLE');
    expect(f.counts().observe).toBe(0);
  });

  it.each(['policy', 'directory'] as const)('does not mint an untracked grant if a host target getter triggers %s after binding', (event) => {
    const f = fixture(); let changed = false;
    const input = { ...target, get pid() {
      if (!changed) {
        changed = true;
        if (event === 'policy') f.runtime.policyChangedFromHost(); else f.runtime.workspaceChangedFromHost(f.session);
      }
      return target.pid;
    } };
    expect(() => f.runtime.grantFromHost(f.exec, input, { ttlMs: 30_000 })).toThrow('HOST_CONTEXT_UNAVAILABLE');
    expect(f.counts()).toEqual({ observe: 0, revalidate: 0 });
    expect(f.grant()).toMatch(/^read_grant_/);
  });

  it('refuses a grant when a host cwd getter silently replaces the registry after its initial identity check', () => {
    const f = fixture(); const original = f.host.workingDirectory.get.bind(f.host.workingDirectory);
    let replaced = false;
    f.host.workingDirectory.get = (session) => {
      if (!replaced) { replaced = true; f.caller(); }
      return original(session);
    };
    expect(() => f.grant()).toThrow('HOST_CONTEXT_UNAVAILABLE');
  });

  it.each(['policy', 'directory', 'dispose'] as const)('does not publish a grant if its TTL getter triggers %s during authority admission', (event) => {
    const f = fixture(); let changed = false;
    const options = { get ttlMs() {
      if (!changed) { changed = true;
        if (event === 'policy') f.runtime.policyChangedFromHost();
        if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session);
        if (event === 'dispose') f.runtime.dispose();
      }
      return 30_000;
    } };
    expect(() => f.runtime.grantFromHost(f.exec, target, options)).toThrow();
    expect(f.counts()).toEqual({ observe: 0, revalidate: 0 });
  });

  it('does not mint a read grant when its final cwd getter closes the turn after the first boundary check', () => {
    const f = fixture(); const original = f.host.workingDirectory.get.bind(f.host.workingDirectory); let gets = 0;
    f.host.workingDirectory.get = (session) => { gets += 1; if (gets === 2) f.closeTurn(); return original(session); };
    expect(() => f.grant()).toThrow('HOST_CONTEXT_UNAVAILABLE');
  });

  it('does not start a read if the cwd getter replaces the registry after the initial liveness check', async () => {
    const f = fixture(); const grant = f.grant(); const original = f.host.workingDirectory.get.bind(f.host.workingDirectory);
    let replaced = false;
    f.host.workingDirectory.get = (session) => {
      if (!replaced) { replaced = true; f.caller(); }
      return original(session);
    };
    await expect(f.runtime.observe(f.exec, grant, target)).rejects.toThrow('HOST_CONTEXT_UNAVAILABLE');
    expect(f.counts().observe).toBe(0);
  });

  it('does not echo errors from host registry or current-directory getters', async () => {
    const f = fixture();
    f.host.workingDirectory.get = () => { throw new Error('private-fixture-value'); };
    let failure: unknown;
    try { f.grant(); } catch (error) { failure = error; }
    expect(String(failure)).toContain('HOST_CONTEXT_UNAVAILABLE'); expect(String(failure)).not.toContain('private-fixture-value');
    expect(f.counts()).toEqual({ observe: 0, revalidate: 0 });
  });

  it('does not revoke a grant merely because one caller aborted, and captures the original in-flight call signal', async () => {
    const f = fixture(); const grant = f.grant(); const mutable = { ...f.exec };
    f.observe(async () => { f.abort.abort(); mutable.signal = new AbortController().signal; return observed(); });
    await expect(f.runtime.observe(mutable, grant, target)).rejects.toThrow();
    f.observe(async () => observed());
    expect((await f.runtime.observe(mutable, grant, target)).elements).toHaveLength(1);
  });

  it('does not transfer grants or handles to a fresh runtime generation and makes dispose idempotent', async () => {
    const f = fixture(); const grant = f.grant(); const request = await member(f, grant); f.runtime.dispose(); f.runtime.dispose();
    const next = new module.FixtureReadRuntime(f.host, { observe: async () => observed(), revalidate: async () => exact() }); cleanups.push(() => next.dispose());
    await expect(next.observe(f.exec, grant, target)).rejects.toThrow('READ_DENIED');
    const fresh = next.grantFromHost(f.exec, target, { ttlMs: 30_000 });
    await expect(next.revalidate(f.exec, fresh, request)).rejects.toThrow('OBSERVATION_EXPIRED');
  });
});
