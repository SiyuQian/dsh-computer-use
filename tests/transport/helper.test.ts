import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';

type Client = typeof import('../../src/backend/macos/health.js');
let client: Client;
const contexts: Context[] = [];
beforeAll(async () => {
  const path = '../../src/backend/macos/health.js';
  client = await import(path);
});
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
});
async function runtime() {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(LocalSubprocessRuntime).inertia;
  return ctx.subprocess;
}
const root = resolve('.');

function faultProvider(runtime: SubprocessRuntime, fault: string) {
  const owned: ReturnType<SubprocessRuntime['spawn']>[] = [];
  return {
    owned,
    spawn(spec: SubprocessSpawnSpec) {
      const handle = runtime.spawn({ ...spec, argv: [process.execPath, resolve('tests/support/fault-helper.mjs'), fault] });
      owned.push(handle);
      return handle;
    },
  };
}

describe('A-03: managed native health transport', () => {
  it('executes the compiled Swift helper through the real public subprocess provider', async () => {
    const provider = await runtime();
    const result = await client.probeNativeHealth(provider, root, { signal: new AbortController().signal });
    expect(result).toMatchObject({
      protocolVersion: 1,
      status: 'ok',
      commands: ['health', 'observe_fixture', 'revalidate_fixture', 'act_fixture'],
      capabilities: { axObservation: false, mutation: 'fixture_semantic_only', keyboard: false, pointer: false },
      permissions: { accessibility: expect.any(Boolean), screenCapture: expect.any(Boolean) },
    });
    expect(result.helperPid).toBeGreaterThan(0);
  });

  it('rejects direct invocation without a managed inherited channel', () => {
    const result = spawnSync(resolve('dist/native/CUHelper'), ['--managed-stdio'], {
      input: '{"protocolVersion":1,"requestId":"request_fixture","command":"health"}\n', encoding: 'utf8', timeout: 2000,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MANAGED_CHANNEL_REQUIRED');
  });

  it.each(['unknown_command', 'wrong_version', 'boolean_version', 'wrong_launch', 'invalid_id', 'extra_field', 'oversized', 'invalid_json', 'extra_frame', 'truncated'])('rejects a %s request at the Swift boundary without echoing its content', async (fault) => {
    const provider = await runtime();
    const { runMalformedNativeRequest } = await import('../support/native-probe.js');
    const result = await runMalformedNativeRequest(provider, root, fault);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-fixture-value');
  });

  it.each(['wrong_id', 'wrong_launch', 'extra_frame', 'oversized', 'truncated', 'invalid_json', 'crash'])('rejects %s helper output and waits for the managed range to exit', async (fault) => {
    const provider = faultProvider(await runtime(), fault);
    await expect(client.probeNativeHealth(provider, root, { signal: new AbortController().signal })).rejects.toThrow(/NATIVE_PROTOCOL_ERROR|NATIVE_TRANSPORT_ERROR/);
    expect(provider.owned).toHaveLength(1);
    expect(await provider.owned[0]!.waitForExit(AbortSignal.timeout(2000))).toBe(true);
  });

  it('cancels a running helper and waits for quiescence without retrying', async () => {
    const subprocess = await runtime(); const abort = new AbortController(); const owned: SubprocessHandle[] = [];
    let ready = false;
    const provider = { spawn(spec: SubprocessSpawnSpec) {
      const handle = subprocess.spawn({ ...spec, argv: [process.execPath, resolve('tests/support/fault-helper.mjs'), 'hang_ready'] });
      owned.push(handle);
      let output = '';
      handle.stdout!.on('data', (data: Buffer) => { output += data.toString(); if (output === 'TEST_HELPER_READY\n') { ready = true; abort.abort(); } });
      return handle;
    } };
    await expect(client.probeNativeHealth(provider, root, { signal: abort.signal, timeoutMs: 5000 })).rejects.toThrow('CANCELLED');
    expect(ready).toBe(true); expect(owned).toHaveLength(1);
    expect(await owned[0]!.waitForExit(AbortSignal.timeout(2000))).toBe(true);
  });

  it('times out a stalled helper, terminates it, and never retries', async () => {
    const provider = faultProvider(await runtime(), 'hang');
    await expect(client.probeNativeHealth(provider, root, { signal: new AbortController().signal, timeoutMs: 100 })).rejects.toThrow('NATIVE_TIMEOUT');
    expect(provider.owned).toHaveLength(1);
    expect(await provider.owned[0]!.waitForExit(AbortSignal.timeout(2000))).toBe(true);
  });

  it('reports cleanup failure within a bound even if the provider never settles its done promise', async () => {
    const stdout = new PassThrough();
    const control = new PassThrough();
    const handle: SubprocessHandle = {
      stdin: undefined, stdout, stderr: undefined, control, collected: {},
      done: new Promise(() => {}), terminate() {}, waitForExit: async () => false,
    };
    const provider = { spawn: () => handle };
    const outcome = await Promise.race([
      client.probeNativeHealth(provider, root, { signal: new AbortController().signal, timeoutMs: 1000 }).catch((error: unknown) => String(error)),
      // Bound = request timeout + 2s cleanup cap; real artifact checks must finish before the request timeout under load.
      new Promise<string>((resolve) => setTimeout(() => resolve('probe did not honor timeout'), 4000)),
    ]);
    stdout.destroy();
    control.destroy();
    expect(outcome).toContain('NATIVE_CLEANUP_FAILED');
  });

  it('does not forward an upstream exception that happens to use the native error prefix', async () => {
    const provider = { spawn() { throw new Error('NATIVE_private-fixture-value'); } };
    let captured: unknown;
    try { await client.probeNativeHealth(provider, root, { signal: new AbortController().signal }); }
    catch (error) { captured = error; }
    expect(String(captured)).toContain('NATIVE_TRANSPORT_ERROR');
    expect(String(captured)).not.toContain('private-fixture-value');
  });

  it('rejects a pre-aborted call before spawning a helper', async () => {
    const provider = faultProvider(await runtime(), 'hang');
    const signal = AbortSignal.abort();
    await expect(client.probeNativeHealth(provider, root, { signal })).rejects.toThrow('CANCELLED');
    expect(provider.owned).toHaveLength(0);
  });
});
