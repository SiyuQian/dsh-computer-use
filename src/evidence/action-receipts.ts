import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { snapshotHostScope, snapshotHostScopeForRevocation, sameHostScope, type HostScope } from '../host-adapter/scope.js';
import { errorCodeSchema, opaqueId, parseContract } from '../contracts/shared.js';
import { parseReceipt, type ActionReceipt } from '../contracts/receipt.js';

const stages = ['validate', 'authorize', 'approve', 'lock', 'revalidate'] as const;
const stageSchema = z.enum(stages);
const targetSchema = z.enum(['exact', 'rebound']);
const acknowledgementSchema = z.enum(['attempted', 'completed']);
type ErrorCode = z.infer<typeof errorCodeSchema>;
type Phase = NonNullable<ActionReceipt['error']>['phase'];
interface Record {
  scope: HostScope;
  signal: AbortSignal;
  actionId: string;
  phase: Phase;
  execution: ActionReceipt['execution'];
  target: ActionReceipt['target'];
  dispatched: boolean;
  terminal?: ActionReceipt;
}
export interface ReceiptTrackingTicket {
  readonly kind: 'receipt_tracking_only';
  readonly dispatchable: false;
}
export interface TrackedActionReceipt {
  terminal: boolean;
  dispatchable: false;
  receipt: ActionReceipt;
}
function fail(code = 'RECEIPT_STATE_INVALID'): Error {
  return new Error(`${code}: A current host receipt-tracking state is required. No native work is dispatched by this tracker.`);
}
function cancelled(record: Record, context: HostContext): boolean { return record.signal.aborted || context.signal.aborted; }

/** Host-reported phase bookkeeping only. No backend, evidence authority, native permission, or model entry is provided. */
export class ActionReceiptTracker {
  readonly #records = new Map<object, Record>();
  readonly #actionIds = new Set<string>();
  readonly #maxActions: number;
  #disposed = false;

