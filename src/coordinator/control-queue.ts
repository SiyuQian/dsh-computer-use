import type { HostContext } from '../host-adapter/context.js';
import { snapshotHostScope, snapshotHostScopeForRevocation, sameHostScope, type HostScope } from '../host-adapter/scope.js';
import { parseFixtureTarget, type FixtureTarget } from '../contracts/fixture-observation.js';
import { opaqueId, parseContract } from '../contracts/shared.js';

/** Object-identity ticket. A target claim is not a policy lease or native dispatch permit. */
export interface TargetClaim { readonly kind: 'host_target_claim' }
export interface SchedulingPermit {
  readonly kind: 'host_scheduling_only';
  readonly dispatchable: false;
  readonly signal: AbortSignal;
}
export type WorkResult<T> =
  | { outcome: 'returned'; workStarted: true; value: T }
  | { outcome: 'cancelled'; workStarted: boolean }
  | { outcome: 'rejected'; workStarted: false; code: 'HOST_CONTEXT_CHANGED' }
  | { outcome: 'failed'; workStarted: true; code: 'CONTROL_WORK_FAILED' };
interface ClaimRecord {
  scope: HostScope;
  targetKey: string;
  revoked: boolean;
}
interface Job {
  context: HostContext;
  scope: HostScope;
  current: () => HostContext;
  claim: TargetClaim;
  work: (permit: SchedulingPermit) => unknown;
  resolve: (result: WorkResult<unknown>) => void;
  controller: AbortController;
  cancel: () => void;
  started: boolean;
  cancelled: boolean;
}
class QueueFailure extends Error {
  constructor(readonly code: string) { super(`${code}: Host control scheduling is unavailable.`); }
}
/** Classify only this module's fixed failures; never inspect arbitrary thrown messages or properties. */
export function isQueueCapacityFailure(error: unknown): boolean { return error instanceof QueueFailure && error.code === 'CONTROL_CAPACITY'; }
function failure(code: string): Error { return new QueueFailure(code); }
function targetKey(target: FixtureTarget): string {
  return JSON.stringify([target.pid, target.processStart, target.windowId]);
}

/** In-process FIFO and drain barrier only. No broker, input, approval, or action ledger is implied. */
export class HostControlQueue {
  readonly #maxPending: number;
  readonly #maxClaims: number;
  readonly #claims = new Map<TargetClaim, ClaimRecord>();
  readonly #pending: Job[] = [];
  readonly #drainWaiters = new Set<() => void>();
  #active: Job | undefined;
  #paused = false;
  #disposed = false;
  #pumping = false;
  #changing = 0;
  #epoch = 0;

