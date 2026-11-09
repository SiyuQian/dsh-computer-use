import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { ApprovalService, ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import { beforeAll, describe, expect, it } from 'vitest';

type Module = typeof import('../../src/host-adapter/approval.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/host-adapter/approval.js';
  module = await import(path);
});
const pending = { approvalId: 'approval_fixture', summary: {
  operation: 'set_value' as const, inputLength: 21, pid: 41, windowId: 7, mode: 'background' as const,
  actionId: 'action_fixture', leaseId: 'lease_fixture', observationId: 'observation_fixture', targetHandle: 'text_fixture',
  processStart: 'process_fixture', windowKey: 'primary' as const, windowInstance: 'window_fixture', riskReason: 'unclassified_effect' as const,
} };
function fixture(options: { interactiveEnabled?: boolean } = {}) {
  const session = Session.create(SessionId('session_fixture'));
  const agent = { id: session.id, session } as Agent;
  const abort = new AbortController();
  let currentAgent = agent;
  let currentTurn = 1;
  let policy: 'ask' | 'never' | undefined;
  let requests = 0;
  let received: ApprovalRequest | undefined;
  let answer: () => Promise<ApprovalOutcome> = async () => 'allowed-once';
  const approval: Pick<ApprovalService, 'config' | 'overrideOf' | 'request'> = {
    config: {}, overrideOf: () => policy,
    request: async (request) => { requests += 1; received = request; return answer(); },
  };
  const ctx = {
    agents: { get: () => currentAgent, turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: currentTurn }) },
    sessions: { get: () => session }, workingDirectory: { get: () => '/tmp/cu-approval-fixture' }, approval,
  } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'> & { approval: typeof approval };
  const exec = { agent, callId: 'call_fixture', signal: abort.signal } as Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>;
  const adapter = new module.HostApprovalAdapter(ctx, options);
  return {
    adapter, exec, abort, approval, ctx,
    requests: () => requests,
    received: () => received,
    policy: (value: typeof policy) => { policy = value; },
    answer: (value: typeof answer) => { answer = value; },
    replaceAgent: () => { currentAgent = { ...agent }; },
    nextTurn: () => { currentTurn += 1; },
  };
}

describe('CU-009a: public host approval adapter seam, never a real prompt', () => {
  it('defaults to disabled even when the test-only host request would allow once', async () => {
    const f = fixture();
    expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe('unavailable');
    expect(f.requests()).toBe(0);
  });

  it('reads public override/config and refuses never before invoking the host request', async () => {
    const f = fixture({ interactiveEnabled: true });
    f.policy('never');
    expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe('unavailable');
    expect(f.requests()).toBe(0);
    f.policy(undefined);
    f.approval.config = { policy: 'never' };
    expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe('unavailable');
    expect(f.requests()).toBe(0);
  });

  it('passes only safe host summary metadata, exact live Agent and call signal to the public request', async () => {
    const f = fixture({ interactiveEnabled: true });
    expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe('allowed-once');
    expect(f.requests()).toBe(1);
    expect(f.received()).toMatchObject({ agent: f.exec.agent, callId: 'call_fixture', toolName: 'cu_act', signal: expect.any(AbortSignal) });
    expect(f.received()?.reason).toContain('set_value');
    expect(f.received()?.reason).toContain('21');
    expect(f.received()?.reason).not.toContain('private-fixture-value');
    expect(f.received()).not.toHaveProperty('action');
  });

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('preserves a public host %s result without changing policy', async (outcome) => {
    const f = fixture({ interactiveEnabled: true });
    f.answer(async () => outcome);
    expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe(outcome);
    expect(f.approval.config).toEqual({});
  });

  it('normalizes exceptions and out-of-vocabulary host answers without exposing source text', async () => {
    const f = fixture({ interactiveEnabled: true });
    f.answer(async () => { throw new Error('private-fixture-value'); });
    expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe('unavailable');
    f.answer(async () => 'model-approved' as ApprovalOutcome);
    expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe('unavailable');
  });

  it('rejects changed host objects, turn, or policy during an await and does not retry', async () => {
    for (const mutation of ['replaceAgent', 'nextTurn', 'never'] as const) {
      const f = fixture({ interactiveEnabled: true });
      f.answer(async () => { if (mutation === 'never') f.policy('never'); else f[mutation](); return 'allowed-once'; });
      expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe('unavailable');
      expect(f.requests()).toBe(1);
    }
  });

  it('cancels before calling the host and rejects a late answer if the call aborts', async () => {
    const f = fixture({ interactiveEnabled: true });
    f.abort.abort();
    expect(await f.adapter.request(f.exec, 'generation_fixture', pending)).toBe('cancelled');
    expect(f.requests()).toBe(0);
    const running = fixture({ interactiveEnabled: true });
    running.answer(async () => { running.abort.abort(); return 'allowed-once'; });
    expect(await running.adapter.request(running.exec, 'generation_fixture', pending)).toBe('cancelled');
  });

  it('returns cancellation without waiting for an upstream answerer that ignores its signal', async () => {
    const f = fixture({ interactiveEnabled: true });
    f.answer(() => new Promise(() => {}));
    const request = f.adapter.request(f.exec, 'generation_fixture', pending);
    f.abort.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      request,
      new Promise<string>((resolve) => { timeout = setTimeout(() => resolve('hung'), 100); }),
    ]);
    clearTimeout(timeout);
    expect(outcome).toBe('cancelled');
  });

  it('rejects injected input, reason or risk fields instead of forwarding them to host audit', async () => {
    const f = fixture({ interactiveEnabled: true });
    expect(await f.adapter.request(f.exec, 'generation_fixture', { ...pending, value: 'private-fixture-value' })).toBe('unavailable');
    expect(f.requests()).toBe(0);
    expect(await f.adapter.request(f.exec, 'generation_fixture', { ...pending, summary: { ...pending.summary, reason: 'private-fixture-value' } })).toBe('unavailable');
    expect(f.requests()).toBe(0);
  });
});
