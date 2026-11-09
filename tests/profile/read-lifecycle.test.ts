import { Context } from '@deepseek-ai/cordis';
import { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent';
import { SessionStore, SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { FixtureReadRuntimeOptions } from '../../src/service/fixture-read-runtime.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type Module = typeof import('../../src/host-adapter/read-lifecycle.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/host-adapter/read-lifecycle.js';
  module = await import(path).catch(() => ({} as Module));
});
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
function observed() { return { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'ok', snapshot: {
  ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 },
  nodes: [{ nativeId: 'node_0', identifier: 'fixture.text', elementInstance: 'element_text_lifetime', role: 'AXTextField', subrole: '', label: 'Fixture text', enabled: true, secure: false, actions: ['set_value'], depth: 1 }], truncated: false, reasons: [],
} }; }
const roots: Context[] = [];
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose(); });
async function boot(options?: FixtureReadRuntimeOptions) {
  expect(module.installFixtureReadRuntime).toBeTypeOf('function');
  const ctx = new Context(); roots.push(ctx);
  const sessions = ctx.plugin(SessionStore); await sessions.inertia;
  const session = ctx.sessions.prepare(SessionId('session_fixture'));
  const detach = ctx.sessions.enter(session); ctx.sessions.announce(session);
  const agent = { id: session.id, session, ctx } as Agent;
  // Exact registry/turn/current-directory seam; SessionStore and event dispatch below are the public real SDK.
  const live = new Map<string, Agent>([[agent.id, agent]]);
  const directories = new Map<Session, string>([[session, '/tmp/cu-read-lifecycle']]);
  const host = { agents: { get: (id: string) => live.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: 1 }) },
    sessions: ctx.sessions, workingDirectory: { get: (current: Session) => directories.get(current)! } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  let calls = 0; let read: (signal: AbortSignal) => Promise<unknown> = async () => observed();
  let runtime!: ReturnType<Module['installFixtureReadRuntime']>;
  const backends = { observe: async (_target: unknown, signal: AbortSignal) => { calls += 1; return read(signal); }, revalidate: async () => { throw new Error('unused backend'); } };
  function plugin(scope: Context) { runtime = module.installFixtureReadRuntime(scope, host, backends, options); }
  const instance = ctx.plugin(plugin); await instance.inertia;
  const exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'> = { agent, callId: ToolCallId('call_fixture'), signal: new AbortController().signal };
  return { ctx, instance, plugin, runtime, exec, agent, session, detach, live, directories,
    calls: () => calls, read(fn: typeof read) { read = fn; },
    grant() { return runtime.grantFromHost(exec, target, { ttlMs: 30_000 }); },
    currentRuntime() { return runtime; },
  };
}