  constructor(options: { maxPending?: number; maxClaims?: number } = {}) {
    this.#maxPending = options.maxPending ?? 64;
    this.#maxClaims = options.maxClaims ?? 64;
    for (const value of [this.#maxPending, this.#maxClaims]) {
      if (!Number.isInteger(value) || value < 1 || value > 256) throw failure('INVALID_REQUEST');
    }
  }

  claimTargetFromHost(context: HostContext, rawTarget: unknown): TargetClaim {
    this.#requireRunning();
    const epoch = this.#epoch;
    const scope = snapshotHostScope(context);
    const key = targetKey(parseFixtureTarget(rawTarget));
    this.#requireRunning();
    if (epoch !== this.#epoch || context.signal.aborted) throw failure('CONTROL_STOPPED');
    for (const record of this.#claims.values()) if (record.targetKey === key) throw failure('CONTROL_BUSY');
    if (this.#claims.size >= this.#maxClaims) throw failure('CONTROL_CAPACITY');
    const claim: TargetClaim = Object.freeze({ kind: 'host_target_claim' });
    this.#claims.set(claim, { scope, targetKey: key, revoked: false });
    return claim;
  }

  async enqueue<T>(current: () => HostContext, claim: TargetClaim, actionId: string, work: (permit: SchedulingPermit) => T | Promise<T>): Promise<WorkResult<T>> {
    this.#requireRunning();
    const epoch = this.#epoch;
    parseContract(opaqueId, actionId);
    const context = this.#current(current);
    this.#requireRunning();
    if (epoch !== this.#epoch) throw failure('CONTROL_CLAIM_INVALID');
    if (context.signal.aborted) return { outcome: 'cancelled', workStarted: false };
    const scope = snapshotHostScope(context);
    const record = this.#claims.get(claim);
    if (!record || record.revoked || !sameHostScope(record.scope, scope)) throw failure('CONTROL_CLAIM_INVALID');
    if (this.#pending.length >= this.#maxPending) throw failure('CONTROL_CAPACITY');
    return new Promise<WorkResult<T>>((resolve) => {
      const job: Job = {
        context, scope, current, claim, work,
        resolve: (result) => resolve(result as WorkResult<T>),
        controller: new AbortController(), cancel: () => this.#cancel(job), started: false, cancelled: false,
      };
      this.#pending.push(job);
      context.signal.addEventListener('abort', job.cancel, { once: true });
      if (context.signal.aborted) this.#cancel(job);
      this.#pump();
    });
  }

  releaseTargetFromHost(context: HostContext, claim: TargetClaim): void {
    const record = this.#claims.get(claim);
    if (!record || !sameHostScope(record.scope, snapshotHostScopeForRevocation(context))) throw failure('CONTROL_CLAIM_INVALID');
    record.revoked = true;
    for (const job of [...this.#pending]) if (job.claim === claim) this.#cancel(job);
    if (this.#active?.claim === claim) this.#cancel(this.#active);
    else this.#claims.delete(claim);
    this.#pump();
  }

  /** Batch scope cleanup: close admission, revoke all matching claims/queued jobs, then notify active work. */
  invalidateScopesFromHost(contexts: readonly HostContext[]): void {
    this.#epoch += 1; this.#changing += 1;
    try {
      const scopes = contexts.map(snapshotHostScopeForRevocation);
      this.#invalidate((record) => scopes.some((scope) => sameHostScope(scope, record.scope)));
    } finally { this.#changing -= 1; }
    this.#pump();
  }

  invalidateAllFromHost(): void { this.#invalidate(() => true); }

  #invalidate(matches: (record: ClaimRecord) => boolean): void {
    this.#epoch += 1; this.#changing += 1;
    try {
      const revoked = new Set<TargetClaim>();
      for (const [claim, record] of this.#claims) {
        if (!matches(record)) continue;
        record.revoked = true; revoked.add(claim);
        if (this.#active?.claim !== claim) this.#claims.delete(claim);
      }
      for (const job of [...this.#pending]) if (revoked.has(job.claim)) this.#cancel(job);
      if (this.#active && revoked.has(this.#active.claim)) this.#cancel(this.#active);
    } finally { this.#changing -= 1; }
    this.#pump(); this.#notifyDrained();
  }

  /** Independent host stop: block admission before invoking any synchronous abort listener. */
  stopFromHost(): void {
    this.#paused = true; this.#epoch += 1;
    this.#claims.clear();
    const pending = this.#pending.splice(0);
    for (const job of pending) {
      job.cancelled = true;
      this.#settle(job, { outcome: 'cancelled', workStarted: false });
    }
    if (this.#active) this.#cancel(this.#active);
    this.#notifyDrained();
  }

  resumeFromHost(): void {
    if (this.#disposed || this.#changing > 0) throw failure('CONTROL_STOPPED');
    if (this.#active) throw failure('CONTROL_BUSY');
    this.#paused = false;
  }

  statusFromHost(): { state: 'idle' | 'running' | 'stopping' | 'paused' | 'disposed'; pendingCount: number; claimedTargets: number } {
    return {
      state: this.#disposed ? 'disposed' : this.#paused ? (this.#active ? 'stopping' : 'paused') : this.#active ? 'running' : 'idle',
      pendingCount: this.#pending.length, claimedTargets: this.#claims.size,
    };
  }

  waitForDrain(signal?: AbortSignal): Promise<boolean> {
    if (!this.#active && this.#pending.length === 0) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    if (this.#drainWaiters.size >= 256) return Promise.reject(failure('CONTROL_CAPACITY'));
    return new Promise((resolve) => {
      const cancel = () => { cleanup(); resolve(false); };
      const done = () => { cleanup(); resolve(true); };
      const cleanup = () => { this.#drainWaiters.delete(done); signal?.removeEventListener('abort', cancel); };
      this.#drainWaiters.add(done);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  dispose(): void { this.#disposed = true; this.stopFromHost(); }

  #requireRunning(): void { if (this.#paused || this.#disposed || this.#changing > 0) throw failure('CONTROL_STOPPED'); }
  #current(current: () => HostContext): HostContext {
    try { return current(); } catch { throw failure('CONTROL_CLAIM_INVALID'); }
  }

  #cancel(job: Job): void {
    if (job.cancelled) return;
    job.cancelled = true;
    if (job.started) { job.controller.abort(); return; }
    const index = this.#pending.indexOf(job);
    if (index !== -1) this.#pending.splice(index, 1);
    this.#settle(job, { outcome: 'cancelled', workStarted: false });
    this.#notifyDrained();
  }

  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (!this.#active && !this.#paused && !this.#disposed && this.#changing === 0 && this.#pending.length > 0) {
        const job = this.#pending[0]!;
        const claim = this.#claims.get(job.claim);
        try {
          const context = this.#current(job.current);
          if (job.cancelled || this.#paused || this.#disposed || this.#claims.get(job.claim) !== claim) continue;
          this.#pending.shift();
          if (context.signal.aborted || job.context.signal.aborted) {
            this.#settle(job, { outcome: 'cancelled', workStarted: false }); continue;
          }
          if (!claim || claim.revoked || !sameHostScope(job.scope, snapshotHostScope(context)) || context.turn !== job.context.turn ||
              context.callId !== job.context.callId || context.signal !== job.context.signal) {
            this.#settle(job, { outcome: 'rejected', workStarted: false, code: 'HOST_CONTEXT_CHANGED' }); continue;
          }
        } catch {
          if (this.#pending[0] === job) this.#pending.shift();
          if (!job.cancelled) this.#settle(job, { outcome: 'rejected', workStarted: false, code: 'HOST_CONTEXT_CHANGED' });
          continue;
        }
        job.started = true;
        this.#active = job;
        let returned: unknown;
        try { returned = job.work(Object.freeze({ kind: 'host_scheduling_only', dispatchable: false, signal: job.controller.signal })); }
        catch { this.#finish(job, { outcome: 'failed', workStarted: true, code: 'CONTROL_WORK_FAILED' }); continue; }
        Promise.resolve(returned).then(
          (value) => this.#finish(job, { outcome: 'returned', workStarted: true, value }),
          () => this.#finish(job, { outcome: 'failed', workStarted: true, code: 'CONTROL_WORK_FAILED' }),
        );
      }
    } finally { this.#pumping = false; }
    this.#notifyDrained();
  }

  #finish(job: Job, result: WorkResult<unknown>): void {
    if (this.#active !== job) return;
    this.#active = undefined;
    if (this.#claims.get(job.claim)?.revoked) this.#claims.delete(job.claim);
    this.#settle(job, job.cancelled ? { outcome: 'cancelled', workStarted: true } : result);
    this.#pump();
  }

  #settle(job: Job, result: WorkResult<unknown>): void {
    job.context.signal.removeEventListener('abort', job.cancel);
    job.resolve(result);
  }

  #notifyDrained(): void {
    if (this.#active || this.#pending.length > 0) return;
    for (const done of [...this.#drainWaiters]) done();
  }
}
