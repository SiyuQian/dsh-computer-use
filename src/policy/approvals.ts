import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { snapshotHostScope, snapshotHostScopeForRevocation, sameHostScope, type HostScope } from '../host-adapter/scope.js';
import { actionSchema } from '../contracts/actions.js';
import { fixtureTargetSchema } from '../contracts/fixture-observation.js';
import { opaqueId, parseContract } from '../contracts/shared.js';
import type { PendingApprovalSummary } from '../contracts/approval-summary.js';

const envelopeSchema = z.strictObject({
  actionId: opaqueId, leaseId: opaqueId, observationId: opaqueId, target: fixtureTargetSchema,
  action: actionSchema, mode: z.literal('background'), policyVersion: opaqueId,
  revocationVersion: z.number().int().nonnegative(), materialContext: opaqueId,
  riskReason: z.enum(['unclassified_effect', 'raised_risk']), raiseRisk: z.boolean().default(false),
});
const outcomeSchema = z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
type Envelope = z.infer<typeof envelopeSchema>;
interface PendingApproval {
  scope: HostScope;
  turn: number;
  digest: Buffer;
  deadline: number;
  approved: boolean;
  consuming?: boolean;
  signal: AbortSignal;
  cancel: () => void;
  timer: ReturnType<typeof setTimeout>;
}
function invalid(code = 'APPROVAL_INVALIDATED'): Error {
  return new Error(`${code}: A current single-use host approval is required. No native action was dispatched.`);
}
function canonicalEnvelope(value: Envelope): string {
  // Fixed positions encode the closed envelope without relying on caller property insertion order.
  return JSON.stringify([
    1, value.actionId, value.leaseId, value.observationId,
    value.target.pid, value.target.processStart, value.target.windowKey, value.target.windowId, value.target.windowInstance,
    value.action.kind, value.action.targetHandle, value.action.kind === 'set_value' ? value.action.value : undefined,
    value.mode, value.policyVersion, value.revocationVersion, value.materialContext, value.riskReason, value.raiseRisk,
  ]);
}

/** Host-only single-use binding. Host decisions are not user consent unless a trusted host adapter obtained it. */
export class SingleUseApprovals {
  readonly #clock: () => number;
  readonly #maxPending: number;
  readonly #records = new Map<string, PendingApproval>();
  readonly #key = randomBytes(32);
  #lastNow = 0;
  #disposed = false;
  #epoch = 0;

