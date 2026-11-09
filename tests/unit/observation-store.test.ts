import { beforeAll, describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';

type Module = typeof import('../../src/observation/store.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/observation/store.js';
  module = await import(path);
});

function context(overrides: Partial<HostContext> = {}): HostContext {
  return {
    owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    lifetime: Object.freeze({}), callId: 'call_fixture', turn: 1, workspace: '/tmp/cu-store-fixture', signal: new AbortController().signal,
    ...overrides,
  };
}
function snapshot() {
  return {
    pid: 41, processStart: 'process_fixture', bundleId: 'dev.siyuqian.computer-use.fixture',
    windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture',
    frame: { x: -200, y: 20, width: 520, height: 440 },
    nodes: [{ nativeId: 'node_0', role: 'AXTextField', subrole: '', identifier: 'fixture.text', label: 'Fixture text', enabled: true, secure: false, value: 'public fixture text', actions: ['set_value'], depth: 1 }],
    truncated: false, reasons: [],
  };
}
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
function fixture(config: { ttlMs?: number; maxEntries?: number } = {}) {
  let monotonic = 100;
  let wall = Date.parse('2026-11-08T08:00:00Z');
  const store = new module.ObservationStore({
    clock: { monotonicMs: () => monotonic, wallTimeMs: () => wall }, ...config,
  });
  const host = context();
  return {
    store, host,
    advance: (ms: number) => { monotonic += ms; },
    setMonotonic: (ms: number) => { monotonic = ms; },
    setWall: (ms: number) => { wall = ms; },
    begin: () => store.begin(host),
    capture: () => { const ticket = store.begin(host); return store.commit(host, ticket, snapshot(), target); },
  };
}

