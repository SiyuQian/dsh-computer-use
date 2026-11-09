import { Context } from '@deepseek-ai/cordis';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionStore, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { afterEach, describe, expect, it } from 'vitest';

const roots: Context[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((ctx) => ctx.fiber.dispose())); });
/** Nested Cordis scopes load after their dependencies change; one macrotask lets them settle. */
const settle = () => new Promise<void>((done) => setImmediate(done));

/**
 * The host services the fixture tools read. As in a real DSH profile, each comes from its own plugin, never from the
 * root context: the real SessionStore, narrow agents/workingDirectory seams, and a subprocess service that refuses
 * every spawn, so no fixture, helper or controller process ever starts.
 */
async function installHost(ctx: Context) {
  await ctx.plugin(SessionStore).inertia;
  const session = ctx.sessions.prepare(SessionId('session_tools')); ctx.sessions.enter(session); ctx.sessions.announce(session);
  const agent = { id: session.id, session, ctx } as unknown as Agent;
  let spawns = 0;
  const services = {
    name: 'cu-test-host-services',
    apply(scope: Context) {
      scope.provide('agents', { get: (id: string) => (id === agent.id ? agent : undefined), turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: 1 }) });
      scope.provide('workingDirectory', { get: () => '/tmp/cu-computer-use-tools' });
      scope.provide('subprocess', { spawn: () => { spawns += 1; throw new Error('SPAWN_REFUSED_BY_TEST'); } });
    },
  };
  let fiber = ctx.plugin(services); await fiber.inertia;
  return {
    agent, spawns: () => spawns,
    async remove() { await fiber.dispose(); await settle(); },
    async restore() { fiber = ctx.plugin(services); await fiber.inertia; await settle(); },
  };
}

async function boot(config?: unknown, options: { host?: boolean } = {}) {
  const ctx = new Context(); roots.push(ctx);
  await ctx.plugin(SystemPrompt).inertia; await ctx.plugin(ToolsService).inertia;
  const host = options.host ? await installHost(ctx) : undefined;
  const entry = '../../src/index.js';
  const plugin = await import(entry);
  const instance = ctx.plugin(plugin, config); await instance.inertia; await settle();
  return { ctx, instance, host };
}
const names = (ctx: Context) => ctx.tools.definitions().map((tool) => tool.name).sort();
async function run(ctx: Context, name: string, agent?: Agent) {
  const result = await executeToolFixture(ctx, { callId: ToolCallId(name), name, arguments: {}, signal: new AbortController().signal, ...(agent ? { agent } : {}) });
  const block = result.content.find((item) => item.type === 'text');
  return { isError: result.isError, text: block?.type === 'text' ? block.text : '' };
}
const status = async (ctx: Context) => JSON.parse((await run(ctx, 'cu_status')).text);

describe('CU-015/018: fixture tools are opt-in and closed', () => {
  it('registers only cu_status by default, even when the host services exist', async () => {
    const { ctx } = await boot(undefined, { host: true });
    expect(names(ctx)).toEqual(['cu_status']);
  });

  it('registers exactly cu_status, cu_observe, cu_act and cu_stop when fixture control is explicitly enabled', async () => {
    const { ctx } = await boot({ fixtureControl: true }, { host: true });
    expect(names(ctx)).toEqual(['cu_act', 'cu_observe', 'cu_status', 'cu_stop']);
    for (const tool of ctx.tools.definitions()) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      const keys = JSON.stringify(tool.parameters, (key, value) => key === 'description' ? undefined : value);
      expect(keys).not.toMatch(/script|selector|applescript|"pid"|bundle|agentId|approved|risk|sensitive/i);
    }
  });

  it('keeps the fixture tools unregistered while the host lacks a service they read', async () => {
    const { ctx } = await boot({ fixtureControl: true });
    expect(names(ctx)).toEqual(['cu_status']);
    expect(await status(ctx)).toMatchObject({ stage: 'fixture', control: 'disabled' });
  });

  it('reports fixture-only native control in status when enabled', async () => {
    const { ctx } = await boot({ fixtureControl: true }, { host: true });
    expect(await status(ctx)).toMatchObject({ stage: 'fixture', nativeControl: 'fixture_only', privateData: false, control: 'ready' });
  });

  it('refuses tool calls without a live host Agent context instead of acting', async () => {
    const { ctx, host } = await boot({ fixtureControl: true }, { host: true });
    const result = await run(ctx, 'cu_observe');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HOST_CONTEXT_UNAVAILABLE');
    expect(host!.spawns()).toBe(0);
  });

  it('reads the host services through the plugin entry, so cu_observe reaches the host subprocess service', async () => {
    const { ctx, host } = await boot({ fixtureControl: true, showFixture: false }, { host: true });
    const result = await run(ctx, 'cu_observe', host!.agent);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('SPAWN_REFUSED_BY_TEST');
    expect(host!.spawns()).toBe(1);
  });

  it('rejects unknown config keys and registers no tools', async () => {
    const { ctx } = await boot({ fixtureControl: true, allowApps: ['*'] }).catch(() => ({ ctx: roots.at(-1)! }));
    expect(ctx.tools.definitions()).toEqual([]);
  });

  it('unregisters every tool on disable', async () => {
    const { ctx, instance } = await boot({ fixtureControl: true }, { host: true });
    await instance.dispose();
    expect(ctx.tools.definitions()).toEqual([]);
  });

  it('cu_status reports control state, and cu_stop makes it stopped without needing a controller', async () => {
    const { ctx } = await boot({ fixtureControl: true }, { host: true });
    expect((await status(ctx)).control).toBe('ready');
    expect((await run(ctx, 'cu_stop')).isError).toBe(false);
    expect((await status(ctx)).control).toBe('stopped');
  });

  it('does not treat a host service reload as a stop', async () => {
    const { ctx, host } = await boot({ fixtureControl: true }, { host: true });
    await host!.remove();
    expect((await status(ctx)).control).toBe('disabled');
    await host!.restore();
    expect(names(ctx)).toEqual(['cu_act', 'cu_observe', 'cu_status', 'cu_stop']);
    expect((await status(ctx)).control).toBe('ready');
  });

  it('keeps a stop sticky when a host service the fixture tools read reloads', async () => {
    const { ctx, host } = await boot({ fixtureControl: true }, { host: true });
    expect((await run(ctx, 'cu_stop')).isError).toBe(false);
    await host!.remove();
    expect(names(ctx)).toEqual(['cu_status']);
    expect((await status(ctx)).control).toBe('stopped');
    await host!.restore();
    expect(names(ctx)).toEqual(['cu_act', 'cu_observe', 'cu_status', 'cu_stop']);
    expect((await status(ctx)).control).toBe('stopped');
  });
});