  constructor(options: { monotonicMs?: () => number; maxPending?: number } = {}) {
    this.#clock = options.monotonicMs ?? (() => performance.now());
    this.#maxPending = options.maxPending ?? 64;
    if (!Number.isInteger(this.#maxPending) || this.#maxPending < 1 || this.#maxPending > 256) throw invalid('INVALID_REQUEST');
  }

  /** Create a safe summary plus private keyed fingerprint. Original text is never retained in the registry. */
  prepare(context: HostContext, rawEnvelope: unknown): PendingApprovalSummary {
    const epoch = this.#epoch;
    const scope = snapshotHostScope(context);
    const envelope = parseContract(envelopeSchema, rawEnvelope);
    const now = this.#now();
    this.#prune(now);
    if (this.#records.size >= this.#maxPending) throw invalid('APPROVAL_CAPACITY');
    const approvalId = `approval_${randomUUID()}`;
    const cancel = () => this.#remove(approvalId);
    const timer = setTimeout(cancel, 60_000);
    timer.unref();
    const record: PendingApproval = {
      scope, turn: context.turn, digest: this.#digest(envelope), deadline: now + 60_000, approved: false,
      signal: context.signal, cancel, timer,
    };
    this.#records.set(approvalId, record);
    context.signal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted || this.#disposed || epoch !== this.#epoch || this.#records.get(approvalId) !== record) { this.#remove(approvalId); throw invalid(); }
    return {
      approvalId,
      summary: {
        operation: envelope.action.kind, inputLength: envelope.action.kind === 'set_value' ? envelope.action.value.length : 0,
        pid: envelope.target.pid, windowId: envelope.target.windowId, mode: envelope.mode,
        actionId: envelope.actionId, leaseId: envelope.leaseId, observationId: envelope.observationId,
        targetHandle: envelope.action.targetHandle, processStart: envelope.target.processStart,
        windowKey: envelope.target.windowKey, windowInstance: envelope.target.windowInstance, riskReason: envelope.riskReason,
      },
    };
  }

  /** Trusted host approval result only. Tests simulate this explicitly; no real prompt or global answerer is installed. */
  decideFromHost(context: HostContext, approvalId: string, rawOutcome: unknown): void {
    const outcome = parseContract(outcomeSchema, rawOutcome);
    const record = this.#record(context, approvalId);
    if (record.approved) { this.#remove(approvalId); throw invalid(); }
    if (outcome !== 'allowed-once') { this.#remove(approvalId); return; }
    record.approved = true;
  }

  /** Host answer bound to the complete current envelope, not just a display ID. A mismatch permanently removes the ticket. */
  decideBoundFromHost(context: HostContext, approvalId: string, rawEnvelope: unknown, rawOutcome: unknown): void {
    const epoch = this.#epoch;
    const record = this.#record(context, approvalId);
    let digest: Buffer | undefined;
    try {
      const envelope = parseContract(envelopeSchema, rawEnvelope); const outcome = parseContract(outcomeSchema, rawOutcome);
      digest = this.#digest(envelope);
      if (record.approved || !timingSafeEqual(record.digest, digest) || this.#now() >= record.deadline || record.signal.aborted || context.signal.aborted ||
          epoch !== this.#epoch || this.#disposed || this.#records.get(approvalId) !== record) throw invalid();
      if (outcome === 'allowed-once') record.approved = true; else this.#remove(approvalId);
    } catch { this.#remove(approvalId); throw invalid(); }
    finally { digest?.fill(0); }
  }

  /** Mark single-use before validation, retain revocation membership until finally. Never a dispatch permit. */
  consume(context: HostContext, approvalId: string, rawEnvelope: unknown): { status: 'consumed'; dispatchable: false } {
    const epoch = this.#epoch;
    const record = this.#record(context, approvalId);
    record.consuming = true;
    let digest: Buffer | undefined;
    try {
      const envelope = parseContract(envelopeSchema, rawEnvelope);
      digest = this.#digest(envelope);
      if (!record.approved || !timingSafeEqual(record.digest, digest) || this.#now() >= record.deadline ||
          context.signal.aborted || record.signal.aborted || epoch !== this.#epoch || this.#disposed || this.#records.get(approvalId) !== record) throw invalid();
      return { status: 'consumed', dispatchable: false };
    } finally { this.#remove(approvalId); record.digest.fill(0); digest?.fill(0); }
  }

  /** Authority-reducing cleanup; a cancelled caller cannot block removal of its exact-scope records. */
  discardFromHost(context: HostContext, approvalId: string): void {
    const scope = snapshotHostScopeForRevocation(context);
    const record = this.#records.get(approvalId);
    if (record && sameHostScope(record.scope, scope)) this.#remove(approvalId);
  }

  invalidateScopeFromHost(context: HostContext): void {
    const scope = snapshotHostScopeForRevocation(context); this.#epoch += 1;
    for (const [id, record] of this.#records) if (sameHostScope(record.scope, scope)) this.#remove(id);
  }

  invalidateFromHost(): void {
    this.#epoch += 1;
    for (const id of this.#records.keys()) this.#remove(id);
  }

  dispose(): void {
    this.#disposed = true;
    this.invalidateFromHost();
    this.#key.fill(0);
  }

  #record(context: HostContext, id: string): PendingApproval {
    const scope = snapshotHostScope(context);
    const now = this.#now();
    this.#prune(now);
    const record = this.#records.get(id);
    if (!record || record.consuming || !sameHostScope(record.scope, scope)) throw invalid();
    if (record.turn !== context.turn || record.signal.aborted) { this.#remove(id); throw invalid(); }
    return record;
  }

  #digest(envelope: Envelope): Buffer {
    return createHmac('sha256', this.#key).update(canonicalEnvelope(envelope)).digest();
  }

  #remove(id: string): void {
    const record = this.#records.get(id);
    if (!record) return;
    this.#records.delete(id);
    clearTimeout(record.timer);
    record.signal.removeEventListener('abort', record.cancel);
    record.digest.fill(0);
  }

  #prune(now: number): void {
    for (const [id, record] of this.#records) if (now >= record.deadline || record.signal.aborted) this.#remove(id);
  }

  #now(): number {
    if (this.#disposed) throw invalid();
    let now: number;
    try { now = this.#clock(); }
    catch { this.invalidateFromHost(); throw invalid('CLOCK_UNAVAILABLE'); }
    if (!Number.isFinite(now) || now < this.#lastNow) { this.invalidateFromHost(); throw invalid('CLOCK_UNAVAILABLE'); }
    this.#lastNow = now;
    return now;
  }
}
