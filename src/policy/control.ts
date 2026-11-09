import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { snapshotHostScope, snapshotHostScopeForRevocation, sameHostScope, type HostScope } from '../host-adapter/scope.js';
import { actionSchema, parseTaskLease, type TaskLease } from '../contracts/actions.js';
import { fixtureTargetSchema, type FixtureTarget } from '../contracts/fixture-observation.js';
import { opaqueId, parseContract } from '../contracts/shared.js';

const targetDescriptorSchema = z.strictObject({
  handle: opaqueId,
  identifier: z.string().max(128),
  role: z.enum(['button', 'text-field', 'static-text', 'group', 'other']),
  enabled: z.boolean(), secure: z.boolean(),
  impact: z.enum(['ordinary', 'unknown', 'high-impact', 'system-authorization']),
});
const leaseSpecSchema = z.strictObject({
  target: fixtureTargetSchema, mode: z.literal('background'),
  ttlMs: z.number().int().min(5000).max(600_000),
  idleTimeoutMs: z.number().int().positive().max(600_000),
  maxActions: z.number().int().min(1).max(100),
  allowedOperations: z.array(z.enum(['press', 'set_value'])).min(1).max(2).refine((ops) => new Set(ops).size === ops.length),
  targets: z.array(targetDescriptorSchema).min(1).max(64).refine((targets) => new Set(targets.map((target) => target.handle)).size === targets.length),
});
const evaluationSchema = z.strictObject({
  leaseId: opaqueId, target: fixtureTargetSchema, action: actionSchema,
  approvalMode: z.enum(['request', 'never']), raiseRisk: z.boolean().default(false),
});
/** Closed inert evaluation DTO; caller accessors must not escape source errors. */
export function parseControlEvaluation(value: unknown) {
  try { return parseContract(evaluationSchema, value); }
  catch { throw new Error('INVALID_REQUEST: A closed fixture policy request is required.'); }
}
/** Host-static lease metadata only; parsing never grants authority. */
export function parseControlLeaseSpec(value: unknown) {
  try { return parseContract(leaseSpecSchema, value); }
  catch { throw new Error('INVALID_REQUEST: A closed fixture lease specification is required.'); }
}

interface Record {
  scope: HostScope;
  lease: TaskLease;
  spec: z.infer<typeof leaseSpecSchema>;
  absoluteDeadline: number;
  lastAttemptAt: number;
  attempts: number;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
type Code = 'CONTROL_DENIED' | 'LEASE_EXPIRED' | 'CLOCK_UNAVAILABLE';
class ControlPolicyError extends Error {
  constructor(readonly code: Code) { super(`${code}: A current exact fixture control lease is required.`); }
}
export interface ControlDecision {
  decision: 'DENY' | 'REQUIRE_APPROVAL' | 'ALLOW_WITHIN_LEASE';
  code?: Code | 'TARGET_CHANGED' | 'APPROVAL_REQUIRED' | 'APPROVAL_UNAVAILABLE';
  reason: 'within_fixture' | 'not_authorized' | 'target_changed' | 'action_limit' | 'target_unavailable' | 'high_impact' | 'unclassified_effect' | 'raised_risk';
  dispatchable: false;
  requiresNativeRevalidation: true;
}
function decision(value: ControlDecision['decision'], reason: ControlDecision['reason'], code?: ControlDecision['code']): ControlDecision {
  return { decision: value, reason, dispatchable: false, requiresNativeRevalidation: true, ...(code ? { code } : {}) };
}
function sameTarget(first: FixtureTarget, second: FixtureTarget): boolean {
  return first.pid === second.pid && first.processStart === second.processStart && first.windowKey === second.windowKey &&
    first.windowId === second.windowId && first.windowInstance === second.windowInstance;
}

/** Host-only, inert policy kernel. Issuing or evaluating a lease never obtains consent or dispatches native work. */
export class FixtureControlPolicy {
  readonly #clock: () => number;
  readonly #wallClock: () => number;
  readonly #maxLeases: number;
  readonly #records = new Map<string, Record>();
  #lastNow = 0;
  #disposed = false;
  #policyVersion = `policy_${randomUUID()}`;
  #revocationVersion = 0;

