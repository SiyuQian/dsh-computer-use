import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type Module = typeof import('../../src/backend/macos/observe.js');
let client: Module;
const contexts: Context[] = [];
beforeAll(async () => {
  const path = '../../src/backend/macos/observe.js';
  client = await import(path);
});
afterEach(async () => { await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose())); });
async function runtime() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(LocalSubprocessRuntime).inertia;
  return ctx.subprocess;
}
const root = resolve('.');

describe('CU-006: native fixture-only observation admission', () => {
  it('rejects this Node process before any AX access, regardless of TCC permissions', async () => {
    const result = await client.observeFixtureSnapshot(await runtime(), root, {
      pid: process.pid, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture',
    }, { signal: new AbortController().signal });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.code).toBe('TARGET_CHANGED');
    expect(JSON.stringify(result)).not.toContain('snapshot');
  });

  it('rejects a nonexistent process without enumerating other applications', async () => {
    const result = await client.observeFixtureSnapshot(await runtime(), root, {
      pid: 2_147_483_647, processStart: 'process_fixture', windowKey: 'secondary', windowId: 8, windowInstance: 'window_fixture',
    }, { signal: new AbortController().signal });
    expect(result.status === 'error' && result.code).toBe('TARGET_CHANGED');
  });

  it.each(['observe_extra', 'observe_bool_pid', 'observe_missing_window', 'observe_bool_window', 'observe_negative_window', 'observe_invalid_instance'])('rejects malformed %s at the Swift boundary', async (fault) => {
    const { runMalformedNativeRequest } = await import('../support/native-probe.js');
    const result = await runMalformedNativeRequest(await runtime(), root, fault);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-fixture-value');
  });

  it.each([
    { pid: process.pid, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture', bundleId: 'private.app' },
    { pid: process.pid, processStart: 'process_fixture', windowKey: 'all', windowId: 7, windowInstance: 'window_fixture' },
    { pid: process.pid, processStart: '../private-fixture-value', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' },
    { pid: 0, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' },
  ])('rejects a widened or malformed target %# before spawning', async (target) => {
    let spawns = 0;
    const provider = { spawn() { spawns += 1; throw new Error('must not spawn'); } };
    await expect(client.observeFixtureSnapshot(provider, root, target, { signal: new AbortController().signal })).rejects.toThrow('INVALID_REQUEST');
    expect(spawns).toBe(0);
  });
});
