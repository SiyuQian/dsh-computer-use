import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as client from '../../src/backend/macos/revalidate.js';

const contexts: Context[] = [];
afterEach(async () => { await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose())); });
async function runtime() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(LocalSubprocessRuntime).inertia; return ctx.subprocess;
}
const target = { pid: process.pid, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
const element = { identifier: 'fixture.text', instance: 'element_fixture', operation: 'set_value' };

describe('CU-007b1: read-only fixture identity revalidation admission', () => {
  it.each([process.pid, 2_147_483_647])('refuses non-fixture PID %s before any AX access or revalidation claim', async (pid) => {
    const result = await client.revalidateFixtureElement(await runtime(), resolve('.'), { ...target, pid }, element, { signal: new AbortController().signal });
    expect(result.status === 'error' && result.code).toBe('TARGET_CHANGED');
    expect(JSON.stringify(result)).not.toContain('snapshot');
    expect(result.dispatchable).toBe(false);
  });

  it.each([
    { ...element, identifier: 'fixture.secure' }, { ...element, identifier: 'arbitrary.selector' },
    { ...element, instance: '../private-fixture-value' }, { ...element, operation: 'script' },
    { ...element, approved: true }, { ...element, nativeId: 'node_0' },
  ])('rejects widened element descriptor %# before spawning', async (descriptor) => {
    let spawns = 0;
    await expect(client.revalidateFixtureElement({ spawn() { spawns += 1; throw new Error('must not spawn'); } }, resolve('.'), target, descriptor, { signal: new AbortController().signal })).rejects.toThrow('INVALID_REQUEST');
    expect(spawns).toBe(0);
  });

  it.each(['revalidate_wrong_target', 'revalidate_wrong_instance', 'revalidate_wrong_operation', 'revalidate_dispatchable', 'revalidate_extra'])('does not accept an exact claim with %s output from an untrusted child', async (fault) => {
    const provider = await runtime();
    const owned: ReturnType<typeof provider.spawn>[] = [];
    const adapter = { spawn(spec: SubprocessSpawnSpec) {
      const handle = provider.spawn({ ...spec, argv: [process.execPath, resolve('tests/support/fault-helper.mjs'), fault] }); owned.push(handle); return handle;
    } };
    await expect(client.revalidateFixtureElement(adapter, resolve('.'), target, element, { signal: new AbortController().signal })).rejects.toThrow('NATIVE_PROTOCOL_ERROR');
    expect(owned).toHaveLength(1);
    expect(await owned[0]!.waitForExit(AbortSignal.timeout(2000))).toBe(true);
  });

  it.each(['revalidate_extra', 'revalidate_bool_window', 'revalidate_secure', 'revalidate_selector', 'revalidate_missing_instance', 'revalidate_bad_operation', 'revalidate_duplicate_command', 'revalidate_duplicate_instance'])('rejects malformed %s at the actual Swift boundary', async (fault) => {
    const { runMalformedNativeRequest } = await import('../support/native-probe.js');
    const result = await runMalformedNativeRequest(await runtime(), resolve('.'), fault);
    expect(result.exitCode).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr.includes('private-fixture-value')).toBe(false);
  });
});
