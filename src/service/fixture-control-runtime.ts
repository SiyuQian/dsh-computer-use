import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import { HostScopeRegistry, hostContextUnavailable, snapshotHostCall, type HostCall, type HostServices } from '../host-adapter/scope-registry.js';
import { FixtureControlPolicy, parseControlEvaluation, type ControlDecision } from '../policy/control.js';
import { FixtureApprovalService } from './fixture-approvals.js';
import { FixtureSchedulingService } from './fixture-scheduling.js';
import { FixtureEvaluationReceiptService } from './fixture-evaluation-receipts.js';
import type { TargetClaim } from '../coordinator/control-queue.js';
import type { HostContext } from '../host-adapter/context.js';

function denied(): ControlDecision {
  return { decision: 'DENY', code: 'CONTROL_DENIED', reason: 'not_authorized', dispatchable: false, requiresNativeRevalidation: true };
}

/** Private inert fixture lifecycle: policy, simulated approval binding and fixed policy scheduling. Never native dispatch. */
export class FixtureControlRuntime {
  readonly #policy = new FixtureControlPolicy();
  readonly #approvals = new FixtureApprovalService(this.#policy);
  readonly #scopes: HostScopeRegistry;
  readonly #scheduling = new FixtureSchedulingService(this.#policy);
  readonly #evaluationReceipts = new FixtureEvaluationReceiptService(this.#scheduling);
  #stopped = false;
  #stopVersion = 0;

  constructor(host: HostServices, options: { maxScopes?: number } = {}) {
    this.#scopes = new HostScopeRegistry(host, {
      invalidate: (contexts) => {
        this.#evaluationReceipts.invalidateScopes(contexts);
        for (const context of contexts) this.#approvals.invalidateScope(context);
        this.#scheduling.invalidateScopes(contexts);
        for (const context of contexts) this.#policy.revokeScopeFromHost(context);
      },
      policyChanged: () => { this.#evaluationReceipts.invalidateAll(); this.#approvals.invalidateAll(); this.#scheduling.invalidateAll(); this.#policy.policyChangedFromHost(); },
      dispose: () => { this.#evaluationReceipts.dispose(); this.#approvals.dispose(); this.#scheduling.dispose(); this.#policy.dispose(); },
    }, 'CONTROL', options);
  }