  constructor(options: { monotonicMs?: () => number; wallTimeMs?: () => number; maxLeases?: number } = {}) {
    this.#clock = options.monotonicMs ?? (() => performance.now());
    this.#wallClock = options.wallTimeMs ?? (() => Date.now());
    this.#maxLeases = options.maxLeases ?? 64;
    if (!Number.isInteger(this.#maxLeases) || this.#maxLeases < 1 || this.#maxLeases > 256) throw new Error('INVALID_REQUEST: A bounded lease capacity is required.');
  }

  /** Trusted host static fixture configuration only. No model-facing caller may mint leases. */
  issueFromHost(context: HostContext, rawSpec: unknown): TaskLease {
    const scope = snapshotHostScope(context);
    const spec = parseControlLeaseSpec(rawSpec);
    const epoch = this.#revocationVersion;
    const now = this.#now();
    this.#prune(now);
    if (this.#disposed || epoch !== this.#revocationVersion) throw new ControlPolicyError('CONTROL_DENIED');
    if (this.#records.size >= this.#maxLeases) throw new Error('CONTROL_CAPACITY: No fixture lease capacity is available.');
    let wall: number;
    try { wall = this.#wallClock(); }
    catch { throw new ControlPolicyError('CLOCK_UNAVAILABLE'); }
    if (!Number.isFinite(wall) || !Number.isFinite(new Date(wall + spec.ttlMs).getTime())) throw new ControlPolicyError('CLOCK_UNAVAILABLE');
    const lease = parseTaskLease({
      taskLeaseId: `lease_${randomUUID()}`, owner: context.owner,
      app: { bundleId: 'dev.siyuqian.computer-use.fixture', pid: spec.target.pid, processStart: spec.target.processStart },
      window: { id: spec.target.windowId, instance: spec.target.windowInstance }, mode: spec.mode,
      allowedOperations: spec.allowedOperations, allowedTargetHandles: spec.targets.map((target) => target.handle),
      issuedAt: new Date(wall).toISOString(), expiresAt: new Date(wall + spec.ttlMs).toISOString(),
      idleTimeoutMs: spec.idleTimeoutMs, maxActions: spec.maxActions, policyVersion: this.#policyVersion,
      revocationVersion: this.#revocationVersion, authorization: 'static-fixture-policy',
    });
    if (this.#disposed || epoch !== this.#revocationVersion || context.signal.aborted) throw new ControlPolicyError('CONTROL_DENIED');
    const timer = setTimeout(() => this.revokeFromHost(lease.taskLeaseId), Math.min(spec.ttlMs, spec.idleTimeoutMs));
    timer.unref();
    this.#records.set(lease.taskLeaseId, {
      scope, lease, spec, absoluteDeadline: now + spec.ttlMs, lastAttemptAt: now, attempts: 0, abort: new AbortController(), timer,
    });
    return structuredClone(lease);
  }

  /** Produce an inert risk decision from host-retained target metadata, not model risk labels. */
  evaluate(context: HostContext, input: unknown): ControlDecision {
    const request = parseControlEvaluation(input);
    let record: Record;
    try { record = this.#record(context, request.leaseId); }
    catch (error) {
      if (error instanceof ControlPolicyError) return decision('DENY', 'not_authorized', error.code);
      throw error;
    }
    if (!sameTarget(record.spec.target, request.target)) return decision('DENY', 'target_changed', 'TARGET_CHANGED');
    if (record.attempts >= record.lease.maxActions) return decision('DENY', 'action_limit', 'CONTROL_DENIED');
    const target = record.spec.targets.find((target) => target.handle === request.action.targetHandle);
    if (!target || !record.lease.allowedOperations.includes(request.action.kind) || target.secure || target.identifier === 'fixture.secure' || !target.enabled ||
        (request.action.kind === 'press' ? target.role !== 'button' : target.role !== 'text-field')) {
      return decision('DENY', 'target_unavailable', 'CONTROL_DENIED');
    }
    if (target.impact === 'high-impact' || target.impact === 'system-authorization') return decision('DENY', 'high_impact', 'CONTROL_DENIED');
    const lowRisk = target.impact === 'ordinary' && (request.action.kind === 'set_value'
      ? target.identifier === 'fixture.text'
      : ['fixture.submit', 'fixture.replace', 'fixture.reorder', 'fixture.delayed', 'fixture.reset'].includes(target.identifier));
    if (!lowRisk || request.raiseRisk) {
      const reason = request.raiseRisk && lowRisk ? 'raised_risk' : 'unclassified_effect';
      return request.approvalMode === 'never'
        ? decision('DENY', reason, 'APPROVAL_UNAVAILABLE')
        : decision('REQUIRE_APPROVAL', reason, 'APPROVAL_REQUIRED');
    }
    return decision('ALLOW_WITHIN_LEASE', 'within_fixture');
  }

  getForHost(context: HostContext, leaseId: string): TaskLease {
    return structuredClone(this.#record(context, leaseId).lease);
  }

  /** Private exact lease target for host claim admission, not a native identity witness. */
  fixtureTargetFromHost(context: HostContext, leaseId: string): FixtureTarget {
    return structuredClone(this.#record(context, leaseId).spec.target);
  }

  signalForHost(context: HostContext, leaseId: string): AbortSignal {
    return this.#record(context, leaseId).abort.signal;
  }

  /** Synchronous host budget accounting only; not an input permit or a replacement for actionId deduplication. */
  chargeAttemptFromHost(context: HostContext, leaseId: string): void {
    const record = this.#record(context, leaseId);
    if (record.attempts >= record.lease.maxActions) throw new ControlPolicyError('CONTROL_DENIED');
    record.attempts += 1;
    record.lastAttemptAt = this.#lastNow;
    clearTimeout(record.timer);
    record.timer = setTimeout(() => this.revokeFromHost(leaseId), Math.min(
      record.absoluteDeadline - record.lastAttemptAt, record.lease.idleTimeoutMs,
    ));
    record.timer.unref();
  }

  revokeFromHost(leaseId: string): void {
    const record = this.#records.get(leaseId);
    if (!record) return;
    this.#records.delete(leaseId);
    clearTimeout(record.timer);
    record.abort.abort();
  }

  /** Delete every lease in one exact scope before any synchronous abort notification; cancellation cannot block cleanup. */
  revokeScopeFromHost(context: HostContext): void {
    const scope = snapshotHostScopeForRevocation(context);
    this.#revocationVersion += 1;
    const removed: Record[] = [];
    for (const [id, record] of this.#records) {
      if (!sameHostScope(scope, record.scope)) continue;
      this.#records.delete(id); clearTimeout(record.timer); removed.push(record);
    }
    for (const record of removed) record.abort.abort();
  }

  policyChangedFromHost(): void {
    this.#policyVersion = `policy_${randomUUID()}`;
    this.#revocationVersion += 1;
    const records = [...this.#records.values()];
    this.#records.clear();
    for (const record of records) clearTimeout(record.timer);
    for (const record of records) record.abort.abort();
  }

  dispose(): void { this.#disposed = true; this.policyChangedFromHost(); }

  #record(context: HostContext, leaseId: string): Record {
    const scope = snapshotHostScope(context);
    const now = this.#now();
    const record = this.#records.get(leaseId);
    if (!record || !sameHostScope(record.scope, scope)) throw new ControlPolicyError('CONTROL_DENIED');
    if (now >= record.absoluteDeadline || now >= record.lastAttemptAt + record.lease.idleTimeoutMs) {
      this.revokeFromHost(leaseId);
      throw new ControlPolicyError('LEASE_EXPIRED');
    }
    return record;
  }

  #now(): number {
    if (this.#disposed) throw new ControlPolicyError('CONTROL_DENIED');
    let now: number;
    try { now = this.#clock(); }
    catch { this.policyChangedFromHost(); throw new ControlPolicyError('CLOCK_UNAVAILABLE'); }
    if (!Number.isFinite(now) || now < this.#lastNow) {
      this.policyChangedFromHost();
      throw new ControlPolicyError('CLOCK_UNAVAILABLE');
    }
    this.#lastNow = now;
    return now;
  }

  #prune(now: number): void {
    for (const [id, record] of this.#records) {
      if (now >= record.absoluteDeadline || now >= record.lastAttemptAt + record.lease.idleTimeoutMs) this.revokeFromHost(id);
    }
  }
}
