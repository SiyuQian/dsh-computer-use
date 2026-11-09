import { Context } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { afterEach, describe, expect, it } from 'vitest';
import { requestFixtureApproval } from '../../src/host-adapter/fixture-tools.js';

const roots: Context[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((ctx) => ctx.fiber.dispose())); });

const session = { id: 'session_approval' };
const agent = { id: session.id, session };
const summary = { operation: 'press' as const, identifier: 'fixture.save', inputLength: 0, windowKey: 'primary', riskReason: 'unknown_impact' };
const call = () => ({ agent: agent as never, callId: ToolCallId('call_approval'), signal: new AbortController().signal });

function fakeApproval(outcome: string, policy = 'ask') {
  const requests: ApprovalRequest[] = [];
  return { requests, service: { config: { policy }, overrideOf: () => undefined,
    request: async (request: ApprovalRequest) => { requests.push(request); return outcome; } } };
}

/**
 * A plugin scope that, like the real entry, does not declare approval as a required dependency. In a real profile
 * the approval service comes from its own plugin, so it is provided by a sibling plugin here, not by the root.
 */
async function pluginScope(approval?: object): Promise<Context> {
  const root = new Context(); roots.push(root);
  if (approval) await root.plugin({ name: 'cu-test-approval', apply(scope: Context) { scope.provide('approval', approval); } }).inertia;
  let captured: Context | undefined;
  await root.plugin({ name: 'cu-approval-probe', apply(scope: Context) { captured = scope; } }).inertia;
  return captured!;
}

describe('fixture approval reads the optional host approval service', () => {
  it('asks the host approval service without declaring it as a required dependency', async () => {
    const approval = fakeApproval('rejected');
    const scope = await pluginScope(approval.service);
    await expect(requestFixtureApproval(scope, call(), summary)).resolves.toBe('rejected');
    expect(approval.requests).toHaveLength(1);
    expect(approval.requests[0]).toMatchObject({ toolName: 'cu_act', callId: 'call_approval' });
  });

  it('refuses instead of throwing when the host has no approval service', async () => {
    const scope = await pluginScope();
    await expect(requestFixtureApproval(scope, call(), summary)).resolves.toBe('unavailable');
  });

  it('does not prompt when the approval policy is never', async () => {
    const approval = fakeApproval('allowed-once', 'never');
    const scope = await pluginScope(approval.service);
    await expect(requestFixtureApproval(scope, call(), summary)).resolves.toBe('unavailable');
    expect(approval.requests).toHaveLength(0);
  });
});