describe('CU-007a: inert observation lifetime and exact membership', () => {
  it('returns an isolated private intent source with its original monotonic deadline and stored revision', () => {
    const f = fixture(); const raw = snapshot(); Object.assign(raw.nodes[0]!, { elementInstance: 'element_private_lifetime' });
    try {
      const ticket = f.store.begin(f.host); const observation = f.store.commit(f.host, ticket, raw, target);
      expect(f.store.actionIntentSourceFromHost).toBeTypeOf('function');
      const source = f.store.actionIntentSourceFromHost(f.host, observation.observationId, observation.elements[0]!.handle, 'set_value');
      expect(source).toMatchObject({ monotonicDeadline: 15_100, structureRevision: observation.structureRevision, candidate: { target } });
      source.candidate.target.pid = 99; expect(f.store.actionIntentSourceFromHost(f.host, observation.observationId, observation.elements[0]!.handle, 'set_value').candidate.target.pid).toBe(41);
      f.advance(15_000); expect(() => f.store.actionIntentSourceFromHost(f.host, observation.observationId, observation.elements[0]!.handle, 'set_value')).toThrow('OBSERVATION_EXPIRED');
    } finally { f.store.dispose(); }
  });

  it('issues host IDs and resolves only members of the stored observation', () => {
    const f = fixture();
    const observation = f.capture();
    expect(observation.observationId).toMatch(/^observation_/);
    expect(observation.observedAt).toBe('2026-11-08T08:00:00.000Z');
    expect(observation.expiresAt).toBe('2026-11-08T08:00:15.000Z');
    expect(f.store.get(f.host, observation.observationId)).toEqual(observation);
    expect(f.store.resolve(f.host, observation.observationId, observation.elements[0]!.handle)).toMatchObject({
      status: 'candidate', requiresNativeRevalidation: true,
      observationId: observation.observationId,
      app: { bundleId: 'dev.siyuqian.computer-use.fixture', pid: 41, processStart: 'process_fixture' },
      window: { id: 7, instance: 'window_fixture' },
      element: { role: 'text-field', name: 'Fixture text', actions: ['set_value'] },
    });
    expect(() => f.store.resolve(f.host, observation.observationId, 'forged_handle')).toThrow('TARGET_CHANGED');
  });

  it('rejects an unissued observation or a handle borrowed from another observation', () => {
    const f = fixture();
    const first = f.capture();
    const second = f.capture();
    expect(() => f.store.get(f.host, 'model_issued_observation')).toThrow('OBSERVATION_EXPIRED');
    expect(() => f.store.resolve(f.host, second.observationId, first.elements[0]!.handle)).toThrow('TARGET_CHANGED');
  });

  it('expires on the monotonic threshold regardless of backward or forward wall-clock changes', () => {
    const f = fixture();
    const observation = f.capture();
    f.advance(14_999);
    f.setWall(Date.parse('2001-01-01T00:00:00Z'));
    expect(f.store.get(f.host, observation.observationId).observationId).toBe(observation.observationId);
    f.advance(1);
    f.setWall(Date.parse('2099-01-01T00:00:00Z'));
    expect(() => f.store.get(f.host, observation.observationId)).toThrow('OBSERVATION_EXPIRED');
  });

  it('starts the observation age before backend work, never at the end of a slow read', () => {
    const f = fixture();
    const ticket = f.begin();
    f.advance(15_000);
    expect(() => f.store.commit(f.host, ticket, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
  });

  it('does not publish a record that expires while the snapshot is being validated or projected', () => {
    let readings = 0;
    const store = new module.ObservationStore({
      clock: { monotonicMs: () => [100, 15_099, 15_100][readings++]!, wallTimeMs: () => Date.parse('2026-11-08T08:00:00Z') },
    });
    const host = context();
    const ticket = store.begin(host);
    expect(() => store.commit(host, ticket, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
  });

  it('sanitizes a failing injected clock and clears pending and published data', () => {
    let failing = false;
    const store = new module.ObservationStore({ clock: {
      monotonicMs: () => { if (failing) throw new Error('private-fixture-value'); return 100; },
      wallTimeMs: () => Date.parse('2026-11-08T08:00:00Z'),
    } });
    const host = context();
    const observation = store.commit(host, store.begin(host), snapshot(), target);
    failing = true;
    expect(() => store.get(host, observation.observationId)).toThrow('CLOCK_UNAVAILABLE');
    failing = false;
    expect(() => store.get(host, observation.observationId)).toThrow('OBSERVATION_EXPIRED');
  });

  it('uses opaque single-use tickets, including on malformed or target-mismatched completion', () => {
    const f = fixture();
    const ticket = f.begin();
    expect(() => f.store.commit(f.host, { ...ticket }, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
    expect(() => f.store.commit(f.host, ticket, { ...snapshot(), windowInstance: 'window_replaced' }, target)).toThrow('TARGET_CHANGED');
    expect(() => f.store.commit(f.host, ticket, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
    const good = f.begin();
    f.store.commit(f.host, good, snapshot(), target);
    expect(() => f.store.commit(f.host, good, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
  });

  it.each(['agent', 'session', 'generation', 'workspace', 'lifetime'] as const)('rejects a different %s scope without exposing the record', (field) => {
    const f = fixture();
    const observation = f.capture();
    const changed = { ...f.host, owner: { ...f.host.owner } };
    if (field === 'agent') changed.owner.agentId = 'another_agent';
    if (field === 'session') changed.owner.sessionId = 'another_session';
    if (field === 'generation') changed.owner.generation = 'another_generation';
    if (field === 'workspace') changed.workspace = '/tmp/another-workspace';
    if (field === 'lifetime') changed.lifetime = Object.freeze({});
    expect(() => f.store.get(changed, observation.observationId)).toThrow('OBSERVATION_EXPIRED');
    expect(f.store.get(f.host, observation.observationId).observationId).toBe(observation.observationId);
  });

  it('allows a later turn/call on the same live scope but rejects a pre-aborted caller', () => {
    const f = fixture();
    const observation = f.capture();
    expect(f.store.get({ ...f.host, callId: 'next_call', turn: 2 }, observation.observationId)).toEqual(observation);
    expect(() => f.store.get({ ...f.host, signal: AbortSignal.abort() }, observation.observationId)).toThrow('CANCELLED');
    expect(() => f.store.begin({ ...f.host, signal: AbortSignal.abort() })).toThrow('CANCELLED');
  });

  it('removes observations and pending tickets on scope invalidation or disposal', () => {
    const f = fixture();
    const other = context();
    const observation = f.capture();
    const pending = f.begin();
    const otherRecord = f.store.commit(other, f.store.begin(other), snapshot(), target);
    f.store.invalidate(f.host);
    expect(() => f.store.get(f.host, observation.observationId)).toThrow('OBSERVATION_EXPIRED');
    expect(() => f.store.commit(f.host, pending, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
    expect(f.store.get(other, otherRecord.observationId).observationId).toBe(otherRecord.observationId);
    f.store.dispose();
    expect(() => f.store.get(other, otherRecord.observationId)).toThrow('OBSERVATION_EXPIRED');
    expect(() => f.store.begin(other)).toThrow('OBSERVATION_EXPIRED');
  });

  it('bounds live records and pending reads without silently evicting a still-live observation', () => {
    const f = fixture({ maxEntries: 2 });
    const first = f.capture();
    const pending = f.begin();
    expect(() => f.begin()).toThrow('OBSERVATION_CAPACITY');
    expect(f.store.get(f.host, first.observationId).observationId).toBe(first.observationId);
    f.advance(15_000);
    expect(() => f.store.commit(f.host, pending, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
    expect(f.capture().observationId).not.toBe(first.observationId);
  });

  it('keeps stored data private and returns isolated copies, not caller-mutable references', () => {
    const f = fixture();
    const raw = snapshot();
    const observation = f.store.commit(f.host, f.begin(), raw, target);
    raw.nodes[0]!.label = 'changed source';
    observation.elements[0]!.name = 'changed response';
    observation.elements[0]!.actions.length = 0;
    observation.app.pid = 42;
    const stable = f.store.get(f.host, observation.observationId);
    expect(stable.app.pid).toBe(41);
    expect(stable.elements[0]!.name).toBe('Fixture text');
    expect(stable.elements[0]!.actions).toEqual(['set_value']);
    const candidate = f.store.resolve(f.host, observation.observationId, stable.elements[0]!.handle);
    candidate.element.name = 'changed candidate';
    expect(f.store.get(f.host, observation.observationId).elements[0]!.name).toBe('Fixture text');
  });

  it('fails closed and clears records when the supposedly monotonic clock regresses or is invalid', () => {
    const f = fixture();
    const observation = f.capture();
    f.setMonotonic(99);
    expect(() => f.store.get(f.host, observation.observationId)).toThrow('CLOCK_UNAVAILABLE');
    f.setMonotonic(100);
    expect(() => f.store.get(f.host, observation.observationId)).toThrow('OBSERVATION_EXPIRED');
    f.setMonotonic(Number.NaN);
    expect(() => f.begin()).toThrow('CLOCK_UNAVAILABLE');
  });

  it('does not resolve secure or disabled fields as actionable candidates', () => {
    const f = fixture();
    const secure = snapshot();
    secure.nodes[0]!.secure = true;
    const observation = f.store.commit(f.host, f.begin(), secure, target);
    expect(() => f.store.resolve(f.host, observation.observationId, observation.elements[0]!.handle)).toThrow('CAPABILITY_UNAVAILABLE');
    const disabled = snapshot();
    disabled.nodes[0]!.enabled = false;
    const next = f.store.commit(f.host, f.begin(), disabled, target);
    expect(() => f.store.resolve(f.host, next.observationId, next.elements[0]!.handle)).toThrow('CAPABILITY_UNAVAILABLE');
  });

  it.each([0, 4999, 60_001, 10.5, Number.NaN])('rejects invalid TTL %s at construction', (ttlMs) => {
    expect(() => fixture({ ttlMs })).toThrow('INVALID_REQUEST');
  });
});
