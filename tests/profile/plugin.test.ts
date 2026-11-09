import { Context } from '@deepseek-ai/cordis';
import { ToolsService, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { afterEach, describe, expect, it } from 'vitest';

const roots: Context[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((ctx) => ctx.fiber.dispose()));
});

async function boot() {
  const ctx = new Context();
  roots.push(ctx);
  const prompt = ctx.plugin(SystemPrompt);
  await prompt.inertia;
  const tools = ctx.plugin(ToolsService);
  await tools.inertia;
  const entry = '../../src/index.js';
  const plugin = await import(entry);
  expect(plugin.apply).toBeTypeOf('function');
  const instance = ctx.plugin(plugin);
  await instance.inertia;
  return { ctx, instance };
}

function call(ctx: Context, args: unknown = {}, signal = new AbortController().signal) {
  return executeToolFixture(ctx, {
    callId: ToolCallId('fixture-status-call'),
    name: 'cu_status',
    arguments: args,
    signal,
  });
}

describe('A-01: isolated Cordis profile', () => {
  it('registers only a diagnostic tool; no native mutation path is exposed', async () => {
    const { ctx } = await boot();
    expect(ctx.tools.definitions().map((tool) => tool.name)).toEqual(['cu_status']);
    const result = await call(ctx);
    expect(result.isError).toBe(false);
    const text = result.content.find((block) => block.type === 'text');
    expect(text?.type === 'text' ? JSON.parse(text.text) : undefined).toEqual({
      stage: 'foundation',
      nativeControl: false,
      privateData: false,
      mode: 'background',
      platform: process.platform === 'darwin' ? 'macos' : 'unsupported',
    });
  });

  it('rejects injected arguments instead of accepting an owner or permission override', async () => {
    const { ctx } = await boot();
    const result = await call(ctx, { agentId: 'forged', nativeControl: true });
    expect(result.isError).toBe(true);
  });

  it('removes its tool when disabled and can load again without leaked registration', async () => {
    const { ctx, instance } = await boot();
    await instance.dispose();
    expect(ctx.tools.get('cu_status')).toBeUndefined();
    const missing = await call(ctx);
    expect(missing.isError).toBe(true);
    const entry = '../../src/index.js';
    const reload = ctx.plugin(await import(entry));
    await reload.inertia;
    expect((await call(ctx)).isError).toBe(false);
  });

  it('does not replace another plugin that already owns the tool name', async () => {
    const { ctx, instance } = await boot();
    await instance.dispose();
    const existing: ToolDefinition = {
      name: 'cu_status',
      description: 'Existing fixture diagnostic.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async () => 'existing',
    };
    ctx.tools.register(existing);
    const entry = '../../src/index.js';
    const conflict = ctx.plugin(await import(entry));
    await conflict.inertia;
    expect(ctx.tools.get('cu_status')).toBe(existing);
    await conflict.dispose();
    expect(ctx.tools.get('cu_status')).toBe(existing);
  });

  it('returns cancellation rather than a successful diagnostic after caller abort', async () => {
    const { ctx } = await boot();
    const abort = new AbortController();
    abort.abort();
    expect((await call(ctx, {}, abort.signal)).isError).toBe(true);
  });
});
