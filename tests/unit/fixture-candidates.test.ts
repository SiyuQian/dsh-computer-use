import { describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';
import { ObservationStore } from '../../src/observation/store.js';

const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
function snapshot() {
  return {
    ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 },
    nodes: [
      { nativeId: 'node_0', identifier: 'fixture.submit', elementInstance: 'element_button_lifetime', role: 'AXButton', subrole: '', label: 'Submit', enabled: true, secure: false, actions: ['press'], depth: 1 },
      { nativeId: 'node_1', identifier: 'fixture.text', elementInstance: 'element_text_lifetime', role: 'AXTextField', subrole: '', label: 'Fixture text', enabled: true, secure: false, value: 'public fixture text', actions: ['set_value'], depth: 1 },
    ], truncated: false, reasons: [] as string[],
  };
}
function fixture(raw = snapshot()) {
  let now = 100;
  const host: HostContext = { owner: { agentId: 'agent_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    workspace: '/tmp/cu-candidates', lifetime: Object.freeze({}), callId: 'call_fixture', turn: 1, signal: new AbortController().signal };
  const store = new ObservationStore({ clock: { monotonicMs: () => now, wallTimeMs: () => Date.parse('2026-11-08T08:00:00Z') } });
  const observation = store.commit(host, store.begin(host), raw, target);
  return { store, host, observation, advance(ms: number) { now += ms; } };
}

describe('CU-007b2a: host-private fixture candidates, never executable handles', () => {
  it('retains a minimal private observation target even when no actionable element exists', () => {
    const raw = snapshot(); raw.nodes = [];
    const f = fixture(raw);
    expect(f.store.fixtureTargetFromHost).toBeTypeOf('function');
    const first = f.store.fixtureTargetFromHost(f.host, f.observation.observationId);
    expect(first).toEqual(target); first.windowKey = 'secondary';
    expect(f.store.fixtureTargetFromHost(f.host, f.observation.observationId)).toEqual(target);
    expect(f.store.get(f.host, f.observation.observationId)).not.toHaveProperty('windowKey');
    f.advance(15_000); expect(() => f.store.fixtureTargetFromHost(f.host, f.observation.observationId)).toThrow('OBSERVATION_EXPIRED');
  });

  it('parses the caller target once before projection so getter changes cannot split stored and observed identity', () => {
    const f = fixture(); let reads = 0;
    const changing = { ...target, get pid() { reads += 1; return reads === 1 ? target.pid : 99; } };
    const observation = f.store.commit(f.host, f.store.begin(f.host), snapshot(), changing);
    expect(reads).toBe(1); expect(observation.app.pid).toBe(41);
    expect(f.store.fixtureTargetFromHost(f.host, observation.observationId).pid).toBe(41);
  });

  it('does not disclose an observation target to another exact lifetime or after invalidation', () => {
    const f = fixture(); const id = f.observation.observationId;
    expect(f.store.fixtureTargetFromHost).toBeTypeOf('function');
    expect(() => f.store.fixtureTargetFromHost({ ...f.host, lifetime: Object.freeze({}) }, id)).toThrow('OBSERVATION_EXPIRED');
    f.store.invalidate(f.host); expect(() => f.store.fixtureTargetFromHost(f.host, id)).toThrow('OBSERVATION_EXPIRED');
  });

  it('binds the emitted public handle to its exact fixture lifetime witness, not the node index', () => {
    const f = fixture();
    expect(typeof f.store.resolveFixtureFromHost, 'ObservationStore must retain private fixture handle bindings.').toBe('function');
    const candidate = f.store.resolveFixtureFromHost(f.host, f.observation.observationId, f.observation.elements[1]!.handle, 'set_value');
    expect(candidate).toEqual({ status: 'candidate', dispatchable: false, requiresNativeRevalidation: true,
      observationId: f.observation.observationId, handle: f.observation.elements[1]!.handle, target,
      element: { identifier: 'fixture.text', instance: 'element_text_lifetime', operation: 'set_value' } });
    expect(f.store.resolveFixtureFromHost(f.host, f.observation.observationId, f.observation.elements[0]!.handle, 'press').element).toEqual({ identifier: 'fixture.submit', instance: 'element_button_lifetime', operation: 'press' });
  });

  it('does not publish native witnesses through the observation or the existing public candidate resolver', () => {
    const f = fixture();
    const publicCandidate = f.store.resolve(f.host, f.observation.observationId, f.observation.elements[1]!.handle);
    for (const data of [f.observation, f.store.get(f.host, f.observation.observationId), publicCandidate]) {
      expect(JSON.stringify(data)).not.toContain('element_text_lifetime'); expect(JSON.stringify(data)).not.toContain('fixture.text');
    }
  });

  it('isolates private bindings from caller changes to source, public observation, target, and resolved copies', () => {
    const raw = snapshot(); const f = fixture(raw); const id = f.observation.observationId; const handle = f.observation.elements[1]!.handle;
    raw.nodes[1]!.elementInstance = 'element_replaced'; f.observation.elements[1]!.handle = 'forged_handle';
    const first = f.store.resolveFixtureFromHost(f.host, id, handle, 'set_value');
    first.target.pid = 42; first.element.instance = 'element_mutated';
    expect(f.store.resolveFixtureFromHost(f.host, id, handle, 'set_value').element.instance).toBe('element_text_lifetime');
    expect(f.store.resolveFixtureFromHost(f.host, id, handle, 'set_value').target.pid).toBe(41);
  });

  it.each(['missing', 'bad_instance', 'disabled', 'secure', 'subrole', 'role', 'action', 'unknown_identifier', 'duplicate_identifier', 'duplicate_instance', 'truncated', 'reason', 'depth', 'nodes'])(
    'keeps %s snapshot metadata unusable for native probing', (fault) => {
      const raw = snapshot(); const node = raw.nodes[1]!;
      if (fault === 'missing') delete (node as Partial<typeof node>).elementInstance;
      if (fault === 'bad_instance') node.elementInstance = 'model_assigned';
      if (fault === 'disabled') node.enabled = false;
      if (fault === 'secure') node.secure = true;
      if (fault === 'subrole') node.subrole = 'AXUnknownSubrole';
      if (fault === 'role') node.role = 'AXButton';
      if (fault === 'action') node.actions = ['press'];
      if (fault === 'unknown_identifier') node.identifier = 'fixture.unknown';
      if (fault === 'duplicate_identifier') raw.nodes.push({ ...node, nativeId: 'node_duplicate', elementInstance: 'element_duplicate' });
      if (fault === 'duplicate_instance') raw.nodes[0]!.elementInstance = node.elementInstance;
      if (fault === 'truncated') raw.truncated = true;
      if (fault === 'reason') raw.reasons = ['unavailable'];
      if (fault === 'depth') raw.nodes[0]!.depth = 13;
      if (fault === 'nodes') for (let index = 2; index < 65; index += 1) raw.nodes.push({ ...node, nativeId: `node_${index}`, identifier: `other_${index}`, elementInstance: `element_${index}` });
      const f = fixture(raw);
      const emitted = f.observation.elements.find((element) => element.name === 'Fixture text')!;
      expect(() => f.store.resolveFixtureFromHost(f.host, f.observation.observationId, emitted.handle, 'set_value')).toThrow('CAPABILITY_UNAVAILABLE');
    });

  it('binds only the handle emitted with a node and never shifts after a skipped deep node', () => {
    const raw = snapshot(); raw.nodes[0]!.depth = 13;
    const f = fixture(raw);
    expect(f.observation.elements[0]?.name).toBe('Fixture text');
    // Incomplete coverage is not useful native identity, even though the public field is still visible.
    expect(() => f.store.resolveFixtureFromHost(f.host, f.observation.observationId, f.observation.elements[0]!.handle, 'set_value')).toThrow('CAPABILITY_UNAVAILABLE');
  });

  it('does not store private candidates when the observation expires in the final publication gate', () => {
    const f = fixture(); const ticket = f.store.begin(f.host);
    expect(() => f.store.commit(f.host, ticket, snapshot(), target, () => f.advance(15_000))).toThrow('OBSERVATION_EXPIRED');
  });

  it('does not resurrect a record or its private candidates if its scope is invalidated in the publication gate', () => {
    const f = fixture(); const ticket = f.store.begin(f.host);
    expect(() => f.store.commit(f.host, ticket, snapshot(), target, () => f.store.invalidate(f.host))).toThrow('OBSERVATION_EXPIRED');
  });

  it('refuses a scope invalidated while rebinding the final host context', () => {
    const f = fixture(); const ticket = f.store.begin(f.host); let armed = false;
    const host: HostContext = { ...f.host, get workspace() {
      if (armed) f.store.invalidate(f.host);
      return f.host.workspace;
    } };
    expect(() => f.store.commit(host, ticket, snapshot(), target, () => { armed = true; })).toThrow('OBSERVATION_EXPIRED');
  });

  it('consumes a ticket only once even if a publication callback attempts re-entrant commit', () => {
    const f = fixture(); const ticket = f.store.begin(f.host);
    const observation = f.store.commit(f.host, ticket, snapshot(), target, () => {
      expect(() => f.store.commit(f.host, ticket, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
    });
    expect(f.store.resolveFixtureFromHost(f.host, observation.observationId, observation.elements[1]!.handle, 'set_value').dispatchable).toBe(false);
    expect(() => f.store.commit(f.host, ticket, snapshot(), target)).toThrow('OBSERVATION_EXPIRED');
  });

  it('rejects a wrong operation or invented handle, including a valid handle from another observation', () => {
    const f = fixture(); const id = f.observation.observationId; const handle = f.observation.elements[1]!.handle;
    expect(() => f.store.resolveFixtureFromHost(f.host, id, handle, 'press')).toThrow('CAPABILITY_UNAVAILABLE');
    expect(() => f.store.resolveFixtureFromHost(f.host, id, handle, 'script')).toThrow('INVALID_REQUEST');
    expect(() => f.store.resolveFixtureFromHost(f.host, id, 'model_minted', 'set_value')).toThrow('TARGET_CHANGED');
    const next = f.store.commit(f.host, f.store.begin(f.host), snapshot(), target);
    expect(() => f.store.resolveFixtureFromHost(f.host, next.observationId, handle, 'set_value')).toThrow('TARGET_CHANGED');
  });

  it.each(['agent', 'session', 'generation', 'workspace', 'lifetime'])('does not resolve private data in another %s scope', (field) => {
    const f = fixture(); const changed = { ...f.host, owner: { ...f.host.owner } };
    if (field === 'agent') changed.owner.agentId = 'agent_other';
    if (field === 'session') changed.owner.sessionId = 'session_other';
    if (field === 'generation') changed.owner.generation = 'generation_other';
    if (field === 'workspace') changed.workspace = '/tmp/other';
    if (field === 'lifetime') changed.lifetime = Object.freeze({});
    expect(() => f.store.resolveFixtureFromHost(changed, f.observation.observationId, f.observation.elements[1]!.handle, 'set_value')).toThrow('OBSERVATION_EXPIRED');
  });

  it('expires private candidates with their public observation and never renews TTL on lookup', () => {
    const f = fixture(); const id = f.observation.observationId; const handle = f.observation.elements[1]!.handle;
    f.advance(14_999); expect(f.store.resolveFixtureFromHost(f.host, id, handle, 'set_value').dispatchable).toBe(false);
    f.advance(1); expect(() => f.store.resolveFixtureFromHost(f.host, id, handle, 'set_value')).toThrow('OBSERVATION_EXPIRED');
  });

  it.each(['invalidate', 'dispose', 'cancel'])('clears or refuses private candidates after %s', (mode) => {
    const f = fixture();
    if (mode === 'invalidate') f.store.invalidate(f.host);
    if (mode === 'dispose') f.store.dispose();
    const host = mode === 'cancel' ? { ...f.host, signal: AbortSignal.abort() } : f.host;
    expect(() => f.store.resolveFixtureFromHost(host, f.observation.observationId, f.observation.elements[1]!.handle, 'set_value')).toThrow(mode === 'cancel' ? 'CANCELLED' : 'OBSERVATION_EXPIRED');
  });
});
