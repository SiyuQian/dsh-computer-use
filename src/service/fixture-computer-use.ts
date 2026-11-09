import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { HostScopeRegistry, snapshotHostCall, type HostCall, type HostServices, type ScopeLifecycle } from '../host-adapter/scope-registry.js';
import { fixtureTargetSchema, type FixtureActResponse, type FixtureElement, type FixtureTarget } from '../contracts/fixture-observation.js';
import { actionSchema } from '../contracts/actions.js';
import type { Observation } from '../contracts/observation.js';
import { opaqueId, parseContract } from '../contracts/shared.js';
import type { ActionReceipt } from '../contracts/receipt.js';
import { FixtureReadAuthority } from '../policy/read-authority.js';
import { FixtureControlPolicy } from '../policy/control.js';
import { ObservationStore } from '../observation/store.js';
import { FixtureReadService } from './fixture-read.js';
import { DurableActionLedger } from '../coordinator/action-ledger.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';

/** Host-supplied native seams. Production wires the real helper/controller; tests may inject owned fakes. */
export interface FixtureComputerUseBackends {
  observe(target: FixtureTarget, signal: AbortSignal): Promise<unknown>;
  act(target: FixtureTarget, element: FixtureElement, value: string | undefined, signal: AbortSignal): Promise<FixtureActResponse>;
  /** Per-OS-user controller slot. Must reject when revoked/busy. */
  beginControl(): Promise<{ signal: AbortSignal; end(): Promise<void> }>;
  /** Trusted host approval prompt. Return 'allowed-once' only on explicit user approval. */
  requestApproval(exec: HostCall, summary: ApprovalSummary): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
  /** Discover the currently running owned fixture. Never from model arguments. */
  fixtureTarget(windowKey: 'primary' | 'secondary', signal: AbortSignal): Promise<FixtureTarget>;
}
export interface ApprovalSummary { operation: 'press' | 'set_value'; identifier: string; inputLength: number; windowKey: string; riskReason: string }
export interface FixtureComputerUseOptions { ledgerDirectory: string; maxScopes?: number }

const observeRequestSchema = z.strictObject({ window: z.enum(['primary', 'secondary']).default('primary') });
const actRequestSchema = z.strictObject({ observationId: opaqueId, action: actionSchema });
const lowRiskPress = new Set(['fixture.submit', 'fixture.replace', 'fixture.reorder', 'fixture.delayed', 'fixture.reset']);


/**
 * Fixture-only end-to-end composition (CU-015). Order: exact host bind → read grant → observation → per-action
 * static lease/risk → approval (when required) → durable dispatch_pending → per-user controller slot →
 * helper final revalidation + single dispatch → conservative receipt → durable terminal. Never retries.
 */
export class FixtureComputerUse implements ScopeLifecycle {
  readonly #authority = new FixtureReadAuthority();
  readonly #observations = new ObservationStore();
  readonly #policy = new FixtureControlPolicy();
  readonly #reads: FixtureReadService;
  readonly #scopes: HostScopeRegistry;
  readonly #grants = new Map<string, { grantId: string; target: FixtureTarget }>();
  #ledger: Promise<DurableActionLedger> | undefined;
  #disposed = false;