  /** Explicit trusted static metadata, not consent or a native identity witness. No caller-created lease is accepted. */
  issueFromHost(exec: HostCall, spec: unknown) {
    this.#requireRunning();
    const stopVersion = this.#stopVersion;
    const call = snapshotHostCall(exec); this.#requireRunning(stopVersion);
    const context = this.#scopes.bind(call); const epoch = this.#scopes.epoch; this.#requireRunning(stopVersion);
    const lease = this.#policy.issueFromHost(context, spec);
    try {
      const signal = this.#policy.signalForHost(context, lease.taskLeaseId);
      this.#scopes.requireCurrent(call, context, epoch);
      if (signal.aborted) throw hostContextUnavailable();
      return lease;
    } catch { this.#policy.revokeFromHost(lease.taskLeaseId); throw hostContextUnavailable(); }
  }

  evaluate(exec: HostCall, rawRequest: unknown): ControlDecision {
    this.#requireRunning();
    const stopVersion = this.#stopVersion;
    const call = snapshotHostCall(exec);
    const request = parseControlEvaluation(rawRequest); this.#requireRunning(stopVersion);
    const context = this.#scopes.bind(call); const epoch = this.#scopes.epoch;
    const result = this.#policy.evaluate(context, request);
    if (result.decision === 'DENY') return result;
    let signal: AbortSignal;
    try { signal = this.#policy.signalForHost(context, request.leaseId); } catch { return denied(); }
    this.#scopes.requireCurrent(call, context, epoch);
    return signal.aborted ? denied() : result;
  }

  /** Lease-revocation signal only. Receiving it does not permit work or claim backend drain. */
  signalForHost(exec: HostCall, leaseId: string): AbortSignal {
    this.#requireRunning();
    const stopVersion = this.#stopVersion;
    const call = snapshotHostCall(exec); this.#requireRunning(stopVersion);
    const context = this.#scopes.bind(call); const epoch = this.#scopes.epoch; this.#requireRunning(stopVersion);
    const signal = this.#policy.signalForHost(context, leaseId);
    this.#scopes.requireCurrent(call, context, epoch);
    if (signal.aborted) throw hostContextUnavailable('CONTROL_DENIED');
    return signal;
  }

  /** Internal simulated-host binding only. Never calls an approval UI, scheduler, executor, or native backend. */
  prepareApprovalFromHost(exec: HostCall, proposal: unknown) {
    return this.#approvals.prepare(this.#pinnedCurrent(exec), proposal);
  }

  decideApprovalFromHost(exec: HostCall, approvalId: string, proposal: unknown, outcome: unknown): void {
    this.#approvals.decide(this.#pinnedCurrent(exec), approvalId, proposal, outcome);
  }

  consumeApprovalFromHost(exec: HostCall, approvalId: string, proposal: unknown) {
    return this.#approvals.consume(this.#pinnedCurrent(exec), approvalId, proposal);
  }

  #pinnedCurrent(exec: HostCall) {
    this.#requireRunning();
    const stopVersion = this.#stopVersion;
    const call = snapshotHostCall(exec); this.#requireRunning(stopVersion);
    const original = this.#scopes.bind(call); const epoch = this.#scopes.epoch; this.#requireRunning(stopVersion);
    return (validate?: (context: HostContext) => void) => {
      this.#requireRunning(stopVersion);
      const latest = this.#scopes.requireCurrent(call, original, epoch, validate);
      if (latest.turn !== original.turn) throw hostContextUnavailable();
      return latest;
    };
  }

  claimTargetFromHost(exec: HostCall, leaseId: string) { return this.#scheduling.claim(this.#pinnedCurrent(exec), leaseId); }

  async queueEvaluationFromHost(exec: HostCall, claim: TargetClaim, request: unknown) {
    return this.#scheduling.evaluate(this.#pinnedCurrent(exec), claim, request);
  }

  /** Fixed inert evaluation only. workStarted is never reported as input execution; no ACK or evidence API is exposed. */
  async queueEvaluationReceiptFromHost(exec: HostCall, claim: TargetClaim, request: unknown) {
    return this.#evaluationReceipts.evaluate(this.#pinnedCurrent(exec), claim, request);
  }

  releaseTargetFromHost(exec: HostCall, claim: TargetClaim): void {
    this.#scheduling.release(this.#scopes.contextForCleanup(snapshotHostCall(exec)), claim);
  }

  coordinationStatusFromHost() { return this.#scheduling.status(); }
  waitForControlDrainFromHost(signal?: AbortSignal): Promise<boolean> { return this.#scheduling.waitForDrain(signal); }

  stopFromHost(): void {
    this.#stopped = true; this.#stopVersion += 1;
    this.#evaluationReceipts.invalidateAll();
    this.#scheduling.stop();
    this.#scopes.policyChangedFromHost();
  }

  resumeFromHost(): void {
    this.#scopes.assertActive();
    this.#scheduling.resume();
    this.#stopped = false;
  }

  #requireRunning(version = this.#stopVersion): void {
    if (this.#stopped || version !== this.#stopVersion) throw new Error('CONTROL_STOPPED: Inert host control is stopped.');
  }

  agentDisposedFromHost(agent: Agent): void { this.#scopes.agentDisposedFromHost(agent); }
  sessionDisposedFromHost(session: Session): void { this.#scopes.sessionDisposedFromHost(session); }
  workspaceChangedFromHost(session: Session): void { this.#scopes.workspaceChangedFromHost(session); }
  policyChangedFromHost(): void { this.#scopes.policyChangedFromHost(); }
  dispose(): void { this.#scopes.dispose(); }
}
