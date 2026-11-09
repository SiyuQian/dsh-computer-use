import { afterEach, describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';
import { FixtureReadAuthority } from '../../src/policy/read-authority.js';
import { ObservationStore } from '../../src/observation/store.js';
import { FixtureReadService } from '../../src/service/fixture-read.js';
import type { FixtureTarget, FixtureElement } from '../../src/contracts/fixture-observation.js';

import { FixtureRevalidationService } from '../../src/service/fixture-revalidation.js';
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
const descriptor = { identifier: 'fixture.text' as const, instance: 'element_text_lifetime', operation: 'set_value' as const };
const snapshot = { ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 },
  nodes: [{ nativeId: 'node_0', identifier: 'fixture.text', elementInstance: 'element_text_lifetime', role: 'AXTextField', subrole: '', label: 'Fixture text', enabled: true, secure: false, actions: ['set_value'], depth: 1 }], truncated: false, reasons: [] };
const authorities: FixtureReadAuthority[] = [];
afterEach(() => { for (const authority of authorities.splice(0)) authority.dispose(); });
function exact() { return { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'exact', dispatchable: false, target: structuredClone(target), element: structuredClone(descriptor) }; }
function fixture() {
  let now = 100;
  const abort = new AbortController();
  let current: HostContext = { owner: { agentId: 'agent_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    workspace: '/tmp/cu-revalidation-service', lifetime: Object.freeze({}), callId: 'call_fixture', turn: 1, signal: abort.signal };
  const authority = new FixtureReadAuthority({ monotonicMs: () => now }); authorities.push(authority);
  const observations = new ObservationStore({ clock: { monotonicMs: () => now, wallTimeMs: () => Date.parse('2026-11-08T08:00:00Z') } });
  const grant = authority.grantFromHost(current, target, { ttlMs: 30_000 });
  const observation = observations.commit(current, observations.begin(current), snapshot, target);
  const request = { observationId: observation.observationId, handle: observation.elements[0]!.handle, operation: 'set_value' as const };
  let calls = 0;
  let probe: (target: FixtureTarget, element: FixtureElement, signal: AbortSignal) => Promise<unknown> = async () => exact();
  const service = new FixtureRevalidationService({ authority, observations, revalidate: async (received, element, signal) => {
    calls += 1; expect(received).toEqual(target); expect(element).toEqual(descriptor); return probe(received, element, signal);
  } });
  return { authority, observations, observation, request, service, grant, abort, calls: () => calls, context: () => current,
    change(change: Partial<HostContext>) { current = { ...current, ...change }; }, advance(ms: number) { now += ms; },
    backend(fn: typeof probe) { probe = fn; } };
}

describe('CU-007b2a: default-deny, non-dispatchable read-only handle revalidation', () => {
  it('denies missing read authorization before invoking the backend', async () => {
    const f = fixture(); await expect(f.service.revalidate(f.context, 'model_grant', f.request)).rejects.toThrow('READ_DENIED'); expect(f.calls()).toBe(0);
  });

  it('publishes only the public identity and a read-only fact, without native descriptors or execution authority', async () => {
    const f = fixture(); const result = await f.service.revalidate(f.context, f.grant, f.request);
    expect(result).toEqual({ status: 'exact', dispatchable: false, requiresNativeRevalidation: true, ...f.request });
    expect(f.calls()).toBe(1); expect(JSON.stringify(result)).not.toContain('element_text_lifetime'); expect(result).not.toHaveProperty('target');
  });

  it('uses the existing authorized observation service to establish the private handle binding', async () => {
    const f = fixture();
    const reader = new FixtureReadService({ authority: f.authority, observations: f.observations, observe: async () => ({ protocolVersion: 1, requestId: 'read_fixture', launchId: 'read_launch', status: 'ok', snapshot }) });
    const observation = await reader.observe(f.context, f.grant, target);
    const result = await f.service.revalidate(f.context, f.grant, { ...f.request, observationId: observation.observationId, handle: observation.elements[0]!.handle });
    expect(result.status).toBe('exact'); expect(result.dispatchable).toBe(false); expect(f.calls()).toBe(1);
  });

  it.each(['target', 'element', 'owner', 'approved', 'value', 'nativeId'])('rejects caller-provided %s before invoking a backend', async (field) => {
    const f = fixture();
    await expect(f.service.revalidate(f.context, f.grant, { ...f.request, [field]: 'private-fixture-value' })).rejects.toThrow('INVALID_REQUEST'); expect(f.calls()).toBe(0);
  });

  it.each(['missing_handle', 'other_observation', 'wrong_operation', 'expired', 'invalidated'])('refuses %s membership before probing', async (fault) => {
    const f = fixture(); const request = { ...f.request };
    if (fault === 'missing_handle') request.handle = 'model_handle';
    if (fault === 'other_observation') request.observationId = 'model_observation';
    if (fault === 'wrong_operation') Object.assign(request, { operation: 'press' });
    if (fault === 'expired') f.advance(15_000);
    if (fault === 'invalidated') f.observations.invalidate(f.context());
    await expect(f.service.revalidate(f.context, f.grant, request)).rejects.toThrow(fault === 'missing_handle' ? 'TARGET_CHANGED' : fault === 'wrong_operation' ? 'CAPABILITY_UNAVAILABLE' : 'OBSERVATION_EXPIRED'); expect(f.calls()).toBe(0);
  });

  it.each(['revoke', 'policy', 'grant_expiry', 'observation_expiry', 'invalidate', 'dispose', 'abort', 'abort_replace', 'lifetime', 'workspace', 'generation'])(
    'does not publish an exact backend claim after %s during a read', async (fault) => {
      const f = fixture();
      f.backend(async (_target, _element, signal) => {
        if (fault === 'revoke') f.authority.revokeFromHost(f.grant);
        if (fault === 'policy') f.authority.policyChangedFromHost();
        if (fault === 'grant_expiry') f.advance(30_000);
        if (fault === 'observation_expiry') f.advance(15_000);
        if (fault === 'invalidate') f.observations.invalidate(f.context());
        if (fault === 'dispose') f.observations.dispose();
        if (fault === 'abort' || fault === 'abort_replace') f.abort.abort();
        if (fault === 'abort_replace') f.change({ signal: new AbortController().signal });
        if (fault === 'lifetime') f.change({ lifetime: Object.freeze({}) });
        if (fault === 'workspace') f.change({ workspace: '/tmp/other' });
        if (fault === 'generation') f.change({ owner: { ...f.context().owner, generation: 'generation_other' } });
        if (['revoke', 'policy', 'abort', 'abort_replace'].includes(fault)) expect(signal.aborted).toBe(true);
        return exact();
      });
      const code = ['observation_expiry', 'invalidate', 'dispose'].includes(fault) ? 'OBSERVATION_EXPIRED' : ['abort', 'abort_replace'].includes(fault) ? 'CANCELLED' : 'READ_DENIED';
      await expect(f.service.revalidate(f.context, f.grant, f.request)).rejects.toThrow(code); expect(f.calls()).toBe(1);
    });

  it.each(['revoke', 'expire', 'invalidate', 'abort', 'throw_after_revoke'])('rechecks %s triggered while parsing an untrusted backend response', async (fault) => {
    const f = fixture();
    f.backend(async () => ({ ...exact(), get dispatchable() {
      if (fault === 'revoke' || fault === 'throw_after_revoke') f.authority.revokeFromHost(f.grant);
      if (fault === 'expire') f.advance(15_000);
      if (fault === 'invalidate') f.observations.invalidate(f.context());
      if (fault === 'abort') f.abort.abort();
      if (fault === 'throw_after_revoke') throw new Error('private-fixture-value');
      return false;
    } }));
    const code = fault === 'expire' || fault === 'invalidate' ? 'OBSERVATION_EXPIRED' : fault === 'abort' ? 'CANCELLED' : 'READ_DENIED';
    await expect(f.service.revalidate(f.context, f.grant, f.request)).rejects.toThrow(code); expect(f.calls()).toBe(1);
  });

  it('does not publish after final private lookup re-enters a revoked read grant', async () => {
    const f = fixture(); const context = f.context(); let armed = false; let workspaceReads = 0;
    const latest: HostContext = { ...context, get workspace() {
      if (armed && ++workspaceReads === 5) f.authority.revokeFromHost(f.grant);
      return context.workspace;
    } };
    f.backend(async () => ({ ...exact(), get element() { armed = true; return structuredClone(descriptor); } }));
    await expect(f.service.revalidate(() => latest, f.grant, f.request)).rejects.toThrow('READ_DENIED');
    expect(workspaceReads).toBeGreaterThanOrEqual(5); expect(f.calls()).toBe(1);
  });

  it('does not publish if the final authorization check invalidates its observation', async () => {
    const f = fixture(); const context = f.context(); let armed = false; let workspaceReads = 0;
    const latest: HostContext = { ...context, get workspace() {
      if (armed && ++workspaceReads === 7) f.observations.invalidate(context);
      return context.workspace;
    } };
    f.backend(async () => ({ ...exact(), get element() { armed = true; return structuredClone(descriptor); } }));
    await expect(f.service.revalidate(() => latest, f.grant, f.request)).rejects.toThrow('OBSERVATION_EXPIRED');
    expect(workspaceReads).toBeGreaterThanOrEqual(7); expect(f.calls()).toBe(1);
  });

  it('does not renew an observation or cache an exact result across calls', async () => {
    const f = fixture();
    await expect(f.service.revalidate(f.context, f.grant, f.request)).resolves.toMatchObject({ status: 'exact', dispatchable: false });
    await expect(f.service.revalidate(f.context, f.grant, f.request)).resolves.toMatchObject({ status: 'exact', dispatchable: false });
    f.advance(15_000);
    await expect(f.service.revalidate(f.context, f.grant, f.request)).rejects.toThrow('OBSERVATION_EXPIRED'); expect(f.calls()).toBe(2);
  });

  it('does not disclose untrusted backend error input', async () => {
    const f = fixture(); f.backend(async () => { throw new Error('private-fixture-value'); });
    const error: unknown = await f.service.revalidate(f.context, f.grant, f.request).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error); expect(String(error)).toContain('NATIVE_READ_UNAVAILABLE'); expect(String(error)).not.toContain('private-fixture-value');
  });

  it('compares against a fresh private candidate rather than backend-mutated input arguments', async () => {
    const f = fixture();
    f.backend(async (receivedTarget, element) => { receivedTarget.windowInstance = 'window_other'; element.instance = 'element_other'; return { ...exact(), target: receivedTarget, element }; });
    await expect(f.service.revalidate(f.context, f.grant, f.request)).rejects.toThrow('NATIVE_READ_UNAVAILABLE');
    expect(f.observations.resolveFixtureFromHost(f.context(), f.request.observationId, f.request.handle, 'set_value').element.instance).toBe('element_text_lifetime');
  });

  it.each(['target', 'instance', 'operation', 'dispatchable', 'extra', 'invalid', 'status'])('refuses malformed or misbound %s output without retrying', async (fault) => {
    const f = fixture(); f.backend(async () => {
      const response = exact();
      if (fault === 'target') response.target.windowId = 8;
      if (fault === 'instance') response.element.instance = 'element_other';
      if (fault === 'operation') Object.assign(response.element, { operation: 'press' });
      if (fault === 'dispatchable') Object.assign(response, { dispatchable: true });
      if (fault === 'extra') Object.assign(response, { private: 'private-fixture-value' });
      if (fault === 'status') response.status = 'completed';
      return fault === 'invalid' ? { private: 'private-fixture-value' } : response;
    });
    await expect(f.service.revalidate(f.context, f.grant, f.request)).rejects.toThrow('NATIVE_READ_UNAVAILABLE'); expect(f.calls()).toBe(1);
  });

  it.each(['READ_DENIED', 'TARGET_CHANGED', 'TARGET_AMBIGUOUS', 'CAPABILITY_UNAVAILABLE'])('preserves closed refusal %s, never a raw native object', async (code) => {
    const f = fixture(); f.backend(async () => ({ protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'error', dispatchable: false, code }));
    await expect(f.service.revalidate(f.context, f.grant, f.request)).rejects.toThrow(code); expect(f.calls()).toBe(1);
  });

  it('sanitizes backend exceptions and gives revocation priority without retrying', async () => {
    const f = fixture(); f.backend(async () => { throw new Error('private-fixture-value'); });
    await expect(f.service.revalidate(f.context, f.grant, f.request)).rejects.toThrow('NATIVE_READ_UNAVAILABLE');
    f.backend(async () => { f.authority.revokeFromHost(f.grant); throw new Error('private-fixture-value'); });
    await expect(f.service.revalidate(f.context, f.grant, f.request)).rejects.toThrow('READ_DENIED'); expect(f.calls()).toBe(2);
  });
});
