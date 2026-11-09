import { describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';
import { parseReceipt } from '../../src/contracts/receipt.js';
import { errorCodeSchema } from '../../src/contracts/shared.js';

import * as module from '../../src/evidence/action-receipts.js';

type Module = typeof module;
async function tracker(maxActions = 64) { return new module.ActionReceiptTracker({ maxActions }); }
function host(): HostContext {
  return {
    owner: { agentId: 'agent_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    workspace: '/tmp/cu-receipt-fixture', lifetime: Object.freeze({}), signal: new AbortController().signal, turn: 1, callId: 'call_fixture',
  };
}
function revalidated(store: InstanceType<Module['ActionReceiptTracker']>, context: HostContext, actionId = 'action_fixture', target: 'exact' | 'rebound' = 'exact') {
  const ticket = store.beginFromHost(context, actionId);
  for (const phase of ['authorize', 'approve', 'lock', 'revalidate'] as const) store.advanceFromHost(context, ticket, phase);
  store.targetValidatedFromHost(context, ticket, target);
  return ticket;
}
const noExecution = {
  actionId: 'action_fixture', execution: 'not_executed', target: 'unknown', effect: 'unverified', taskOutcome: 'not_evaluated', evidence: [],
};

describe('CU-013a: host-only conservative receipts from monotonic execution facts', () => {
  it('seals an exact scope conservatively without closing unrelated actions or changing an existing terminal', async () => {
    const store = await tracker(); const context = host(); const other = { ...host(), owner: { ...host().owner, sessionId: 'session_other', agentId: 'agent_other' } };
    const ticket = store.beginFromHost(context, 'action_pending'); const survivor = store.beginFromHost(other, 'action_other');
    const sealed = store.beginFromHost(context, 'action_sealed'); const first = store.failFromHost(context, sealed, 'CONTROL_DENIED');
    expect(store.cancelScopesFromHost).toBeTypeOf('function'); store.cancelScopesFromHost([{ ...context, signal: AbortSignal.abort() }]);
    expect(store.snapshotFromHost(context, ticket)).toMatchObject({ terminal: true, receipt: { execution: 'not_executed', error: { code: 'CANCELLED', phase: 'cancel' } } });
    expect(store.snapshotFromHost(context, sealed)).toEqual(first); expect(store.snapshotFromHost(other, survivor).terminal).toBe(false);
    expect(() => store.advanceFromHost(context, ticket, 'authorize')).toThrow(); store.advanceFromHost(other, survivor, 'authorize');
    store.cancelAllFromHost(); expect(store.snapshotFromHost(other, survivor).terminal).toBe(true);
    expect(() => store.beginFromHost(context, 'action_pending')).toThrow('ACTION_ID_CONFLICT');
    expect(store.beginFromHost(context, 'action_after_cleanup')).toBeDefined(); store.dispose();
  });

  it.each(['pending', 'attempted', 'completed'] as const)('preserves the existing %s execution fact during exact-scope lifecycle sealing', async (phase) => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
    store.dispatchPendingFromHost(context, ticket); if (phase !== 'pending') store.acknowledgeFromHost(context, ticket, phase);
    store.cancelScopesFromHost([context]);
    expect(store.snapshotFromHost(context, ticket).receipt).toMatchObject({ execution: phase === 'pending' ? 'unknown' : phase, target: 'exact', effect: 'unknown', error: { code: 'CANCELLED', phase: 'cancel', retry: 'never' } });
    store.dispose();
  });

  it('does not project a policy-stage target refusal as a native target-validation fact', async () => {
    const store = await tracker(); const context = host(); const ticket = store.beginFromHost(context, 'action_policy_target');
    store.advanceFromHost(context, ticket, 'authorize');
    expect(store.failFromHost(context, ticket, 'TARGET_CHANGED').receipt).toMatchObject({ target: 'unknown', execution: 'not_executed', error: { phase: 'authorize', retry: 'never' } }); store.dispose();
  });

  it('reports pre-dispatch validation rejection without claiming an attempted or successful action', async () => {
    const store = await tracker(); const context = host();
    const ticket = store.beginFromHost(context, 'action_fixture');
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket).toMatchObject({ kind: 'receipt_tracking_only', dispatchable: false });
    const report = store.failFromHost(context, ticket, 'INVALID_REQUEST');
    expect(report).toEqual({ terminal: true, dispatchable: false, receipt: { ...noExecution, error: { code: 'INVALID_REQUEST', phase: 'validate', retry: 'never' } } });
    expect(parseReceipt(report.receipt)).toEqual(report.receipt);
  });

  it.each([
    { phase: 'authorize', code: 'CONTROL_DENIED', retry: 'never' },
    { phase: 'approve', code: 'APPROVAL_UNAVAILABLE', retry: 'never' },
    { phase: 'lock', code: 'CONTROL_BUSY', retry: 'never' },
    { phase: 'revalidate', code: 'TARGET_CHANGED', retry: 'observe_first' },
  ] as const)('reports $code in the actual $phase stage, not as post-dispatch unknown', async ({ phase, code, retry }) => {
    const store = await tracker(); const context = host(); const ticket = store.beginFromHost(context, 'action_fixture');
    for (const current of ['authorize', 'approve', 'lock', 'revalidate'] as const) {
      store.advanceFromHost(context, ticket, current); if (current === phase) break;
    }
    expect(store.failFromHost(context, ticket, code).receipt).toEqual({ ...noExecution, target: code === 'TARGET_CHANGED' ? 'invalid' : 'unknown', error: { code, phase, retry } });
  });

  it.each(['NATIVE_TIMEOUT', 'PROTOCOL_MISMATCH', 'CANCELLED', 'USER_INTERVENED'] as const)('keeps an unacknowledged possible dispatch unknown after $code with retry never', async (code) => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
    store.dispatchPendingFromHost(context, ticket);
    expect(store.failFromHost(context, ticket, code).receipt).toEqual({
      ...noExecution, execution: 'unknown', target: 'exact', effect: 'unknown',
      error: { code, phase: code === 'CANCELLED' || code === 'USER_INTERVENED' ? 'cancel' : 'dispatch', retry: 'never' },
    });
  });

  it.each(['attempted', 'completed'] as const)('preserves the acknowledged $0 fact when readback, screenshot or transport subsequently fails', async (execution) => {
    for (const code of ['NATIVE_TIMEOUT', 'ARTIFACT_INVALID', 'TARGET_CHANGED'] as const) {
      const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
      store.dispatchPendingFromHost(context, ticket); store.acknowledgeFromHost(context, ticket, execution);
      const report = store.failFromHost(context, ticket, code);
      expect(report.receipt).toMatchObject({ execution, effect: 'unknown', taskOutcome: 'not_evaluated', evidence: [], error: { code, phase: 'verify', retry: 'never' } });
      expect(parseReceipt(report.receipt)).toEqual(report.receipt);
    }
  });

  it('does not infer a verified effect or task success from a completed native acknowledgement', async () => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context, 'action_fixture', 'rebound');
    store.dispatchPendingFromHost(context, ticket); store.acknowledgeFromHost(context, ticket, 'completed');
    expect(store.finishFromHost(context, ticket)).toEqual({ terminal: true, dispatchable: false, receipt: { ...noExecution, execution: 'completed', target: 'rebound' } });
  });

  it('finishes a possible dispatch with no acknowledgement as unknown, not not-executed or clean success', async () => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
    store.dispatchPendingFromHost(context, ticket);
    expect(store.finishFromHost(context, ticket).receipt).toEqual({ ...noExecution, execution: 'unknown', target: 'exact', effect: 'unknown', error: { code: 'EFFECT_UNKNOWN', phase: 'dispatch', retry: 'never' } });
  });

  it('rejects a skipped gate, unvalidated dispatch, duplicate pending, impossible acknowledgement, and phase regression', async () => {
    const store = await tracker(); const context = host(); const ticket = store.beginFromHost(context, 'action_fixture');
    expect(() => store.advanceFromHost(context, ticket, 'lock')).toThrow('RECEIPT_STATE_INVALID');
    expect(() => store.acknowledgeFromHost(context, ticket, 'completed')).toThrow('RECEIPT_STATE_INVALID');
    expect(() => store.finishFromHost(context, ticket)).toThrow('RECEIPT_STATE_INVALID');
    for (const phase of ['authorize', 'approve', 'lock', 'revalidate'] as const) store.advanceFromHost(context, ticket, phase);
    expect(() => store.dispatchPendingFromHost(context, ticket)).toThrow('RECEIPT_STATE_INVALID');
    store.targetValidatedFromHost(context, ticket, 'exact'); store.dispatchPendingFromHost(context, ticket);
    expect(() => store.dispatchPendingFromHost(context, ticket)).toThrow('RECEIPT_STATE_INVALID');
    store.acknowledgeFromHost(context, ticket, 'completed');
    expect(() => store.acknowledgeFromHost(context, ticket, 'attempted')).toThrow('RECEIPT_STATE_INVALID');
    expect(() => store.advanceFromHost(context, ticket, 'revalidate')).toThrow('RECEIPT_STATE_INVALID');
  });

  it('can upgrade attempted to completed but cannot downgrade acknowledged execution facts', async () => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
    store.dispatchPendingFromHost(context, ticket); store.acknowledgeFromHost(context, ticket, 'attempted');
    store.acknowledgeFromHost(context, ticket, 'attempted'); store.acknowledgeFromHost(context, ticket, 'completed');
    expect(store.finishFromHost(context, ticket).receipt.execution).toBe('completed');
  });

  it('does not trust cloned, foreign-instance or other-host tickets as backend facts', async () => {
    const store = await tracker(); const otherStore = await tracker(); const context = host();
    const ticket = revalidated(store, context);
    for (const forged of [{ ...ticket }, Object.freeze({}), revalidated(otherStore, context)]) {
      expect(() => store.dispatchPendingFromHost(context, forged)).toThrow('RECEIPT_UNAVAILABLE');
    }
    for (const changed of [
      { ...context, lifetime: Object.freeze({}) }, { ...context, workspace: '/tmp/another-workspace' },
      { ...context, owner: { ...context.owner, sessionId: 'session_other' } },
    ]) expect(() => store.snapshotFromHost(changed, ticket)).toThrow('RECEIPT_UNAVAILABLE');
  });

  it.each(['before', 'pending', 'completed'] as const)('settles cancellation $0 without erasing earlier execution facts or reopening admission', async (when) => {
    const store = await tracker(); const abort = new AbortController(); const context = { ...host(), signal: abort.signal };
    const ticket = revalidated(store, context);
    if (when !== 'before') store.dispatchPendingFromHost(context, ticket);
    if (when === 'completed') store.acknowledgeFromHost(context, ticket, 'completed');
    abort.abort();
    expect(() => store.advanceFromHost(context, ticket, 'revalidate')).toThrow('CANCELLED');
    const report = when === 'before' ? store.failFromHost(context, ticket, 'CANCELLED') : store.finishFromHost(context, ticket);
    expect(report.receipt.execution).toBe(when === 'before' ? 'not_executed' : when === 'pending' ? 'unknown' : 'completed');
    expect(report.receipt.error).toEqual({ code: 'CANCELLED', phase: 'cancel', retry: 'never' });
    expect(parseReceipt(report.receipt)).toEqual(report.receipt);
  });

  it('does not revive a cancelled action by changing the current caller signal', async () => {
    const store = await tracker(); const abort = new AbortController(); const context = { ...host(), signal: abort.signal };
    const ticket = revalidated(store, context); abort.abort();
    const freshSignal = { ...context, signal: new AbortController().signal };
    expect(() => store.dispatchPendingFromHost(freshSignal, ticket)).toThrow('CANCELLED');
    expect(store.failFromHost(freshSignal, ticket, 'CANCELLED').receipt.execution).toBe('not_executed');
  });

  it('can record a definite backend acknowledgement after cancellation but before sealing the final receipt', async () => {
    const store = await tracker(); const abort = new AbortController(); const context = { ...host(), signal: abort.signal };
    const ticket = revalidated(store, context); store.dispatchPendingFromHost(context, ticket); abort.abort();
    store.acknowledgeFromHost(context, ticket, 'completed');
    expect(store.finishFromHost(context, ticket).receipt).toMatchObject({ execution: 'completed', error: { code: 'CANCELLED', phase: 'cancel' } });
  });

  it('does not accept raw errors, arbitrary phases, fabricated target proofs or claimed effects', async () => {
    const store = await tracker(); const context = host(); const ticket = store.beginFromHost(context, 'action_fixture');
    for (const raw of [new Error('private-fixture-detail'), 'private-fixture-detail', { code: 'CANCELLED', effect: 'verified' }]) {
      expect(() => store.failFromHost(context, ticket, raw)).toThrow('INVALID_REQUEST');
    }
    expect(() => store.advanceFromHost(context, ticket, { phase: 'dispatch', approved: true })).toThrow('INVALID_REQUEST');
    expect(() => store.targetValidatedFromHost(context, ticket, { target: 'exact', proof: 'model' })).toThrow('INVALID_REQUEST');
    expect(() => store.acknowledgeFromHost(context, ticket, { execution: 'completed', effect: 'verified' })).toThrow('INVALID_REQUEST');
    expect(() => store.failFromHost(context, ticket, 'EFFECT_UNKNOWN')).toThrow('RECEIPT_STATE_INVALID');
  });

  it('keeps terminal receipts stable despite repeated failures, returned-object edits, or late acknowledgements', async () => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
    store.dispatchPendingFromHost(context, ticket);
    const first = store.failFromHost(context, ticket, 'NATIVE_TIMEOUT');
    first.receipt.execution = 'not_executed'; first.receipt.evidence.push({ kind: 'target_readback', evidenceId: 'evidence_model' });
    const repeated = store.failFromHost(context, ticket, 'CANCELLED');
    expect(repeated.receipt).toMatchObject({ execution: 'unknown', effect: 'unknown', evidence: [], error: { code: 'NATIVE_TIMEOUT' } });
    expect(() => store.acknowledgeFromHost(context, ticket, 'completed')).toThrow('RECEIPT_STATE_INVALID');
    expect(store.finishFromHost(context, ticket)).toEqual(repeated);
  });

  it('reports a provisional snapshot without making a terminal or drain claim, and isolates returned projections', async () => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
    const before = store.snapshotFromHost(context, ticket);
    expect(before).toMatchObject({ terminal: false, dispatchable: false, receipt: { execution: 'not_executed', target: 'exact', evidence: [] } });
    before.receipt.target = 'invalid';
    store.dispatchPendingFromHost(context, ticket);
    const pending = store.snapshotFromHost(context, ticket);
    expect(pending).toMatchObject({ terminal: false, receipt: { execution: 'unknown', target: 'exact', effect: 'unknown' } });
    expect(parseReceipt(pending.receipt)).toEqual(pending.receipt);
  });

  it.each(['CAPABILITY_UNAVAILABLE', 'READ_DENIED', 'LEASE_EXPIRED', 'NATIVE_TIMEOUT', 'ACTION_ID_CONFLICT'] as const)('keeps retry conservative for pre-dispatch %s even when re-observing cannot fix it', async (code) => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
    const report = store.failFromHost(context, ticket, code);
    expect(report.receipt).toMatchObject({ execution: 'not_executed', effect: 'unverified', error: { code, phase: 'revalidate', retry: 'never' } });
    expect(parseReceipt(report.receipt)).toEqual(report.receipt);
  });

  it.each(['TARGET_AMBIGUOUS', 'FOCUS_CHANGED', 'OBSERVATION_EXPIRED'] as const)('only permits observe-first for pre-dispatch target freshness failure %s', async (code) => {
    const store = await tracker(); const context = host(); const ticket = revalidated(store, context);
    const report = store.failFromHost(context, ticket, code);
    expect(report.receipt).toMatchObject({ execution: 'not_executed', error: { code, phase: 'revalidate', retry: 'observe_first' } });
    expect(parseReceipt(report.receipt)).toEqual(report.receipt);
  });

  it('rejects arbitrary ticket IDs and invalid limits without reserving state or retaining original error detail', async () => {
    const store = await tracker(); const context = host();
    for (const id of ['../action', '', { actionId: 'action_fixture', approved: true }]) expect(() => store.beginFromHost(context, id)).toThrow('INVALID_REQUEST');
    for (const maxActions of [0, 257, NaN, 1.5]) expect(() => new module.ActionReceiptTracker({ maxActions })).toThrow('INVALID_REQUEST');
    const abort = new AbortController(); abort.abort();
    expect(() => store.beginFromHost({ ...context, signal: abort.signal }, 'action_fixture')).toThrow('CANCELLED');
    const ticket = store.beginFromHost(context, 'action_fixture');
    let detail = '';
    try { store.failFromHost(context, ticket, new Error('private-fixture-detail')); }
    catch (error) { detail = String(error); }
    expect(detail).toContain('INVALID_REQUEST'); expect(detail.includes('private-fixture-detail')).toBe(false);
    expect(store.snapshotFromHost(context, ticket).terminal).toBe(false);
  });

  it('keeps the first terminal error and phase when cancellation or disposal happens later', async () => {
    const store = await tracker(); const abort = new AbortController(); const context = { ...host(), signal: abort.signal };
    const ticket = revalidated(store, context); store.dispatchPendingFromHost(context, ticket);
    const original = store.failFromHost(context, ticket, 'NATIVE_TIMEOUT');
    abort.abort(); store.dispose();
    expect(store.finishFromHost(context, ticket)).toEqual(original);
    expect(store.failFromHost(context, ticket, 'USER_INTERVENED')).toEqual(original);
  });

  it('maintains conservative receipt invariants for every closed failure code across all reachable stages', async () => {
    for (const phase of ['validate', 'authorize', 'approve', 'lock', 'revalidate', 'pending', 'attempted', 'completed'] as const) {
      for (const code of errorCodeSchema.options) {
        const store = await tracker(); const context = host(); const ticket = store.beginFromHost(context, 'action_fixture');
        const postDispatch = phase === 'pending' || phase === 'attempted' || phase === 'completed';
        if (phase !== 'validate') {
          for (const stage of ['authorize', 'approve', 'lock', 'revalidate'] as const) {
            store.advanceFromHost(context, ticket, stage); if (stage === phase) break;
          }
        }
        if (postDispatch) {
          store.targetValidatedFromHost(context, ticket, 'exact'); store.dispatchPendingFromHost(context, ticket);
          if (phase !== 'pending') store.acknowledgeFromHost(context, ticket, phase);
        }
        if (!postDispatch && code === 'EFFECT_UNKNOWN') {
          expect(() => store.failFromHost(context, ticket, code)).toThrow('RECEIPT_STATE_INVALID'); continue;
        }
        const report = store.failFromHost(context, ticket, code);
        expect(parseReceipt(report.receipt)).toEqual(report.receipt);
        expect(report.receipt.execution).toBe(!postDispatch ? 'not_executed' : phase === 'pending' ? 'unknown' : phase);
        expect(report.receipt.effect === 'verified' || report.receipt.taskOutcome === 'verified' || report.receipt.evidence.length > 0).toBe(false);
        if (postDispatch) expect(report.receipt.error?.retry).toBe('never');
      }
    }
  });

  it('never evicts a prior action tombstone or opens a second record for the same action ID', async () => {
    const store = await tracker(1); const context = host(); const ticket = store.beginFromHost(context, 'action_fixture');
    store.failFromHost(context, ticket, 'INVALID_REQUEST');
    expect(() => store.beginFromHost(context, 'action_fixture')).toThrow('ACTION_ID_CONFLICT');
    expect(() => store.beginFromHost(context, 'action_other')).toThrow('RECEIPT_CAPACITY');
    expect(store.snapshotFromHost(context, ticket).receipt.error?.code).toBe('INVALID_REQUEST');
  });

  it('disposes by sealing conservative cancellation receipts without implying work has drained', async () => {
    const store = await tracker(); const context = host(); const before = store.beginFromHost(context, 'action_before');
    const pending = revalidated(store, context); store.dispatchPendingFromHost(context, pending);
    store.dispose(); store.dispose();
    expect(store.snapshotFromHost(context, before).receipt.execution).toBe('not_executed');
    expect(store.snapshotFromHost(context, pending).receipt).toMatchObject({ execution: 'unknown', error: { code: 'CANCELLED', phase: 'cancel', retry: 'never' } });
    expect(() => store.beginFromHost(context, 'action_new')).toThrow('RECEIPT_UNAVAILABLE');
    expect(store.finishFromHost(context, pending).dispatchable).toBe(false);
  });
});
