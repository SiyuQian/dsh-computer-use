import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { sameHostScope, snapshotHostScope, snapshotHostScopeForRevocation, type HostScope } from '../host-adapter/scope.js';
import { fixtureTargetSchema, type FixtureTarget } from '../contracts/fixture-observation.js';
import { actionSchema } from '../contracts/actions.js';
import { opaqueId } from '../contracts/shared.js';
import { HostControlQueue, type TargetClaim, type WorkResult } from '../coordinator/control-queue.js';
import type { FixtureControlPolicy, ControlDecision } from '../policy/control.js';

const requestSchema = z.strictObject({ actionId: opaqueId, evaluation: z.strictObject({ leaseId: opaqueId, target: fixtureTargetSchema,
  action: actionSchema, approvalMode: z.enum(['request', 'never']), raiseRisk: z.boolean().default(false) }) });
export function parseSchedulingRequest(value: unknown) {
  try { return requestSchema.parse(value); } catch { throw invalid('INVALID_REQUEST'); }
}
type Current = (validate?: (context: HostContext) => void) => HostContext;
interface Claim { context: HostContext; scope: HostScope; leaseId: string; target: FixtureTarget; signal: AbortSignal; revoke: () => void }
function invalid(code = 'CONTROL_CLAIM_INVALID'): Error { return new Error(`${code}: A current exact inert host scheduling claim is required.`); }
function sameTarget(first: FixtureTarget, second: FixtureTarget): boolean {
  return first.pid === second.pid && first.processStart === second.processStart && first.windowKey === second.windowKey &&
    first.windowId === second.windowId && first.windowInstance === second.windowInstance;
}

/** Private fixed-policy scheduling only. No caller work closure, approval consumption, budget charge, ledger or native path exists. */
export class FixtureSchedulingService {
  readonly #queue = new HostControlQueue();
  readonly #claims = new Map<TargetClaim, Claim>();
  constructor(private readonly policy: FixtureControlPolicy) {}

  claim(current: Current, leaseId: string): TargetClaim {
    const context = current(); const target = this.policy.fixtureTargetFromHost(context, leaseId);
    const signal = this.policy.signalForHost(context, leaseId); current();
    if (signal.aborted) throw invalid();
    const ticket = this.#queue.claimTargetFromHost(context, target);
    const record: Claim = { context, scope: snapshotHostScope(context), leaseId, target, signal, revoke: () => this.#release(ticket) };
    this.#claims.set(ticket, record); signal.addEventListener('abort', record.revoke, { once: true });
    try {
      current((latest) => this.#requireClaim(latest, ticket, record));
      if (signal.aborted || this.#claims.get(ticket) !== record) throw invalid();
      return ticket;
    } catch { this.#release(ticket); throw invalid(); }
  }

  async evaluate(current: Current, ticket: TargetClaim, rawRequest: unknown): Promise<WorkResult<ControlDecision>> {
    const original = current();
    const request = parseSchedulingRequest(rawRequest);
    const record = this.#claims.get(ticket);
    if (!record) throw invalid();
    this.#requireClaim(current(), ticket, record);
    if (request.evaluation.leaseId !== record.leaseId || !sameTarget(request.evaluation.target, record.target)) throw invalid();
    const signal = AbortSignal.any([original.signal, record.signal]);
    const bound = () => {
      const latest = current((context) => this.#requireClaim(context, ticket, record));
      if (signal.aborted || this.#claims.get(ticket) !== record) throw invalid();
      return Object.freeze({ ...latest, signal });
    };
    return this.#queue.enqueue(bound, ticket, request.actionId, (permit) => {
      const context = bound();
      const result = this.policy.evaluate(context, request.evaluation);
      bound();
      if (permit.signal.aborted || signal.aborted) throw invalid();
      return result;
    });
  }

  release(context: HostContext, ticket: TargetClaim): void {
    const record = this.#claims.get(ticket);
    if (!record || !sameHostScope(record.scope, snapshotHostScopeForRevocation(context))) throw invalid();
    this.#release(ticket);
  }

  invalidateScopes(contexts: readonly HostContext[]): void {
    const scopes = contexts.map(snapshotHostScopeForRevocation);
    for (const [ticket, record] of this.#claims) if (scopes.some((scope) => sameHostScope(scope, record.scope))) this.#forget(ticket, record);
    this.#queue.invalidateScopesFromHost(contexts);
  }

  invalidateAll(): void { this.#forgetAll(); this.#queue.invalidateAllFromHost(); }
  stop(): void { this.#forgetAll(); this.#queue.stopFromHost(); }
  resume(): void { this.#queue.resumeFromHost(); }
  status() { return this.#queue.statusFromHost(); }
  waitForDrain(signal?: AbortSignal): Promise<boolean> { return this.#queue.waitForDrain(signal); }
  dispose(): void { this.#forgetAll(); this.#queue.dispose(); }

  #requireClaim(context: HostContext, ticket: TargetClaim, record: Claim): void {
    if (this.#claims.get(ticket) !== record || record.signal.aborted || !sameHostScope(snapshotHostScope(context), record.scope)) throw invalid();
    const target = this.policy.fixtureTargetFromHost(context, record.leaseId);
    if (!sameTarget(target, record.target) || record.signal.aborted || this.#claims.get(ticket) !== record) throw invalid();
  }

  #release(ticket: TargetClaim): void {
    const record = this.#claims.get(ticket);
    if (!record) return;
    this.#forget(ticket, record);
    this.#queue.releaseTargetFromHost(record.context, ticket);
  }

  #forget(ticket: TargetClaim, record: Claim): void { this.#claims.delete(ticket); record.signal.removeEventListener('abort', record.revoke); }
  #forgetAll(): void { for (const [ticket, record] of this.#claims) this.#forget(ticket, record); }
}
