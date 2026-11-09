import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { HostContext } from '../host-adapter/context.js';
import { snapshotHostScope, snapshotHostScopeForRevocation, sameHostScope, type HostScope } from '../host-adapter/scope.js';
import { parseFixtureTarget, type FixtureTarget } from '../contracts/fixture-observation.js';

interface ReadGrant {
  scope: HostScope;
  target: FixtureTarget;
  deadline: number;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
export interface FixtureReadPermit {
  kind: 'fixture_read_only';
  source: 'host-static-fixture';
  grantId: string;
  target: FixtureTarget;
  signal: AbortSignal;
  monotonicDeadline: number;
}
function deny(code = 'READ_DENIED'): Error {
  return new Error(`${code}: A current exact host fixture read grant is required.`);
}
function sameTarget(first: FixtureTarget, second: FixtureTarget): boolean {
  return first.pid === second.pid && first.processStart === second.processStart && first.windowKey === second.windowKey &&
    first.windowId === second.windowId && first.windowInstance === second.windowInstance;
}

/** Internal host registry. No model-facing method can create grants or expand their exact targets. */
export class FixtureReadAuthority {
  readonly #monotonicMs: () => number;
  readonly #maxGrants: number;
  readonly #grants = new Map<string, ReadGrant>();
  #lastNow = 0;
  #disposed = false;
  #policyEpoch = 0;

  constructor(options: { monotonicMs?: () => number; maxGrants?: number } = {}) {
    this.#monotonicMs = options.monotonicMs ?? (() => performance.now());
    this.#maxGrants = options.maxGrants ?? 64;
    if (!Number.isInteger(this.#maxGrants) || this.#maxGrants < 1 || this.#maxGrants > 256) throw deny('INVALID_REQUEST');
  }

  /** Only trusted host configuration may call this. This method does not obtain user consent or OS permissions. */
  grantFromHost(context: HostContext, rawTarget: unknown, options: { ttlMs: number }): string {
    const scope = snapshotHostScope(context);
    const target = parseFixtureTarget(rawTarget);
    if (!Number.isInteger(options.ttlMs) || options.ttlMs < 5000 || options.ttlMs > 600_000) throw deny('INVALID_REQUEST');
    const epoch = this.#policyEpoch;
    const now = this.#now();
    this.#prune(now);
    if (this.#disposed || epoch !== this.#policyEpoch || context.signal.aborted) throw deny();
    if (this.#grants.size >= this.#maxGrants) throw deny('READ_CAPACITY');
    const grantId = `read_grant_${randomUUID()}`;
    const abort = new AbortController();
    const timer = setTimeout(() => this.revokeFromHost(grantId), options.ttlMs);
    timer.unref();
    this.#grants.set(grantId, { scope, target, deadline: now + options.ttlMs, abort, timer });
    return grantId;
  }

  /** Check every read before dispatch and again before publishing its result. The permit never allows input. */
  requireRead(context: HostContext, grantId: string, rawTarget: unknown): FixtureReadPermit {
    const scope = snapshotHostScope(context);
    const target = parseFixtureTarget(rawTarget);
    const now = this.#now();
    this.#prune(now);
    const grant = this.#grants.get(grantId);
    if (!grant || !sameHostScope(scope, grant.scope) || !sameTarget(target, grant.target)) throw deny();
    return {
      kind: 'fixture_read_only', source: 'host-static-fixture', grantId,
      target: structuredClone(grant.target), signal: AbortSignal.any([context.signal, grant.abort.signal]), monotonicDeadline: grant.deadline,
    };
  }

  /** Revoke immediately and abort any read already holding this grant. Abort cannot undo data already read. */
  revokeFromHost(grantId: string): void {
    const grant = this.#grants.get(grantId);
    if (!grant) return;
    this.#grants.delete(grantId);
    clearTimeout(grant.timer);
    grant.abort.abort();
  }

  /** Authority-reducing lifecycle cleanup. Remove the entire scope before notifying any abort listener. */
  revokeScopeFromHost(context: HostContext): void {
    const scope = snapshotHostScopeForRevocation(context);
    this.#policyEpoch += 1;
    const previous: ReadGrant[] = [];
    for (const [id, grant] of this.#grants) {
      if (!sameHostScope(grant.scope, scope)) continue;
      this.#grants.delete(id);
      clearTimeout(grant.timer);
      previous.push(grant);
    }
    for (const grant of previous) grant.abort.abort();
  }

  /** A policy replacement does not grandfather pending or existing permits. New consent needs a fresh grant. */
  policyChangedFromHost(): void {
    this.#policyEpoch += 1;
    const previous = [...this.#grants.values()];
    this.#grants.clear();
    for (const grant of previous) clearTimeout(grant.timer);
    // Abort listeners run synchronously. Every old grant must be invalid before notifying any listener.
    for (const grant of previous) grant.abort.abort();
  }

  dispose(): void {
    this.#disposed = true;
    this.policyChangedFromHost();
  }

  #now(): number {
    if (this.#disposed) throw deny();
    let now: number;
    try { now = this.#monotonicMs(); }
    catch { this.policyChangedFromHost(); throw deny('CLOCK_UNAVAILABLE'); }
    if (!Number.isFinite(now) || now < this.#lastNow) {
      this.policyChangedFromHost();
      throw deny('CLOCK_UNAVAILABLE');
    }
    this.#lastNow = now;
    return now;
  }

  #prune(now: number): void {
    for (const [id, grant] of this.#grants) if (now >= grant.deadline) this.revokeFromHost(id);
  }
}