describe('CU-008a2: real Cordis/SessionStore lifecycle notifications, narrowed Agent seam', () => {
  it.each(['directory', 'session', 'agent', 'unload'] as const)('retires observation-derived intent tickets on a real %s event and rejects reuse after reload', async (event) => {
    const f = await boot(); const grant = f.grant(); const observation = await f.runtime.observe(f.exec, grant, target);
    const request = { observationId: observation.observationId, action: { kind: 'set_value', targetHandle: observation.elements[0]!.handle, value: 'PUBLIC_PROFILE_TEST' } };
    expect(f.runtime.stageActionIntentFromHost).toBeTypeOf('function'); const ticket = f.runtime.stageActionIntentFromHost(f.exec, grant, request);
    if (event === 'directory') f.session.append('working-directory/change', { cwd: '/tmp/cu-intent-event' });
    if (event === 'session') f.detach(); if (event === 'agent') emitAgentEvent(f.ctx, f.agent, 'agent/disposed', {});
    if (event === 'unload') await f.instance.dispose();
    expect(() => f.runtime.consumeActionIntentFromHost(f.exec, grant, ticket, request)).toThrow();
    if (event === 'unload') {
      const instance = f.ctx.plugin(f.plugin); await instance.inertia; const next = f.currentRuntime(); const fresh = next.grantFromHost(f.exec, target, { ttlMs: 30_000 });
      expect(() => next.consumeActionIntentFromHost(f.exec, fresh, ticket, request)).toThrow();
    }
    expect(f.calls()).toBe(1);
  });

  it.each(['directory', 'session', 'agent', 'unload'] as const)('clears opt-in private artifacts on a real %s event and never restores them on reload', async (event) => {
    const f = await boot({ artifacts: { enabledFromHost: true, authorize: () => true } });
    const grant = f.grant(); const observation = await f.runtime.observe(f.exec, grant, target);
    const descriptor = f.runtime.stageArtifactFromHost(f.exec, grant, { observationId: observation.observationId, maxBytes: 3 }, new Uint8Array([1, 2, 3]));
    expect(f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId).bytes).toEqual(new Uint8Array([1, 2, 3]));
    if (event === 'directory') f.session.append('working-directory/change', { cwd: '/tmp/cu-artifact-event' });
    if (event === 'session') f.detach();
    if (event === 'agent') emitAgentEvent(f.ctx, f.agent, 'agent/disposed', {});
    if (event === 'unload') await f.instance.dispose();
    expect(() => f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId)).toThrow();
    if (event === 'directory') {
      const fresh = f.grant();
      expect(() => f.runtime.readArtifactFromHost(f.exec, fresh, descriptor.artifactId)).toThrow();
      const next = await f.runtime.observe(f.exec, fresh, target);
      expect(f.runtime.stageArtifactFromHost(f.exec, fresh, { observationId: next.observationId, maxBytes: 3 }, new Uint8Array([1, 2, 3])).observationId).toBe(next.observationId);
    }
    if (event === 'unload') {
      const instance = f.ctx.plugin(f.plugin); await instance.inertia;
      const next = f.currentRuntime(); const fresh = next.grantFromHost(f.exec, target, { ttlMs: 30_000 });
      expect(() => next.readArtifactFromHost(f.exec, fresh, descriptor.artifactId)).toThrow();
    }
  });

  it('installs internally without automatically authorizing any read', async () => {
    const f = await boot(); await expect(f.runtime.observe(f.exec, 'model_grant', target)).rejects.toThrow('READ_DENIED'); expect(f.calls()).toBe(0);
  });

  it('uses the committed Session working-directory/change event and never trusts its data as a host path', async () => {
    const f = await boot(); const grant = f.grant(); let finish!: (value: unknown) => void; let signal!: AbortSignal;
    f.read((current) => { signal = current; return new Promise((resolve) => { finish = resolve; }); });
    const pending = f.runtime.observe(f.exec, grant, target);
    // Deliberately keep the seam getter at A: the event must revoke, not install its data or depend on the getter changing first.
    f.session.append('working-directory/change', { cwd: '/tmp/cu-event-only' });
    expect(signal.aborted).toBe(true);
    finish(observed()); await expect(pending).rejects.toThrow(); await expect(f.runtime.observe(f.exec, grant, target)).rejects.toThrow('READ_DENIED');
    expect(f.calls()).toBe(1); expect(f.directories.get(f.session)).toBe('/tmp/cu-read-lifecycle');
    f.read(async () => observed()); const fresh = f.grant(); expect((await f.runtime.observe(f.exec, fresh, target)).elements).toHaveLength(1);
  });

  it('ignores unrelated committed Session events instead of revoking a live grant', async () => {
    const f = await boot(); const grant = f.grant(); f.session.append('turn/start', { turn: 1 });
    expect((await f.runtime.observe(f.exec, grant, target)).elements).toHaveLength(1);
  });

  it('revokes on a real SessionStore detach notification and accepts a different same-ID object only with a new grant', async () => {
    const f = await boot(); const grant = f.grant(); let finish!: (value: unknown) => void; let signal!: AbortSignal;
    f.read((current) => { signal = current; return new Promise((resolve) => { finish = resolve; }); });
    const pending = f.runtime.observe(f.exec, grant, target); f.detach();
    expect(signal.aborted).toBe(true); finish(observed()); await expect(pending).rejects.toThrow();
    expect(() => f.grant()).toThrow('HOST_CONTEXT_UNAVAILABLE');
    const replacement = f.ctx.sessions.create(f.session.id); const agent = { id: replacement.id, session: replacement, ctx: f.ctx } as Agent;
    f.live.set(agent.id, agent); f.directories.set(replacement, '/tmp/cu-read-lifecycle');
    const exec = { ...f.exec, agent }; await expect(f.runtime.observe(exec, grant, target)).rejects.toThrow('READ_DENIED');
    f.read(async () => observed()); const next = f.runtime.grantFromHost(exec, target, { ttlMs: 30_000 });
    expect((await f.runtime.observe(exec, next, target)).elements).toHaveLength(1);
  });

  it('receives the public agent scoped dispatch payload without treating an ID match as disposal authority', async () => {
    const f = await boot(); const grant = f.grant();
    const foreign = { ...f.agent, session: f.session } as Agent;
    emitAgentEvent(f.ctx, foreign, 'agent/disposed', {});
    expect((await f.runtime.observe(f.exec, grant, target)).elements).toHaveLength(1);
    emitAgentEvent(f.ctx, f.agent, 'agent/disposed', {});
    expect(() => f.grant()).toThrow('HOST_CONTEXT_UNAVAILABLE'); await expect(f.runtime.observe(f.exec, grant, target)).rejects.toThrow();
  });

  it('closes admission and aborts before a composite unload removes its listeners, without claiming backend drain', async () => {
    const f = await boot(); const grant = f.grant(); let finish!: (value: unknown) => void; let signal!: AbortSignal;
    let reminted = false; let events = 0;
    const workspaceChanged = f.runtime.workspaceChangedFromHost.bind(f.runtime);
    f.runtime.workspaceChangedFromHost = (session) => { events += 1; workspaceChanged(session); };
    f.read((current) => { signal = current; signal.addEventListener('abort', () => {
      try { f.grant(); reminted = true; } catch { /* closed */ }
      f.session.append('working-directory/change', { cwd: '/tmp/cu-unload-event' });
    }); return new Promise((resolve) => { finish = resolve; }); });
    const pending = f.runtime.observe(f.exec, grant, target);
    await f.instance.dispose();
    expect(signal.aborted).toBe(true); expect(reminted).toBe(false);
    expect(events).toBe(1); // runtime cancellation ran while its nested subscription was still installed.
    f.session.append('working-directory/change', { cwd: '/tmp/cu-after-unload' });
    expect(events).toBe(1); // exact nested event disposers then removed that subscription.
    // The controlled backend has not settled. Only after explicit completion do we inspect its refused result.
    finish(observed()); await expect(pending).rejects.toThrow();
    const reload = f.ctx.plugin(f.plugin); await reload.inertia;
    const next = f.currentRuntime(); expect(next).not.toBe(f.runtime);
    await expect(next.observe(f.exec, grant, target)).rejects.toThrow('READ_DENIED');
    const fresh = next.grantFromHost(f.exec, target, { ttlMs: 30_000 }); f.read(async () => observed());
    expect((await next.observe(f.exec, fresh, target)).elements).toHaveLength(1);
  });
});
