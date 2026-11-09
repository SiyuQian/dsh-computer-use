import { performance } from 'node:perf_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureReadRuntime } from '../../src/service/fixture-read-runtime.js';

const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
function fixture(snapshotChange?: (snapshot: { truncated: boolean; nodes: { enabled: boolean; secure: boolean; elementInstance: string; identifier: string }[] }) => void) {
  const agents = new Map<string, Agent>(); const sessions = new Map<string, Session>(); const directories = new Map<Session, string>();
  let turn = 1; let calls = 0;
  const host = { agents: { get: (id: string) => agents.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: turn }) },
    sessions: { get: (id: string) => sessions.get(id) }, workingDirectory: { get: (session: Session) => directories.get(session)! } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  const runtime = new FixtureReadRuntime(host, { observe: async (received) => { calls += 1; const snapshot = {
    ...received, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 }, truncated: false, reasons: [], nodes: [
      { nativeId: 'native_submit', elementInstance: 'element_instance_submit', role: 'AXButton', subrole: '', identifier: 'fixture.submit', label: 'Public Submit', enabled: true, secure: false, actions: ['press'], depth: 1 },
      { nativeId: 'native_text', elementInstance: 'element_instance_text', role: 'AXTextField', subrole: 'AXStandardTextField', identifier: 'fixture.text', label: 'Public Text', value: '', enabled: true, secure: false, actions: ['set_value'], depth: 1 },
    ],
  };
    snapshotChange?.(snapshot); return { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'ok', snapshot };
  }, revalidate: async () => { calls += 1; throw new Error('UNUSED_REVALIDATION'); } });
  cleanups.push(() => runtime.dispose());
  function caller(id = 'session_fixture') {
    const session = Session.create(SessionId(id)); const agent = { id: session.id, session } as Agent;
    agents.set(id, agent); sessions.set(id, session); directories.set(session, '/tmp/cu-runtime-intents'); const abort = new AbortController();
    return { agent, session, abort, exec: { agent, callId: ToolCallId('call_fixture'), signal: abort.signal } };
  }
  const first = caller();
  async function observed(exec = first.exec, operation = 'press') {
    const grant = runtime.grantFromHost(exec, target, { ttlMs: 30_000 }); const observation = await runtime.observe(exec, grant, target);
    const element = observation.elements.find((entry) => entry.actions.includes(operation as 'press'))!;
    const request = { observationId: observation.observationId, action: operation === 'press' ? { kind: 'press', targetHandle: element.handle } : { kind: 'set_value', targetHandle: element.handle, value: 'PUBLIC_TEST_VALUE' } };
    return { grant, observation, request };
  }
  function stage(grant: string, request: unknown, exec = first.exec) {
    expect(runtime.stageActionIntentFromHost).toBeTypeOf('function'); return runtime.stageActionIntentFromHost(exec, grant, request);
  }
  return { runtime, ...first, host, caller, observed, stage, calls: () => calls, turn(value: number) { turn = value; }, directory(value: string) { directories.set(first.session, value); } };
}

