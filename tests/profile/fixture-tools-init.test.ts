import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerFixtureTools } from '../../src/host-adapter/fixture-tools.js';

/** Minimal live-looking host. Spawn always fails, so no fixture or native process ever starts. */
function fakeHost() {
  const session = { id: 'session_init' };
  const agent = { id: session.id, session };
  const tools = new Map<string, ToolDefinition>();
  const disposers: Array<() => void> = [];
  let spawns = 0;
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); } },
    effect: (body: () => Generator<unknown>) => { for (const value of body()) if (typeof value === 'function') disposers.push(value as () => void); },
    on: () => () => {},
    agents: { get: (id: string) => (id === agent.id ? agent : undefined), turnBoundaryOf: () => ({ openTurnStartSeq: 1, lastTurn: 1 }) },
    sessions: { get: (id: string) => (id === session.id ? session : undefined) },
    workingDirectory: { get: () => '/tmp/cu-fixture-tools-init' },
    subprocess: { spawn: () => { spawns += 1; throw new Error('spawn refused by test'); } },
  };
  return { ctx: ctx as unknown as Context, tools, agent, spawns: () => spawns, dispose: () => { for (const dispose of disposers) dispose(); } };
}

describe('review #4: concurrent first calls share one fixture runtime', () => {
  it('creates a single fixture session when two cu_observe calls race on first use', async () => {
    const host = fakeHost();
    registerFixtureTools(host.ctx, resolve('.'), { visible: false });
    try {
      const observe = host.tools.get('cu_observe')!;
      const call = (id: string, window: string) => observe.execute({ window }, { agent: host.agent, callId: ToolCallId(id), signal: new AbortController().signal } as never);
      const results = await Promise.allSettled([call('first', 'primary'), call('second', 'secondary')]);
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(host.spawns()).toBe(1);
    } finally { host.dispose(); }
  });
});
