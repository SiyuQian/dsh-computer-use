import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';
import { DurableActionLedger, recoverActionJournalFromHost } from '../../src/coordinator/action-ledger.js';
import { ActionReceiptTracker } from '../../src/evidence/action-receipts.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const exact = await realpath(directory);
    if (!exact.startsWith(join(await realpath(tmpdir()), 'cu-receipt-ledger-'))) throw new Error('Refuse cleanup outside owned test directory.');
    await rm(exact, { recursive: true });
  }
});
const proposal = {
  taskLeaseId: 'lease_fixture', observationId: 'obs_fixture',
  target: { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' },
  action: { kind: 'set_value', targetHandle: 'text_fixture', value: 'private-fixture-ledger-value' },
  mode: 'background', policyVersion: 'policy_fixture', revocationVersion: 0, materialContext: 'context_fixture',
};
async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cu-receipt-ledger-'))); directories.push(directory);
  const abort = new AbortController();
  const context: HostContext = {
    owner: { agentId: 'agent_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    workspace: '/tmp/cu-receipt-fixture', lifetime: Object.freeze({}), signal: abort.signal, turn: 1, callId: 'call_fixture',
  };
  const ledger = await DurableActionLedger.create({ directory });
  const prepared = await ledger.prepareFromHost(context, proposal);
  const tracker = new ActionReceiptTracker();
  const ticket = tracker.beginFromHost(context, prepared.actionId);
  for (const phase of ['authorize', 'approve', 'lock', 'revalidate'] as const) tracker.advanceFromHost(context, ticket, phase);
  tracker.targetValidatedFromHost(context, ticket, 'exact');
  return { directory, context, ledger, tracker, ticket, prepared, abort };
}

describe('CU-013a: ledger/receipt semantic seam with inert host facts only', () => {
  it('persists an unknown terminal after durable pending and never records a retryable non-execution', async () => {
    const state = await setup(); const { ledger, tracker, context, prepared, ticket, directory } = state;
    try {
      expect((await ledger.beginDispatchFromHost(context, prepared.actionId, proposal)).firstTransition).toBe(true);
      tracker.dispatchPendingFromHost(context, ticket);
      const { receipt } = tracker.failFromHost(context, ticket, 'NATIVE_TIMEOUT');
      expect(receipt).toMatchObject({ execution: 'unknown', effect: 'unknown', error: { retry: 'never' } });
      await ledger.finishFromHost(context, prepared.actionId, { execution: receipt.execution, effect: receipt.effect, taskOutcome: receipt.taskOutcome });
      expect((await ledger.beginDispatchFromHost(context, prepared.actionId, proposal)).firstTransition).toBe(false);
    } finally { await ledger.close(); }
    expect((await recoverActionJournalFromHost(directory)).actions[0]).toMatchObject({ state: 'terminal', summary: { execution: 'unknown', effect: 'unknown', taskOutcome: 'not_evaluated' }, dispatchable: false });
    expect((await readFile(join(directory, 'actions.journal'), 'utf8')).includes('private-fixture-ledger-value')).toBe(false);
  });

  it('preserves completed execution in the durable summary even when cancellation and verification failure follow', async () => {
    const { ledger, tracker, context, prepared, ticket, abort, directory } = await setup();
    try {
      await ledger.beginDispatchFromHost(context, prepared.actionId, proposal); tracker.dispatchPendingFromHost(context, ticket);
      tracker.acknowledgeFromHost(context, ticket, 'completed'); abort.abort();
      const { receipt } = tracker.failFromHost(context, ticket, 'NATIVE_TIMEOUT');
      expect(receipt).toMatchObject({ execution: 'completed', effect: 'unknown', error: { code: 'CANCELLED', phase: 'cancel', retry: 'never' } });
      await ledger.finishFromHost(context, prepared.actionId, { execution: receipt.execution, effect: receipt.effect, taskOutcome: receipt.taskOutcome });
    } finally { await ledger.close(); }
    expect((await recoverActionJournalFromHost(directory)).actions[0]).toMatchObject({ state: 'terminal', summary: { execution: 'completed', effect: 'unknown' } });
  });

  it('keeps a failed pre-dispatch target check separate from a possible-dispatch record and recovers it as non-replayable', async () => {
    const { ledger, tracker, context, ticket, directory } = await setup();
    try {
      const report = tracker.failFromHost(context, ticket, 'TARGET_CHANGED');
      expect(report.receipt).toMatchObject({ execution: 'not_executed', target: 'invalid', error: { retry: 'observe_first' } });
      expect((await readFile(join(directory, 'actions.journal'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
    } finally { await ledger.close(); }
    expect((await recoverActionJournalFromHost(directory)).actions[0]).toMatchObject({ state: 'replay_rejected', dispatchable: false });
  });
});
