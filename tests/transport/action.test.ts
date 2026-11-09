import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import * as client from '../../src/backend/macos/act.js';

const contexts: Context[] = [];
afterEach(async () => { await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose())); });
async function runtime() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(LocalSubprocessRuntime).inertia; return ctx.subprocess;
}
const root = resolve('.');
const target = { pid: process.pid, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
const text = { identifier: 'fixture.text', instance: 'element_fixture', operation: 'set_value' };
const submit = { identifier: 'fixture.submit', instance: 'element_fixture', operation: 'press' };

describe('CU-012a: fixture-only semantic action transport', () => {
  it.each([process.pid, 2_147_483_647])('refuses non-fixture PID %s before any AX access and reports no dispatch', async (pid) => {
    const result = await client.actFixtureElement(await runtime(), root, { ...target, pid }, text, 'PUBLIC_TEST', { signal: new AbortController().signal });
    expect(result).toMatchObject({ status: 'error', code: 'TARGET_CHANGED' });
    expect(JSON.stringify(result)).not.toContain('PUBLIC_TEST');
  });

  it.each([
    [text, undefined], [submit, 'PUBLIC_TEST'], [{ ...text, identifier: 'fixture.secure' }, 'x'],
    [{ ...submit, identifier: 'arbitrary.selector' }, undefined], [{ ...submit, operation: 'script' }, undefined],
    [{ ...submit, approved: true }, undefined], [text, 'x'.repeat(1025)],
  ])('rejects widened request %# before spawning', async (element, value) => {
    let spawns = 0;
    await expect(client.actFixtureElement({ spawn() { spawns += 1; throw new Error('must not spawn'); } }, root, target, element, value,
      { signal: new AbortController().signal })).rejects.toThrow('INVALID_REQUEST');
    expect(spawns).toBe(0);
  });

  it('never retries and reports unknown when the helper exits after a possible dispatch', async () => {
    const provider = await runtime(); let spawns = 0;
    const adapter = { spawn(spec: SubprocessSpawnSpec) { spawns += 1; return provider.spawn({ ...spec, argv: [process.execPath, resolve('tests/support/fault-helper.mjs'), 'crash'] }); } };
    await expect(client.actFixtureElement(adapter, root, target, submit, undefined, { signal: new AbortController().signal })).rejects.toThrow('EXECUTION_UNKNOWN');
    expect(spawns).toBe(1);
  });

  it.each(['act_extra', 'act_press_value', 'act_set_missing_value', 'act_duplicate_value', 'act_secure'])('rejects malformed %s at the actual Swift boundary', async (fault) => {
    const { runMalformedNativeRequest } = await import('../support/native-probe.js');
    const result = await runMalformedNativeRequest(await runtime(), root, fault);
    expect(result.exitCode).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr.includes('private-fixture-value')).toBe(false);
  });
});
