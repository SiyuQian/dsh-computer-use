import type { HostContext } from '../host-adapter/context.js';
import { isQueueCapacityFailure, type TargetClaim } from '../coordinator/control-queue.js';
import { ActionReceiptTracker, type TrackedActionReceipt } from '../evidence/action-receipts.js';
import { FixtureSchedulingService, parseSchedulingRequest } from './fixture-scheduling.js';

/** Report only fixed policy evaluation outcomes. No native execution, ACK, target validation, approval or dispatch methods exist. */
export class FixtureEvaluationReceiptService {
  readonly #receipts = new ActionReceiptTracker();
  constructor(private readonly scheduling: FixtureSchedulingService) {}

  async evaluate(current: () => HostContext, claim: TargetClaim, rawRequest: unknown): Promise<TrackedActionReceipt> {
    const original = current(); const request = parseSchedulingRequest(rawRequest); current();
    const ticket = this.#receipts.beginFromHost(original, request.actionId);
    try {
      this.#receipts.advanceFromHost(original, ticket, 'authorize');
      const result = await this.scheduling.evaluate(current, claim, request);
      if (this.#receipts.snapshotFromHost(original, ticket).terminal) return this.#receipts.snapshotFromHost(original, ticket);
      if (result.outcome === 'cancelled') return this.#receipts.failFromHost(original, ticket, 'CANCELLED');
      current();
      if (this.#receipts.snapshotFromHost(original, ticket).terminal) return this.#receipts.snapshotFromHost(original, ticket);
      if (result.outcome !== 'returned') return this.#receipts.failFromHost(original, ticket, 'CONTROL_DENIED');
      const decision = result.value;
      if (decision.decision === 'REQUIRE_APPROVAL') {
        this.#receipts.advanceFromHost(original, ticket, 'approve');
        return this.#receipts.failFromHost(original, ticket, 'APPROVAL_REQUIRED');
      }
      if (decision.decision === 'DENY') return this.#receipts.failFromHost(original, ticket, decision.code ?? 'CONTROL_DENIED');
      return this.#receipts.failFromHost(original, ticket, 'CAPABILITY_UNAVAILABLE');
    } catch (error) { return this.#receipts.failFromHost(original, ticket, isQueueCapacityFailure(error) ? 'CONTROL_BUSY' : 'CONTROL_DENIED'); }
  }

  invalidateScopes(contexts: readonly HostContext[]): void { this.#receipts.cancelScopesFromHost(contexts); }
  invalidateAll(): void { this.#receipts.cancelAllFromHost(); }
  dispose(): void { this.#receipts.dispose(); }
}