describe('CU-007a2: observation-derived single-use action intents remain read-only candidates', () => {
  it.each(['stage', 'consume'] as const)('rechecks the original turn after the %s operation final intent-clock read', async (phase) => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture(); const o = await f.observed();
    const ticket = phase === 'consume' ? f.stage(o.grant, o.request) : undefined; let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => { reads += 1; if (reads === (phase === 'stage' ? 8 : 4)) f.turn(2); return now; });
    expect(() => phase === 'stage' ? f.stage(o.grant, o.request) : f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket!, o.request)).toThrow();
  });

  it('starts the ten-second intent age before reading a caller proposal getter', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture(); const o = await f.observed();
    expect(() => f.stage(o.grant, { ...o.request, get action() { now += 10_000; return o.request.action; } })).toThrow('INTENT_INVALIDATED');
  });

  it('does not let a foreign scope evaluate proposal getters or burn an owner ticket', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request); const other = f.caller('session_other'); const second = await f.observed(other.exec); let reads = 0;
    expect(() => f.runtime.consumeActionIntentFromHost(other.exec, second.grant, ticket, { get observationId() { reads += 1; return o.request.observationId; } })).toThrow();
    expect(reads).toBe(0); expect(f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request).status).toBe('candidate');
  });

  it('derives exact target/material context from live observation membership without backend calls or control authority', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request);
    expect(Object.isFrozen(ticket)).toBe(true); expect(ticket).toEqual({ kind: 'observation_action_intent' });
    const result = f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request);
    expect(result).toMatchObject({ status: 'candidate', dispatchable: false, requiresNativeRevalidation: true, observationId: o.observation.observationId, target, action: o.request.action });
    expect(result.materialContext).toMatch(/^context_[0-9a-f]{64}$/); expect(JSON.stringify(result)).not.toContain('element_instance_submit');
    expect(result).not.toHaveProperty('leaseId'); expect(f.runtime).not.toHaveProperty('intents'); expect(f.calls()).toBe(1);
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow('INTENT_INVALIDATED');
  });

  it.each(['target', 'materialContext', 'owner', 'leaseId', 'approved'] as const)('rejects caller-injected %s rather than accepting authority or source metadata', async (field) => {
    const f = fixture(); const o = await f.observed(); expect(() => f.stage(o.grant, { ...o.request, [field]: 'caller_field' })).toThrow('INVALID_REQUEST');
  });

  it('rejects unknown observations, invented handles, incompatible operations and a read grant for another target', async () => {
    const f = fixture(); const o = await f.observed(); expect(f.runtime.stageActionIntentFromHost).toBeTypeOf('function');
    expect(() => f.stage(o.grant, { ...o.request, observationId: 'observation_invented' })).toThrow();
    expect(() => f.stage(o.grant, { ...o.request, action: { kind: 'press', targetHandle: 'element_invented' } })).toThrow();
    expect(() => f.stage(o.grant, { ...o.request, action: { kind: 'set_value', targetHandle: o.request.action.targetHandle, value: 'public' } })).toThrow();
    const wrong = f.runtime.grantFromHost(f.exec, { ...target, windowId: 8 }, { ttlMs: 30_000 }); expect(() => f.stage(wrong, o.request)).toThrow();
  });

  it('binds the original grant and exact input bytes, and permanently burns a mismatched owner attempt', async () => {
    const f = fixture(); const o = await f.observed(f.exec, 'set_value'); const ticket = f.stage(o.grant, o.request);
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, { ...o.request, action: { ...o.request.action, value: 'CHANGED_PUBLIC' } })).toThrow('INTENT_INVALIDATED');
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow('INTENT_INVALIDATED');
    const next = f.stage(o.grant, o.request); const otherGrant = f.runtime.grantFromHost(f.exec, target, { ttlMs: 30_000 });
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, otherGrant, next, o.request)).toThrow('INTENT_INVALIDATED');
  });

  it('does not let a cloned ticket or a foreign scope consume or destroy the original owner intent', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request); const other = f.caller('session_other'); const second = await f.observed(other.exec);
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, { ...ticket }, o.request)).toThrow();
    expect(() => f.runtime.consumeActionIntentFromHost(other.exec, second.grant, ticket, o.request)).toThrow();
    expect(f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request).status).toBe('candidate');
  });

  it.each(['agent', 'session', 'directory', 'policy', 'dispose'] as const)('clears intents and stale observation references on %s', async (event) => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request);
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent); if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session); if (event === 'policy') f.runtime.policyChangedFromHost(); if (event === 'dispose') f.runtime.dispose();
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow();
  });

  it('expires intents at ten seconds and never extends an older observation past its original fifteen-second deadline', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture(); const o = await f.observed();
    const first = f.stage(o.grant, o.request); now = 10_100; expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, first, o.request)).toThrow();
    now = 14_000; const last = f.stage(o.grant, o.request); now = 15_100;
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, last, o.request)).toThrow();
  });

  it('pins the original turn at staging and does not carry a valid observation ticket into another turn', async () => {
    const f = fixture(); const o = await f.observed();
    expect(() => f.stage(o.grant, { ...o.request, get action() { f.turn(2); return o.request.action; } })).toThrow();
    f.turn(1); const ticket = f.stage(o.grant, o.request); f.turn(2); expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow();
  });

  it('does not retain a caller raw payload or reevaluate its getters when the ticket is consumed', async () => {
    const f = fixture(); const o = await f.observed(f.exec, 'set_value'); let reads = 0;
    const raw = { ...o.request, get action() { reads += 1; return o.request.action; } }; const ticket = f.stage(o.grant, raw);
    expect(reads).toBe(1); expect(f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, structuredClone(o.request)).action).toEqual(o.request.action); expect(reads).toBe(1);
  });

  it('retains the original caller cancellation and removes its tickets before a later call can use them', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request); const replacement = { ...f.exec, signal: new AbortController().signal };
    f.abort.abort(); expect(() => f.runtime.consumeActionIntentFromHost(replacement, o.grant, ticket, o.request)).toThrow();
    expect(f.stage(o.grant, o.request, replacement)).toBeDefined();
  });

  it('rejects a duplicate consume during request parsing but lets the original valid owner call finish once', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request);
    const raw = { ...o.request, get action() { expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow(); return o.request.action; } };
    expect(f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, raw).status).toBe('candidate');
  });

  it('does not let cleanup from within a proposal getter resurrect a staged or consuming ticket', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request);
    const raw = { ...o.request, get action() { f.runtime.policyChangedFromHost(); return o.request.action; } };
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, raw)).toThrow();
    const fresh = await f.observed(); expect(() => f.stage(fresh.grant, { ...fresh.request, get action() { f.runtime.policyChangedFromHost(); return fresh.request.action; } })).toThrow();
  });

  it('does not expose raw payload or host getter errors', async () => {
    const f = fixture(); const o = await f.observed();
    expect(() => f.stage(o.grant, { get action() { throw new Error('PRIVATE_RAW_TEST'); } })).toThrow('INVALID_REQUEST');
    vi.spyOn(f.host.workingDirectory, 'get').mockImplementation(() => { throw new Error('PRIVATE_HOST_TEST'); });
    expect(() => f.stage(o.grant, o.request)).toThrow('HOST_CONTEXT_UNAVAILABLE');
  });

  it('refuses consumption if parsing crosses a short read-grant deadline while the observation and intent are still young', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture();
    const grant = f.runtime.grantFromHost(f.exec, target, { ttlMs: 5_000 }); const observation = await f.runtime.observe(f.exec, grant, target);
    const request = { observationId: observation.observationId, action: { kind: 'press', targetHandle: observation.elements[0]!.handle } };
    const ticket = f.stage(grant, request);
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, grant, ticket, { ...request, get action() { now = 5_100; return request.action; } })).toThrow();
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, grant, ticket, request)).toThrow();
  });

  it('rechecks inherited observation expiry after the final intent-clock call, not only before it', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture(); const o = await f.observed(); now = 14_000;
    const ticket = f.stage(o.grant, o.request); let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => { reads += 1; if (reads === 4) now = 15_100; return now; });
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow();
  });

  it('changes the keyed material when a new observation with rotated handles is used instead of accepting a copied public target', async () => {
    const f = fixture(); const first = await f.observed(); const a = f.stage(first.grant, first.request); const b = f.stage(first.grant, first.request);
    const one = f.runtime.consumeActionIntentFromHost(f.exec, first.grant, a, first.request); const two = f.runtime.consumeActionIntentFromHost(f.exec, first.grant, b, first.request);
    expect(one.materialContext).toBe(two.materialContext);
    const second = await f.observed(); const c = f.stage(second.grant, second.request);
    expect(f.runtime.consumeActionIntentFromHost(f.exec, second.grant, c, second.request).materialContext).not.toBe(one.materialContext);
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, first.grant, a, first.request)).toThrow();
  });

  it('rejects an owner parser exception once and permanently consumes that ticket without leaking the input', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request);
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, { get action() { throw new Error('PRIVATE_VALUE'); } })).toThrow('INVALID_REQUEST');
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow('INTENT_INVALIDATED');
  });

  it.each(['secure', 'disabled', 'truncated', 'missing-witness', 'duplicate-witness'] as const)('does not turn a %s public observation node into an action intent', async (variant) => {
    const f = fixture((snapshot) => {
      if (variant === 'secure') snapshot.nodes[0]!.secure = true; if (variant === 'disabled') snapshot.nodes[0]!.enabled = false;
      if (variant === 'truncated') snapshot.truncated = true; if (variant === 'missing-witness') Reflect.deleteProperty(snapshot.nodes[0]!, 'elementInstance');
      if (variant === 'duplicate-witness') snapshot.nodes[1]!.elementInstance = snapshot.nodes[0]!.elementInstance;
    });
    const grant = f.runtime.grantFromHost(f.exec, target, { ttlMs: 30_000 }); const observation = await f.runtime.observe(f.exec, grant, target);
    expect(() => f.stage(grant, { observationId: observation.observationId, action: { kind: 'press', targetHandle: observation.elements[0]!.handle } })).toThrow();
  });

  it('has one winner when the host schedules two consumes in concurrent microtasks', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request);
    const outcomes = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request))));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('does not read any caller-controlled property of a forged ticket object', async () => {
    const f = fixture(); const o = await f.observed(); let touched = false;
    const ticket = { get kind(): 'observation_action_intent' { touched = true; throw new Error('PRIVATE_TICKET_SOURCE'); } };
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow('INTENT_INVALIDATED'); expect(touched).toBe(false);
  });

  it('invalidates the registry on monotonic regression instead of reviving an older intent', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request);
    now = 99; expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow(); now = 100;
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow();
  });

  it.each(['stage', 'consume'] as const)('cannot return a %s result after the last clock call synchronously clears the private registry', async (phase) => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture(); const o = await f.observed();
    const ticket = phase === 'consume' ? f.stage(o.grant, o.request) : undefined; let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => { reads += 1; if (reads === (phase === 'stage' ? 8 : 4)) f.runtime.policyChangedFromHost(); return now; });
    expect(() => phase === 'stage' ? f.stage(o.grant, o.request) : f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket!, o.request)).toThrow();
  });

  it('rejects an old scope after a missed cwd event or same-ID registry replacement while permitting a fresh observation', async () => {
    const f = fixture(); const o = await f.observed(); const ticket = f.stage(o.grant, o.request); f.directory('/tmp/cu-other');
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, o.grant, ticket, o.request)).toThrow();
    const replacement = f.caller(); const next = await f.observed(replacement.exec); expect(f.stage(next.grant, next.request, replacement.exec)).toBeDefined();
    expect(() => f.stage(next.grant, next.request)).toThrow();
  });

  it('keeps inherited read-grant expiry effective even when it occurs at the last intent clock read', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now); const f = fixture();
    const grant = f.runtime.grantFromHost(f.exec, target, { ttlMs: 5_000 }); const observation = await f.runtime.observe(f.exec, grant, target);
    const request = { observationId: observation.observationId, action: { kind: 'press', targetHandle: observation.elements[0]!.handle } };
    const ticket = f.stage(grant, request); let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => { reads += 1; if (reads === 4) now = 5_100; return now; });
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, grant, ticket, request)).toThrow('INTENT_INVALIDATED');
  });

  it('bounds staged intents and releases capacity when an exact scope is invalidated', async () => {
    const f = fixture(); const o = await f.observed(); for (let i = 0; i < 64; i += 1) f.stage(o.grant, o.request);
    expect(() => f.stage(o.grant, o.request)).toThrow('INTENT_CAPACITY'); f.runtime.policyChangedFromHost();
    const fresh = await f.observed(); expect(f.stage(fresh.grant, fresh.request)).toBeDefined();
  });
});
