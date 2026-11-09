import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { actionSchema } from '../contracts/actions.js';
import { fixtureTargetSchema } from '../contracts/fixture-observation.js';
import { opaqueId } from '../contracts/shared.js';
import type { FixtureControlPolicy } from '../policy/control.js';
import { SingleUseApprovals } from '../policy/approvals.js';

const proposalSchema = z.strictObject({
  actionId: opaqueId, leaseId: opaqueId, observationId: opaqueId, materialContext: opaqueId,
  target: fixtureTargetSchema, action: actionSchema, approvalMode: z.enum(['request', 'never']), raiseRisk: z.boolean().default(false),
});
type Proposal = z.infer<typeof proposalSchema>;
class ApprovalServiceError extends Error {}
function invalid(code = 'APPROVAL_INVALIDATED'): ApprovalServiceError {
  return new ApprovalServiceError(`${code}: A current exact inert host approval binding is required.`);
}
function parseProposal(value: unknown): Proposal {
  try { return proposalSchema.parse(value); } catch { throw invalid('INVALID_REQUEST'); }
}

/** Host-only lifecycle composition. Observation/material IDs are host declarations, not read membership or native proof. */
export class FixtureApprovalService {
  readonly #approvals = new SingleUseApprovals();
  #busy = false;
  constructor(private readonly policy: FixtureControlPolicy) {}

  prepare(current: () => HostContext, rawProposal: unknown) {
    return this.#operation(() => {
      const original = current(); const proposal = parseProposal(rawProposal);
      const bound = this.#binding(current, proposal);
      const pending = this.#approvals.prepare(bound.context, bound.envelope);
      try { this.#binding(current, proposal); if (bound.context.signal.aborted) throw invalid(); return pending; }
      catch { this.#approvals.discardFromHost(original, pending.approvalId); throw invalid(); }
    });
  }

  decide(current: () => HostContext, approvalId: string, rawProposal: unknown, outcome: unknown): void {
    this.#operation(() => {
      const original = current();
      try {
        const proposal = parseProposal(rawProposal); const bound = this.#binding(current, proposal);
        this.#approvals.decideBoundFromHost(bound.context, approvalId, bound.envelope, outcome);
        this.#binding(current, proposal); if (bound.context.signal.aborted) throw invalid();
      } catch (error) { this.#approvals.discardFromHost(original, approvalId); throw error; }
    });
  }

  consume(current: () => HostContext, approvalId: string, rawProposal: unknown) {
    return this.#operation(() => {
      const original = current();
      try {
        const proposal = parseProposal(rawProposal); const bound = this.#binding(current, proposal);
        const result = this.#approvals.consume(bound.context, approvalId, bound.envelope);
        this.#binding(current, proposal); if (bound.context.signal.aborted) throw invalid();
        return result;
      } catch (error) { this.#approvals.discardFromHost(original, approvalId); throw error; }
    });
  }

  invalidateScope(context: HostContext): void { this.#approvals.invalidateScopeFromHost(context); }
  invalidateAll(): void { this.#approvals.invalidateFromHost(); }
  dispose(): void { this.#approvals.dispose(); }

  #binding(current: () => HostContext, proposal: Proposal) {
    const context = current();
    const decision = this.policy.evaluate(context, { leaseId: proposal.leaseId, target: proposal.target, action: proposal.action,
      approvalMode: proposal.approvalMode, raiseRisk: proposal.raiseRisk });
    if (decision.decision !== 'REQUIRE_APPROVAL' || (decision.reason !== 'unclassified_effect' && decision.reason !== 'raised_risk')) throw invalid();
    const lease = this.policy.getForHost(context, proposal.leaseId);
    const signal = this.policy.signalForHost(context, proposal.leaseId);
    const latest = current();
    if (signal.aborted || context.signal.aborted || latest.turn !== context.turn) throw invalid();
    return {
      context: Object.freeze({ ...latest, signal: AbortSignal.any([context.signal, signal]) }),
      envelope: { actionId: proposal.actionId, leaseId: proposal.leaseId, observationId: proposal.observationId, materialContext: proposal.materialContext,
        target: proposal.target, action: proposal.action, mode: lease.mode, policyVersion: lease.policyVersion,
        revocationVersion: lease.revocationVersion, riskReason: decision.reason, raiseRisk: proposal.raiseRisk },
    };
  }

  #operation<T>(work: () => T): T {
    if (this.#busy) throw invalid(); this.#busy = true;
    try { return work(); }
    catch (error) { if (error instanceof ApprovalServiceError) throw error; throw invalid(); }
    finally { this.#busy = false; }
  }
}
