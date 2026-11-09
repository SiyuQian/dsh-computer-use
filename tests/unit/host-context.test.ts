import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import { beforeAll, describe, expect, it } from 'vitest';

type Adapter = typeof import('../../src/host-adapter/context.js');
let adapter: Adapter;
beforeAll(async () => {
  const path = '../../src/host-adapter/context.js';
  adapter = await import(path);
});

function hostFixture() {
  const session = Session.create(SessionId('session_fixture'));
  // The external host owns the Agent implementation. This fixture supplies only the borrowed fields read at this seam.
  const agent = { id: session.id, session } as Agent;
  const abort = new AbortController();
  let liveAgent: Agent | undefined = agent;
  let liveSession: Session | undefined = session;
  let openTurn: number | null = 4;
  let directory = '/tmp/computer-use-fixture';
  const host = {
    agents: {
      get: () => liveAgent,
      turnBoundaryOf: () => ({ openTurnStartSeq: openTurn === null ? null : SessionSeq(openTurn), lastTurn: 2 }),
    },
    sessions: { get: () => liveSession },
    workingDirectory: { get: () => directory },
  } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  const exec = { agent, callId: 'host_call', signal: abort.signal } as Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>;
  return {
    host, exec, session, agent, abort,
    removeAgent: () => { liveAgent = undefined; },
    replaceAgent: () => { liveAgent = { ...agent }; },
    replaceSession: () => { liveSession = Session.create(session.id); },
    closeTurn: () => { openTurn = null; },
    changeDirectory: (path: string) => { directory = path; },
  };
}

describe('A-02: trusted host binding', () => {
  it('uses registered Agent, exact live Session, open turn, and current host directory', () => {
    const fixture = hostFixture();
    expect(adapter.bindHostContext(fixture.host, fixture.exec, 'generation_fixture')).toMatchObject({
      owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
      callId: 'host_call',
      turn: 2,
      workspace: '/tmp/computer-use-fixture',
      signal: fixture.abort.signal,
    });
    fixture.changeDirectory('/tmp/changed-fixture');
    expect(adapter.bindHostContext(fixture.host, fixture.exec, 'generation_fixture').workspace).toBe('/tmp/changed-fixture');
  });

  it.each(['removeAgent', 'replaceAgent', 'replaceSession', 'closeTurn'] as const)('rejects %s rather than accepting an ID match', (mutation) => {
    const fixture = hostFixture();
    fixture[mutation]();
    expect(() => adapter.bindHostContext(fixture.host, fixture.exec, 'generation_fixture')).toThrow('HOST_CONTEXT_UNAVAILABLE');
  });

  it('rejects calls without an Agent, with mismatched Session identity, or a relative workspace', () => {
    const fixture = hostFixture();
    expect(() => adapter.bindHostContext(fixture.host, { callId: fixture.exec.callId, signal: fixture.exec.signal }, 'generation_fixture')).toThrow('HOST_CONTEXT_UNAVAILABLE');
    fixture.changeDirectory('../private');
    expect(() => adapter.bindHostContext(fixture.host, fixture.exec, 'generation_fixture')).toThrow('HOST_CONTEXT_UNAVAILABLE');
  });

  it('fails before reading host state when the caller has already aborted', () => {
    const fixture = hostFixture();
    fixture.abort.abort();
    expect(() => adapter.bindHostContext(fixture.host, fixture.exec, 'generation_fixture')).toThrow();
  });

  it('binds a stable opaque lifetime to the exact Agent/Session objects, not their reused IDs', () => {
    const first = hostFixture();
    const next = hostFixture();
    const bound = adapter.bindHostContext(first.host, first.exec, 'generation_fixture');
    expect(bound.lifetime).toBe(adapter.bindHostContext(first.host, first.exec, 'generation_fixture').lifetime);
    expect(bound.lifetime).not.toBe(adapter.bindHostContext(next.host, next.exec, 'generation_fixture').lifetime);
    expect(Object.isFrozen(bound.lifetime)).toBe(true);
  });

  it('returns immutable identity data, but never treats that binding as a control grant', () => {
    const fixture = hostFixture();
    const bound = adapter.bindHostContext(fixture.host, fixture.exec, 'generation_fixture');
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.owner)).toBe(true);
    expect(bound).not.toHaveProperty('approved');
    expect(bound).not.toHaveProperty('taskLeaseId');
  });
});
