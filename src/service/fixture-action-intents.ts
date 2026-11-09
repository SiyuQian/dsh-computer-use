import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { sameHostScope, snapshotHostScope, snapshotHostScopeForRevocation, type HostScope } from '../host-adapter/scope.js';
import { actionSchema } from '../contracts/actions.js';
import { opaqueId } from '../contracts/shared.js';
import type { ObservationStore, FixtureTargetCandidate } from '../observation/store.js';
import type { FixtureReadAuthority } from '../policy/read-authority.js';

const requestSchema = z.strictObject({ observationId: opaqueId, action: actionSchema });
type Request = z.infer<typeof requestSchema>;
type Current = (validate?: (context: HostContext) => void) => HostContext;
export interface ActionIntentTicket { readonly kind: 'observation_action_intent' }
interface Record {
  scope: HostScope; turn: number; deadline: number; grantId: string; digest: Buffer; signal: AbortSignal;
  timer: ReturnType<typeof setTimeout>; cancel: () => void; consuming?: boolean;
}
function invalid(code = 'INTENT_INVALIDATED'): Error { return new Error(`${code}: A current observation-backed inert action intent is required.`); }
function parse(value: unknown): Request { try { return requestSchema.parse(value); } catch { throw invalid('INVALID_REQUEST'); } }

/** Short-lived observation membership binding only. Never a read grant, control lease, approval or native permit. */
export class FixtureActionIntentService {
  readonly #key = randomBytes(32);
  readonly #records = new Map<ActionIntentTicket, Record>();
  #lastNow = 0;
  #epoch = 0;
  #disposed = false;
  #busy = false;
  constructor(private readonly dependencies: { observations: ObservationStore; authority: FixtureReadAuthority }) {}

  stage(current: Current, grantId: string, rawRequest: unknown): ActionIntentTicket {
    return this.#operation(() => {
      const epoch = this.#epoch; const original = current(); const now = this.#now(); const request = parse(rawRequest); this.#prune(now);
      if (this.#records.size >= 64) throw invalid('INTENT_CAPACITY');
      const bound = this.#binding(current, grantId, request);
      const ticket: ActionIntentTicket = Object.freeze({ kind: 'observation_action_intent' });
      const signal = AbortSignal.any([original.signal, bound.signal]);
      const cancel = () => this.#remove(ticket); const timer = setTimeout(cancel, 10_000); timer.unref();
      const record: Record = { scope: snapshotHostScope(original), turn: original.turn, deadline: Math.min(now + 10_000, bound.monotonicDeadline), grantId,
        digest: this.#digest(request, bound.materialContext), signal, cancel, timer };
      this.#records.set(ticket, record); signal.addEventListener('abort', cancel, { once: true });
      try {
        this.#binding(current, grantId, request, () => this.#requireLive(ticket, record, epoch));
        this.#assertMember(ticket, record, epoch); return ticket;
      } catch (error) { this.#remove(ticket); throw error; }
    });
  }

  consume(current: Current, grantId: string, ticket: ActionIntentTicket, rawRequest: unknown) {
    return this.#operation(() => {
      const epoch = this.#epoch; const original = current(); const record = this.#records.get(ticket);
      if (!record || record.consuming || !sameHostScope(record.scope, snapshotHostScope(original))) throw invalid();
      record.consuming = true;
      let digest: Buffer | undefined;
      try {
        if (original.turn !== record.turn || record.grantId !== grantId) throw invalid();
        const request = parse(rawRequest); const bound = this.#binding(current, grantId, request, () => this.#requireLive(ticket, record, epoch));
        digest = this.#digest(request, bound.materialContext);
        if (!timingSafeEqual(record.digest, digest)) throw invalid();
        this.#assertMember(ticket, record, epoch);
        return { status: 'candidate' as const, dispatchable: false as const, requiresNativeRevalidation: true as const,
          observationId: request.observationId, target: structuredClone(bound.candidate.target), action: request.action, materialContext: bound.materialContext };
      } finally { this.#remove(ticket); digest?.fill(0); }
    });
  }

  invalidate(context: HostContext): void {
    const scope = snapshotHostScopeForRevocation(context); this.#epoch += 1;
    for (const [ticket, record] of this.#records) if (sameHostScope(scope, record.scope)) this.#remove(ticket);
  }
  invalidateAll(): void { this.#epoch += 1; for (const ticket of this.#records.keys()) this.#remove(ticket); }
  dispose(): void { this.#disposed = true; this.invalidateAll(); this.#key.fill(0); }

  #binding(current: Current, grantId: string, request: Request, validate: () => void = () => {}) {
    const { observations, authority } = this.dependencies;
    let candidate!: FixtureTargetCandidate; let revision = ''; let signal!: AbortSignal; let monotonicDeadline = 0;
    current((context) => {
      const source = observations.actionIntentSourceFromHost(context, request.observationId, request.action.targetHandle, request.action.kind);
      candidate = source.candidate; revision = source.structureRevision;
      const permit = authority.requireRead(context, grantId, candidate.target); signal = permit.signal;
      monotonicDeadline = Math.min(source.monotonicDeadline, permit.monotonicDeadline);
      const final = observations.actionIntentSourceFromHost(context, request.observationId, request.action.targetHandle, request.action.kind);
      if (JSON.stringify(final.candidate) !== JSON.stringify(candidate) || final.structureRevision !== revision || signal.aborted) throw invalid();
      validate();
    });
    const materialContext = `context_${createHmac('sha256', this.#key).update(JSON.stringify([request.observationId, revision, candidate.target, candidate.element])).digest('hex')}`;
    return { candidate, materialContext, signal, monotonicDeadline };
  }

  #digest(request: Request, materialContext: string): Buffer {
    return createHmac('sha256', this.#key).update(JSON.stringify([request.observationId, request.action.kind, request.action.targetHandle,
      request.action.kind === 'set_value' ? request.action.value : undefined, materialContext])).digest();
  }
  #requireLive(ticket: ActionIntentTicket, record: Record, epoch: number): void {
    if (this.#now() >= record.deadline) throw invalid(); this.#assertMember(ticket, record, epoch);
  }
  #assertMember(ticket: ActionIntentTicket, record: Record, epoch: number): void {
    if (this.#disposed || epoch !== this.#epoch || record.signal.aborted || this.#records.get(ticket) !== record) throw invalid();
  }
  #remove(ticket: ActionIntentTicket): void {
    const record = this.#records.get(ticket); if (!record) return; this.#records.delete(ticket);
    clearTimeout(record.timer); record.signal.removeEventListener('abort', record.cancel); record.digest.fill(0);
  }
  #prune(now: number): void { for (const [ticket, record] of this.#records) if (now >= record.deadline || record.signal.aborted) this.#remove(ticket); }
  #now(): number {
    if (this.#disposed) throw invalid(); let now: number;
    try { now = performance.now(); } catch { this.invalidateAll(); throw invalid(); }
    if (!Number.isFinite(now) || now < this.#lastNow) { this.invalidateAll(); throw invalid(); }
    this.#lastNow = now; return now;
  }
  #operation<T>(operation: () => T): T {
    if (this.#busy || this.#disposed) throw invalid(); this.#busy = true;
    try { return operation(); } finally { this.#busy = false; }
  }
}
