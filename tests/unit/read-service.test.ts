import { beforeAll, describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';
import { FixtureReadAuthority } from '../../src/policy/read-authority.js';
import { ObservationStore } from '../../src/observation/store.js';

type Module = typeof import('../../src/service/fixture-read.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/service/fixture-read.js';
  module = await import(path);
});
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
const snapshot = {
  ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 20, width: 520, height: 440 },
  nodes: [{ nativeId: 'node_0', role: 'AXTextField', subrole: '', identifier: 'fixture.text', label: 'Fixture text', enabled: true, secure: false, value: 'public fixture text', actions: ['set_value'], depth: 1 }],
  truncated: false, reasons: [],
};
function response() { return { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'ok', snapshot }; }
function fixture() {
  let now = 100;
  let current: HostContext = {
    owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    lifetime: Object.freeze({}), workspace: '/tmp/cu-service-fixture', signal: new AbortController().signal, turn: 1, callId: 'call_fixture',
  };
  const authority = new FixtureReadAuthority({ monotonicMs: () => now });
  const store = new ObservationStore({ clock: { monotonicMs: () => now, wallTimeMs: () => Date.parse('2026-11-08T08:00:00Z') } });
  const grant = authority.grantFromHost(current, target, { ttlMs: 30_000 });
  let calls = 0;
  let nativeRead: (signal: AbortSignal) => Promise<unknown> = async () => response();
  const service = new module.FixtureReadService({
    authority, observations: store,
    observe: async (receivedTarget, signal) => {
      calls += 1;
      expect(receivedTarget).toEqual(target);
      return nativeRead(signal);
    },
  });
  return {
    authority, store, grant, service,
    context: () => current,
    calls: () => calls,
    changeContext: (change: Partial<HostContext>) => { current = { ...current, ...change }; },
    advance: (ms: number) => { now += ms; },
    read: (fn: typeof nativeRead) => { nativeRead = fn; },
  };
}

describe('CU-008a: default-deny read orchestration without model tools', () => {
  it('checks read permission before backend work and publishes an isolated host observation', async () => {
    const f = fixture();
    await expect(f.service.observe(f.context, 'forged_grant', target)).rejects.toThrow('READ_DENIED');
    expect(f.calls()).toBe(0);
    const observation = await f.service.observe(f.context, f.grant, target);
    expect(f.calls()).toBe(1);
    expect(observation.elements[0]).toMatchObject({ name: 'Fixture text', secure: false, value: 'public fixture text' });
    expect(observation).not.toHaveProperty('snapshot');
    expect(JSON.stringify(observation)).not.toContain('nativeId');
    f.authority.dispose();
  });

  it('rejects a changed requested window before invoking the backend', async () => {
    const f = fixture();
    await expect(f.service.observe(f.context, f.grant, { ...target, windowId: 8 })).rejects.toThrow('READ_DENIED');
    expect(f.calls()).toBe(0);
    f.authority.dispose();
  });

  it('rechecks revocation before publishing, even if the backend ignores the abort signal', async () => {
    const f = fixture();
    f.read(async (signal) => {
      f.authority.revokeFromHost(f.grant);
      expect(signal.aborted).toBe(true);
      return response();
    });
    await expect(f.service.observe(f.context, f.grant, target)).rejects.toThrow('READ_DENIED');
    expect(f.calls()).toBe(1);
    f.authority.dispose();
  });

  it('rebinds the current host after backend work so a changed Session lifetime cannot publish', async () => {
    const f = fixture();
    f.read(async () => { f.changeContext({ lifetime: Object.freeze({}) }); return response(); });
    await expect(f.service.observe(f.context, f.grant, target)).rejects.toThrow('READ_DENIED');
    expect(f.calls()).toBe(1);
    f.authority.dispose();
  });

  it('does not publish when the original host call aborts during a read', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.changeContext({ signal: abort.signal });
    f.read(async () => { abort.abort(); return response(); });
    await expect(f.service.observe(f.context, f.grant, target)).rejects.toThrow('CANCELLED');
    f.authority.dispose();
  });

  it('does not extend observation TTL across backend latency or retry a slow read', async () => {
    const f = fixture();
    f.read(async () => { f.advance(15_000); return response(); });
    await expect(f.service.observe(f.context, f.grant, target)).rejects.toThrow('OBSERVATION_EXPIRED');
    expect(f.calls()).toBe(1);
    f.authority.dispose();
  });

  it('rechecks a short read grant after projection and before storing or publishing its observation', async () => {
    let now = 100;
    let storeClockReads = 0;
    const authority = new FixtureReadAuthority({ monotonicMs: () => now });
    const observations = new ObservationStore({ maxEntries: 1, clock: {
      monotonicMs: () => { if (++storeClockReads === 3) now = 5100; return now; },
      wallTimeMs: () => Date.parse('2026-11-08T08:00:00Z'),
    } });
    const context: HostContext = {
      owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
      lifetime: Object.freeze({}), workspace: '/tmp/cu-service-fixture', signal: new AbortController().signal, turn: 1, callId: 'call_fixture',
    };
    const grant = authority.grantFromHost(context, target, { ttlMs: 5000 });
    const service = new module.FixtureReadService({ authority, observations, observe: async () => response() });
    try { await expect(service.observe(() => context, grant, target)).rejects.toThrow('READ_DENIED'); }
    finally { authority.dispose(); }
    // A failed publication must not occupy the sole entry as a hidden stored observation.
    const one = observations.begin(context);
    observations.discard(context, one);
  });

  it('redacts backend exceptions and discards the pending ticket so repeated failures do not consume capacity', async () => {
    const f = fixture();
    f.read(async () => { throw new Error('private-fixture-value'); });
    for (let count = 0; count < 65; count += 1) {
      await expect(f.service.observe(f.context, f.grant, target)).rejects.toThrow('NATIVE_READ_UNAVAILABLE');
    }
    expect(f.calls()).toBe(65);
    f.authority.dispose();
  });

  it('preserves fixed native refusal codes but never publishes its raw object', async () => {
    const f = fixture();
    f.read(async () => ({ protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'error', code: 'READ_DENIED' }));
    await expect(f.service.observe(f.context, f.grant, target)).rejects.toThrow('READ_DENIED');
    expect(f.calls()).toBe(1);
    f.authority.dispose();
  });
});
