import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';
import { ObservationStore } from '../../src/observation/store.js';
import { FixtureReadAuthority } from '../../src/policy/read-authority.js';
import { FixtureRevalidationService } from '../../src/service/fixture-revalidation.js';
import { revalidateFixtureElement } from '../../src/backend/macos/revalidate.js';

it('combines a host-private candidate and read grant with actual helper identity refusal, never AX success', async () => {
  const ctx = new Context();
  await ctx.plugin(LocalSubprocessRuntime).inertia;
  const authority = new FixtureReadAuthority();
  const store = new ObservationStore();
  const host: HostContext = { owner: { agentId: 'agent_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    lifetime: Object.freeze({}), workspace: resolve('.'), callId: 'call_fixture', turn: 1, signal: AbortSignal.timeout(5000) };
  const target = { pid: process.pid, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
  // Explicit test metadata seed, not an AX observation. The real helper must reject this Node process before touching AX.
  const observation = store.commit(host, store.begin(host), {
    ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 },
    nodes: [{ nativeId: 'node_0', identifier: 'fixture.text', elementInstance: 'element_test_seed', role: 'AXTextField', subrole: '',
      label: 'Fixture text', secure: false, enabled: true, actions: ['set_value'], depth: 1 }], truncated: false, reasons: [],
  }, target);
  const request = { observationId: observation.observationId, handle: observation.elements[0]!.handle, operation: 'set_value' };
  let calls = 0;
  const service = new FixtureRevalidationService({ authority, observations: store, revalidate: async (receivedTarget, element, signal) => {
    calls += 1;
    expect(element.instance).toBe('element_test_seed');
    return revalidateFixtureElement(ctx.subprocess, resolve('.'), receivedTarget, element, { signal });
  } });
  try {
    await expect(service.revalidate(() => host, 'model_grant', request)).rejects.toThrow('READ_DENIED');
    expect(calls).toBe(0);
    const grant = authority.grantFromHost(host, target, { ttlMs: 30_000 });
    await expect(service.revalidate(() => host, grant, request)).rejects.toThrow('TARGET_CHANGED');
    expect(calls).toBe(1);
    expect(store.get(host, observation.observationId)).not.toHaveProperty('fixtureCandidates');
    expect(JSON.stringify(store.get(host, observation.observationId))).not.toContain('element_test_seed');
  } finally {
    authority.dispose(); store.dispose(); await ctx.fiber.dispose();
  }
});