  constructor(options: { maxActions?: number } = {}) {
    this.#maxActions = options.maxActions ?? 64;
    if (!Number.isInteger(this.#maxActions) || this.#maxActions < 1 || this.#maxActions > 256) throw fail('INVALID_REQUEST');
  }

  /** Bind an existing host action ID. Shape validation does not authenticate that ID or grant execution. */
  beginFromHost(context: HostContext, rawActionId: unknown): ReceiptTrackingTicket {
    const scope = snapshotHostScope(context);
    const actionId = parseContract(opaqueId, rawActionId);
    if (this.#disposed) throw fail('RECEIPT_UNAVAILABLE');
    if (this.#actionIds.has(actionId)) throw fail('ACTION_ID_CONFLICT');
    if (this.#records.size >= this.#maxActions) throw fail('RECEIPT_CAPACITY');
    const ticket = Object.freeze({ kind: 'receipt_tracking_only' as const, dispatchable: false as const });
    this.#records.set(ticket, { scope, signal: context.signal, actionId, phase: 'validate', execution: 'not_executed', target: 'unknown', dispatched: false });
    this.#actionIds.add(actionId);
    return ticket;
  }

  /** Record one sequential host gate. Merely recording a phase does not evaluate or pass its authorization gate. */
  advanceFromHost(context: HostContext, ticket: object, rawPhase: unknown): void {
    const phase = parseContract(stageSchema, rawPhase);
    const record = this.#admission(context, ticket);
    const index = stages.indexOf(record.phase as typeof stages[number]);
    if (record.dispatched || index < 0 || stages[index + 1] !== phase) throw fail();
    record.phase = phase;
  }

  /** Only a trusted adapter may report native target validation. This method does not perform revalidation. */
  targetValidatedFromHost(context: HostContext, ticket: object, rawTarget: unknown): void {
    const target = parseContract(targetSchema, rawTarget);
    const record = this.#admission(context, ticket);
    if (record.phase !== 'revalidate' || record.dispatched || record.target !== 'unknown') throw fail();
    record.target = target;
  }

  /** Mark the conservative possible-dispatch boundary before handoff. Not an executor or durable ledger transaction. */
  dispatchPendingFromHost(context: HostContext, ticket: object): void {
    const record = this.#admission(context, ticket);
    if (record.phase !== 'revalidate' || record.dispatched || (record.target !== 'exact' && record.target !== 'rebound')) throw fail();
    record.dispatched = true;
    record.execution = 'unknown';
    record.phase = 'dispatch';
  }

  /** Report a correlated backend fact before sealing. Cancellation cannot erase an already observed execution fact. */
  acknowledgeFromHost(context: HostContext, ticket: object, rawExecution: unknown): void {
    const execution = parseContract(acknowledgementSchema, rawExecution);
    const record = this.#settlement(context, ticket);
    if (record.terminal || !record.dispatched || (record.execution === 'completed' && execution !== 'completed')) throw fail();
    record.execution = execution;
    record.phase = 'verify';
  }

  /** Seal with a closed failure code, not an arbitrary exception or caller-authored receipt. The first terminal is immutable. */
  failFromHost(context: HostContext, ticket: object, rawCode: unknown): TrackedActionReceipt {
    const code = parseContract(errorCodeSchema, rawCode);
    const record = this.#settlement(context, ticket);
    if (record.terminal) return this.#report(record);
    if (!record.dispatched && code === 'EFFECT_UNKNOWN') throw fail();
    this.#sealFailure(record, cancelled(record, context) ? 'CANCELLED' : code);
    return this.#report(record);
  }

  /** Finish only after possible handoff, preserving unknown or acknowledged execution and never inventing effect evidence. */
  finishFromHost(context: HostContext, ticket: object): TrackedActionReceipt {
    const record = this.#settlement(context, ticket);
    if (record.terminal) return this.#report(record);
    if (cancelled(record, context)) this.#sealFailure(record, 'CANCELLED');
    else if (!record.dispatched) throw fail();
    else if (record.execution === 'unknown') this.#sealFailure(record, 'EFFECT_UNKNOWN');
    else record.terminal = this.#receipt(record);
    return this.#report(record);
  }

  /** Read an isolated provisional or sealed projection. A terminal receipt never means work has drained. */
  snapshotFromHost(context: HostContext, ticket: object): TrackedActionReceipt { return this.#report(this.#settlement(context, ticket)); }

  /** Seal unfinished records only in the exact retired scopes; retain tombstones and every prior terminal. */
  cancelScopesFromHost(contexts: readonly HostContext[]): void {
    const scopes = contexts.map(snapshotHostScopeForRevocation);
    for (const record of this.#records.values()) {
      if (!record.terminal && scopes.some((scope) => sameHostScope(scope, record.scope))) this.#sealFailure(record, 'CANCELLED');
    }
  }

  cancelAllFromHost(): void { for (const record of this.#records.values()) if (!record.terminal) this.#sealFailure(record, 'CANCELLED'); }

  /** Close bookkeeping admission and seal unfinished actions conservatively; do not claim executor cancellation or drain. */
  dispose(): void {
    this.#disposed = true;
    for (const record of this.#records.values()) if (!record.terminal) this.#sealFailure(record, 'CANCELLED');
  }

  #admission(context: HostContext, ticket: object): Record {
    snapshotHostScope(context);
    const record = this.#settlement(context, ticket);
    if (cancelled(record, context)) throw fail('CANCELLED');
    if (this.#disposed) throw fail('RECEIPT_UNAVAILABLE');
    if (record.terminal) throw fail();
    return record;
  }
  #settlement(context: HostContext, ticket: object): Record {
    const scope = snapshotHostScopeForRevocation(context);
    const record = this.#records.get(ticket);
    if (!record || !sameHostScope(scope, record.scope)) throw fail('RECEIPT_UNAVAILABLE');
    return record;
  }
  #sealFailure(record: Record, code: ErrorCode): void {
    const cancellation = code === 'CANCELLED' || code === 'USER_INTERVENED';
    const phase = cancellation ? 'cancel' : record.phase;
    const observeFirst = !record.dispatched && phase === 'revalidate' && ['TARGET_CHANGED', 'TARGET_AMBIGUOUS', 'OBSERVATION_EXPIRED', 'FOCUS_CHANGED'].includes(code);
    record.terminal = this.#receipt(record, {
      code, phase, retry: observeFirst ? 'observe_first' : 'never',
    });
  }
  #receipt(record: Record, error?: NonNullable<ActionReceipt['error']>): ActionReceipt {
    return parseReceipt({
      actionId: record.actionId, execution: record.execution,
      target: !record.dispatched && error?.phase === 'revalidate' && (error.code === 'TARGET_CHANGED' || error.code === 'TARGET_AMBIGUOUS') ? 'invalid' : record.target,
      effect: record.execution === 'unknown' || (record.dispatched && !!error) ? 'unknown' : 'unverified',
      taskOutcome: 'not_evaluated', evidence: [], ...(error ? { error } : {}),
    });
  }
  #report(record: Record): TrackedActionReceipt {
    return { terminal: !!record.terminal, dispatchable: false, receipt: structuredClone(record.terminal ?? this.#receipt(record)) };
  }
}