  constructor(host: HostServices, private readonly backends: FixtureComputerUseBackends, private readonly options: FixtureComputerUseOptions) {
    this.#reads = new FixtureReadService({ authority: this.#authority, observations: this.#observations,
      observe: (target, signal) => backends.observe(target, signal) });
    this.#scopes = new HostScopeRegistry(host, {
      invalidate: (contexts) => {
        for (const context of contexts) { this.#observations.invalidate(context); this.#authority.revokeScopeFromHost(context); this.#policy.revokeScopeFromHost(context); }
        this.#grants.clear();
      },
      policyChanged: (contexts) => {
        for (const context of contexts) this.#observations.invalidate(context);
        this.#authority.policyChangedFromHost(); this.#policy.policyChangedFromHost(); this.#grants.clear();
      },
      dispose: () => { this.#disposed = true; this.#observations.dispose(); this.#authority.dispose(); this.#policy.dispose(); this.#grants.clear(); },
    }, 'CONTROL', options);
  }

  async observe(exec: HostCall, rawRequest: unknown): Promise<Observation> {
    const request = parseContract(observeRequestSchema, rawRequest ?? {});
    const call = snapshotHostCall(exec);
    const context = this.#scopes.bind(call);
    const target = await this.backends.fixtureTarget(request.window, context.signal);
    const key = this.#grantKey(context, request.window);
    let grant = this.#grants.get(key);
    if (grant && sameTarget(grant.target, target)) {
      // The authority revokes on TTL; a cached id that no longer reads must be replaced, not reused forever.
      try { this.#authority.requireRead(context, grant.grantId, target); } catch { this.#grants.delete(key); grant = undefined; }
    }
    if (!grant || !sameTarget(grant.target, target)) {
      if (grant) this.#authority.revokeFromHost(grant.grantId);
      // Static owned-fixture policy: the plugin is configured to read only its own test fixture.
      grant = { grantId: this.#authority.grantFromHost(context, target, { ttlMs: 600_000 }), target };
      this.#grants.set(key, grant);
    }
    return this.#reads.observe(() => this.#scopes.bind(call), grant.grantId, target);
  }

  async act(exec: HostCall, rawRequest: unknown): Promise<{ receipt: ActionReceipt; readback: 'match' | 'mismatch' | 'unavailable' | 'not_applicable' | 'none' }> {
    const request = parseContract(actRequestSchema, rawRequest);
    const call = snapshotHostCall(exec);
    const context = this.#scopes.bind(call);
    const actionId = `action_${randomUUID()}`;
    const notExecuted = (code: ActionReceipt['error'] extends infer E ? E extends { code: infer C } ? C : never : never,
      phase: 'validate' | 'authorize' | 'approve' | 'lock' | 'revalidate', retry: 'never' | 'observe_first' = 'never') => ({
      receipt: { actionId, execution: 'not_executed', target: phase === 'revalidate' ? 'invalid' : 'unknown', effect: 'unverified',
        taskOutcome: 'not_evaluated', evidence: [], error: { code, phase, retry } } as ActionReceipt, readback: 'none' as const });

    // 1. Resolve the private, observation-bound fixture element. Model handles never resolve without a live observation.
    let candidate;
    try { candidate = this.#observations.resolveFixtureFromHost(context, request.observationId, request.action.targetHandle, request.action.kind); }
    catch { return notExecuted('OBSERVATION_EXPIRED', 'validate', 'observe_first'); }
    const grant = this.#grants.get(this.#grantKey(context, candidate.target.windowKey));
    try { if (!grant || !sameTarget(grant.target, candidate.target)) throw new Error(); this.#authority.requireRead(context, grant.grantId, candidate.target); }
    catch { return notExecuted('READ_DENIED', 'authorize', 'observe_first'); }
    if (request.action.kind === 'set_value' && request.action.value.length > 1024) return notExecuted('INVALID_REQUEST', 'validate');

    // 2. Host-static lease for this exact element. Risk comes from host metadata, never from the model.
    const identifier = candidate.element.identifier;
    const impact = identifier === 'fixture.save' ? 'unknown' : 'ordinary';
    const lease = this.#policy.issueFromHost(context, {
      target: candidate.target, mode: 'background', ttlMs: 30_000, idleTimeoutMs: 30_000, maxActions: 1,
      allowedOperations: [request.action.kind],
      targets: [{ handle: request.action.targetHandle, identifier, role: request.action.kind === 'press' ? 'button' : 'text-field',
        enabled: true, secure: false, impact }],
    });
    try {
      const decision = this.#policy.evaluate(context, { leaseId: lease.taskLeaseId, target: candidate.target, action: request.action, approvalMode: 'request' });
      if (decision.decision === 'DENY') return notExecuted(decision.code === 'TARGET_CHANGED' ? 'TARGET_CHANGED' : 'CONTROL_DENIED', 'authorize');
      if (decision.decision === 'REQUIRE_APPROVAL') {
        const outcome = await this.backends.requestApproval(call, { operation: request.action.kind, identifier,
          inputLength: request.action.kind === 'set_value' ? request.action.value.length : 0, windowKey: candidate.target.windowKey, riskReason: decision.reason });
        if (outcome !== 'allowed-once') return notExecuted(outcome === 'unavailable' ? 'APPROVAL_UNAVAILABLE' : outcome === 'cancelled' ? 'CANCELLED' : 'APPROVAL_REQUIRED', 'approve');
      } else if (!(request.action.kind === 'set_value' ? identifier === 'fixture.text' : lowRiskPress.has(identifier))) {
        return notExecuted('CONTROL_DENIED', 'authorize');
      }
      this.#scopes.bind(call);
      this.#policy.chargeAttemptFromHost(context, lease.taskLeaseId);

      // 3. Per-user controller slot (single native mutation at a time, independent stop).
      let slot;
      try { slot = await this.backends.beginControl(); }
      catch (error) { return notExecuted(String((error as Error).message).startsWith('CONTROL_BUSY') ? 'CONTROL_BUSY' : 'CANCELLED', 'lock'); }
      try {
        const leaseSignal = this.#policy.signalForHost(context, lease.taskLeaseId);
        const signal = AbortSignal.any([context.signal, slot.signal, leaseSignal]);
        if (signal.aborted || this.#disposed) return notExecuted('CANCELLED', 'lock');
        this.#scopes.bind(call);
        // 4. Durable dispatch_pending before handoff. Ledger failure prevents dispatch.
        const ledger = await this.#ledgerFor();
        const proposal = { taskLeaseId: lease.taskLeaseId, observationId: request.observationId, target: candidate.target, action: request.action,
          mode: 'background' as const, policyVersion: lease.policyVersion, revocationVersion: lease.revocationVersion, materialContext: actionId.replace(/-/g, '_') };
        const prepared = await ledger.prepareFromHost(context, proposal);
        await ledger.beginDispatchFromHost(context, prepared.actionId, proposal);
        if (signal.aborted) {
          await ledger.finishFromHost(context, prepared.actionId, { execution: 'cancelled', effect: 'unknown', taskOutcome: 'not_evaluated' }).catch(() => {});
          return { receipt: { actionId, execution: 'cancelled', target: 'unknown', effect: 'unknown', taskOutcome: 'not_evaluated', evidence: [], error: { code: 'CANCELLED', phase: 'cancel', retry: 'never' } }, readback: 'none' };
        }
        // 5. Single dispatch. The helper performs the final exact revalidation itself; errors before input are not dispatched.
        let response: FixtureActResponse;
        try { response = await this.backends.act(candidate.target, candidate.element, request.action.kind === 'set_value' ? request.action.value : undefined, signal); }
        catch {
          await ledger.finishFromHost(context, prepared.actionId, { execution: 'unknown', effect: 'unknown', taskOutcome: 'not_evaluated' }).catch(() => {});
          return { receipt: { actionId, execution: 'unknown', target: 'unknown', effect: 'unknown', taskOutcome: 'not_evaluated', evidence: [],
            error: { code: 'EFFECT_UNKNOWN', phase: 'dispatch', retry: 'never' } }, readback: 'none' };
        }
        if (response.status === 'error') {
          // Helper refused before input; record as attempted-not-run terminal for idempotence.
          await ledger.finishFromHost(context, prepared.actionId, { execution: 'cancelled', effect: 'unknown', taskOutcome: 'not_evaluated' }).catch(() => {});
          const code = response.code === 'READ_DENIED' ? 'READ_DENIED' : response.code === 'TARGET_AMBIGUOUS' ? 'TARGET_AMBIGUOUS' :
            response.code === 'TARGET_CHANGED' ? 'TARGET_CHANGED' : 'CAPABILITY_UNAVAILABLE';
          return notExecuted(code, 'revalidate', code === 'TARGET_CHANGED' || code === 'TARGET_AMBIGUOUS' ? 'observe_first' : 'never');
        }
        const execution = response.execution;
        await ledger.finishFromHost(context, prepared.actionId, execution === 'unknown'
          ? { execution: 'unknown', effect: 'unknown', taskOutcome: 'not_evaluated' }
          : { execution: 'completed', effect: response.readback === 'mismatch' ? 'no_change_observed' : 'unverified', taskOutcome: 'not_evaluated' }).catch(() => {});
        // Field readback is reported separately; it is not promoted to verified evidence or business success.
        const receipt: ActionReceipt = execution === 'unknown'
          ? { actionId, execution: 'unknown', target: 'exact', effect: 'unknown', taskOutcome: 'not_evaluated', evidence: [], error: { code: 'EFFECT_UNKNOWN', phase: 'dispatch', retry: 'never' } }
          : { actionId, execution: 'completed', target: 'exact', effect: response.readback === 'mismatch' ? 'no_change_observed' : 'unverified', taskOutcome: 'not_evaluated', evidence: [] };
        return { receipt, readback: response.readback };
      } finally { await slot.end().catch(() => {}); }
    } finally { this.#policy.revokeFromHost(lease.taskLeaseId); }
  }

  agentDisposedFromHost(agent: Agent): void { this.#scopes.agentDisposedFromHost(agent); }
  sessionDisposedFromHost(session: Session): void { this.#scopes.sessionDisposedFromHost(session); }
  workspaceChangedFromHost(session: Session): void { this.#scopes.workspaceChangedFromHost(session); }
  policyChangedFromHost(): void { this.#scopes.policyChangedFromHost(); }
  dispose(): void {
    this.#scopes.dispose();
    void this.#ledger?.then((ledger) => ledger.close()).catch(() => {});
  }

  #grantKey(context: HostContext, window: string): string { return JSON.stringify([context.owner.agentId, context.owner.sessionId, context.workspace, window]); }
  #ledgerFor(): Promise<DurableActionLedger> {
    this.#ledger ??= DurableActionLedger.create({ directory: this.options.ledgerDirectory });
    return this.#ledger;
  }
}

function sameTarget(first: FixtureTarget, second: FixtureTarget): boolean {
  const a = parseContract(fixtureTargetSchema, first); const b = parseContract(fixtureTargetSchema, second);
  return a.pid === b.pid && a.processStart === b.processStart && a.windowKey === b.windowKey && a.windowId === b.windowId && a.windowInstance === b.windowInstance;
}
