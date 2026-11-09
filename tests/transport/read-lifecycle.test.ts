import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionStore, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { installFixtureReadRuntime } from '../../src/host-adapter/read-lifecycle.js';
import { observeFixtureSnapshot } from '../../src/backend/macos/observe.js';
import { probeNativeHealth } from '../../src/backend/macos/health.js';
import type { FixtureReadBackends } from '../../src/service/fixture-read-runtime.js';

async function boot(make: (ctx: Context) => FixtureReadBackends) {
  const ctx = new Context();
  try {
    await ctx.plugin(LocalSubprocessRuntime).inertia;
    await ctx.plugin(SessionStore).inertia;
    const session = ctx.sessions.prepare(SessionId('session_fixture'));
    const detach = ctx.sessions.enter(session); ctx.sessions.announce(session);
    const agent = { id: session.id, session, ctx } as Agent;
    // The registry/turn/cwd seam is deliberately narrow; Session events and subprocess lifecycle are real public SDK.
    const host = { agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: 1 }) },
      sessions: ctx.sessions, workingDirectory: { get: () => resolve('.') } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
    const runtime = installFixtureReadRuntime(ctx, host, make(ctx));
    const exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'> = { agent, callId: ToolCallId('call_fixture'), signal: AbortSignal.timeout(5000) };
    const target = { pid: process.pid, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
    return { ctx, session, detach, runtime, exec, target };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

it('routes an internal host grant to actual Swift identity refusal, then refuses a revoked grant before spawning', async () => {
  let calls = 0;
  const f = await boot((ctx) => ({
    observe: async (target, signal) => { calls += 1; return observeFixtureSnapshot(ctx.subprocess, resolve('.'), target, { signal }); },
    revalidate: async () => { throw new Error('unused backend'); },
  }));
  try {
    await expect(f.runtime.observe(f.exec, 'model_grant', f.target)).rejects.toThrow('READ_DENIED'); expect(calls).toBe(0);
    const grant = f.runtime.grantFromHost(f.exec, f.target, { ttlMs: 30_000 });
    // Node is not the fixed owned fixture executable. Swift must refuse before reading AX, regardless of TCC.
    await expect(f.runtime.observe(f.exec, grant, f.target)).rejects.toThrow('TARGET_CHANGED'); expect(calls).toBe(1);
    f.session.append('working-directory/change', { cwd: resolve('.') });
    await expect(f.runtime.observe(f.exec, grant, f.target)).rejects.toThrow('READ_DENIED'); expect(calls).toBe(1);
  } finally { f.runtime.dispose(); f.detach(); await f.ctx.fiber.dispose(); }
});

it('propagates a committed workspace event into managed transport cancellation and confirms real fault-child exit', async () => {
  let handle!: SubprocessHandle; let spawned!: () => void;
  const ready = new Promise<void>((resolve) => { spawned = resolve; });
  let backendSignal!: AbortSignal;
  const f = await boot((ctx) => ({
    observe: async (_target, signal) => {
      backendSignal = signal;
      // Test-only provider substitution: product runtime never accepts an executable/command from the model.
      const provider = { spawn(spec: Parameters<typeof ctx.subprocess.spawn>[0]) {
        handle = ctx.subprocess.spawn({ ...spec, argv: [process.execPath, resolve('tests/support/fault-helper.mjs'), 'hang'] });
        spawned(); return handle;
      } };
      await probeNativeHealth(provider, resolve('.'), { signal });
      throw new Error('A hung fault child must not return an observation.');
    },
    revalidate: async () => { throw new Error('unused backend'); },
  }));
  try {
    const grant = f.runtime.grantFromHost(f.exec, f.target, { ttlMs: 30_000 });
    const pending = f.runtime.observe(f.exec, grant, f.target);
    const refused = expect(pending).rejects.toThrow();
    await ready; expect(backendSignal.aborted).toBe(false);
    f.session.append('working-directory/change', { cwd: resolve('.') });
    expect(backendSignal.aborted).toBe(true);
    await refused;
    expect(await handle.waitForExit(AbortSignal.timeout(2000))).toBe(true);
    expect((await handle.done).exitCode === 0).toBe(false);
  } finally {
    f.runtime.dispose(); if (handle) { handle.terminate(); expect(await handle.waitForExit(AbortSignal.timeout(2000))).toBe(true); }
    f.detach(); await f.ctx.fiber.dispose();
  }
});
