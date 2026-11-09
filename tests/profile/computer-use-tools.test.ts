import { Context } from '@deepseek-ai/cordis';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { afterEach, describe, expect, it } from 'vitest';

const roots: Context[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((ctx) => ctx.fiber.dispose())); });
async function boot(config?: unknown) {
  const ctx = new Context(); roots.push(ctx);
  await ctx.plugin(SystemPrompt).inertia; await ctx.plugin(ToolsService).inertia;
  const entry = '../../src/index.js';
  const plugin = await import(entry);
  const instance = ctx.plugin(plugin, config); await instance.inertia;
  return { ctx, instance };
}

describe('CU-015/018: fixture tools are opt-in and closed', () => {
  it('registers only cu_status by default', async () => {
    const { ctx } = await boot();
    expect(ctx.tools.definitions().map((tool) => tool.name)).toEqual(['cu_status']);
  });

  it('registers exactly cu_status, cu_observe, cu_act and cu_stop when fixture control is explicitly enabled', async () => {
    const { ctx } = await boot({ fixtureControl: true });
    expect(ctx.tools.definitions().map((tool) => tool.name).sort()).toEqual(['cu_act', 'cu_observe', 'cu_status', 'cu_stop']);
    for (const tool of ctx.tools.definitions()) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      const keys = JSON.stringify(tool.parameters, (key, value) => key === 'description' ? undefined : value);
      expect(keys).not.toMatch(/script|selector|applescript|"pid"|bundle|agentId|approved|risk|sensitive/i);
    }
  });

  it('reports fixture-only native control in status when enabled', async () => {
    const { ctx } = await boot({ fixtureControl: true });
    const result = await executeToolFixture(ctx, { callId: ToolCallId('status'), name: 'cu_status', arguments: {}, signal: new AbortController().signal });
    const text = result.content.find((block) => block.type === 'text');
    expect(JSON.parse(text?.type === 'text' ? text.text : '{}')).toMatchObject({ stage: 'fixture', nativeControl: 'fixture_only', privateData: false });
  });

  it('refuses tool calls without a live host Agent context instead of acting', async () => {
    const { ctx } = await boot({ fixtureControl: true });
    const result = await executeToolFixture(ctx, { callId: ToolCallId('observe'), name: 'cu_observe', arguments: {}, signal: new AbortController().signal });
    expect(result.isError).toBe(true);
  });

  it('rejects unknown config keys and registers no tools', async () => {
    const { ctx } = await boot({ fixtureControl: true, allowApps: ['*'] }).catch(() => ({ ctx: roots.at(-1)! }));
    expect(ctx.tools.definitions()).toEqual([]);
  });

  it('unregisters every tool on disable', async () => {
    const { ctx, instance } = await boot({ fixtureControl: true });
    await instance.dispose();
    expect(ctx.tools.definitions()).toEqual([]);
  });

  it('cu_status reports control state, and cu_stop makes it stopped without needing a controller', async () => {
    const { ctx } = await boot({ fixtureControl: true });
    const status = async () => {
      const result = await executeToolFixture(ctx, { callId: ToolCallId('s'), name: 'cu_status', arguments: {}, signal: new AbortController().signal });
      const text = result.content.find((block) => block.type === 'text'); return JSON.parse(text?.type === 'text' ? text.text : '{}');
    };
    expect((await status()).control).toBe('ready');
    const stopped = await executeToolFixture(ctx, { callId: ToolCallId('stop'), name: 'cu_stop', arguments: {}, signal: new AbortController().signal });
    expect(stopped.isError).toBe(false);
    expect((await status()).control).toBe('stopped');
  });
});
