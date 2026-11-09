import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { HostContext } from '../host-adapter/context.js';
import type { Observation } from '../contracts/observation.js';
import { snapshotHostScope as scopeOf, sameHostScope as sameScope, type HostScope as Scope } from '../host-adapter/scope.js';
import { projectFixtureObservationForHost, type FixtureBinding } from './project.js';
import { fixtureElementSchema, parseFixtureTarget, type FixtureTarget } from '../contracts/fixture-observation.js';
import { opaqueId, parseContract } from '../contracts/shared.js';

interface Clock {
  monotonicMs(): number;
  wallTimeMs(): number;
}
interface PendingRead {
  scope: Scope;
  startedAt: number;
  wallStartedAt: number;
  signal: AbortSignal;
  committing?: boolean;
}
interface StoredObservation {
  scope: Scope;
  deadline: number;
  observation: Observation;
  fixtureCandidates: Map<string, FixtureBinding>;
  target: FixtureTarget;
}
export interface FixtureTargetCandidate extends FixtureBinding {
  status: 'candidate';
  dispatchable: false;
  requiresNativeRevalidation: true;
  observationId: string;
  handle: string;
}
export interface TargetCandidate {
  status: 'candidate';
  requiresNativeRevalidation: true;
  observationId: string;
  app: Observation['app'];
  window: Observation['window'];
  element: Observation['elements'][number];
}
function fail(code: string): Error {
  return new Error(`${code}: A current host-owned observation is required. No native action was dispatched.`);
}

/** In-memory fixture observation lifetime. Candidates are inert and never authorize or dispatch native work. */
export class ObservationStore {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #pending = new Map<object, PendingRead>();
  readonly #records = new Map<string, StoredObservation>();
  #lastMonotonic = 0;
  #disposed = false;

  constructor(options: { clock?: Clock; ttlMs?: number; maxEntries?: number } = {}) {
    this.#clock = options.clock ?? { monotonicMs: () => performance.now(), wallTimeMs: () => Date.now() };
    this.#ttlMs = options.ttlMs ?? 15_000;
    this.#maxEntries = options.maxEntries ?? 64;
    if (!Number.isInteger(this.#ttlMs) || this.#ttlMs < 5000 || this.#ttlMs > 60_000 ||
        !Number.isInteger(this.#maxEntries) || this.#maxEntries < 1 || this.#maxEntries > 256) throw fail('INVALID_REQUEST');
  }

  /** Start age before backend work. Only this exact ticket object can commit once. */
  begin(context: HostContext): object {
    const scope = scopeOf(context);
    const startedAt = this.#now();
    this.#prune(startedAt);
    if (this.#pending.size + this.#records.size >= this.#maxEntries) throw fail('OBSERVATION_CAPACITY');
    const wallStartedAt = this.#wallNow();
    const ticket = Object.freeze({});
    this.#pending.set(ticket, { scope, startedAt, wallStartedAt, signal: context.signal });
    return ticket;
  }

  /** Consume a host read ticket and project an exact fixture snapshot; no raw tree is retained. */
  commit(context: HostContext, ticket: object, snapshot: unknown, target: unknown, beforePublish: () => void = () => {}): Observation {
    const scope = scopeOf(context);
    const now = this.#now();
    this.#prune(now);
    const pending = this.#pending.get(ticket);
    if (!pending || pending.committing || !sameScope(pending.scope, scope)) throw fail('OBSERVATION_EXPIRED');
    pending.committing = true;
    try {
      if (pending.signal.aborted) throw fail('CANCELLED');
      const validatedTarget = parseFixtureTarget(target);
      const { observation, fixtureCandidates } = projectFixtureObservationForHost(snapshot, validatedTarget, {
        observationId: `observation_${randomUUID()}`,
        generation: scope.generation,
        observedAt: new Date(pending.wallStartedAt).toISOString(),
        ttlMs: this.#ttlMs,
      });
      const deadline = pending.startedAt + this.#ttlMs;
      if (this.#now() >= deadline) throw fail('OBSERVATION_EXPIRED');
      if (context.signal.aborted || pending.signal.aborted) throw fail('CANCELLED');
      beforePublish();
      if (this.#now() >= deadline || this.#pending.get(ticket) !== pending) throw fail('OBSERVATION_EXPIRED');
      if (!sameScope(scope, scopeOf(context))) throw fail('OBSERVATION_EXPIRED');
      if (context.signal.aborted || pending.signal.aborted) throw fail('CANCELLED');
      if (this.#disposed || this.#pending.get(ticket) !== pending) throw fail('OBSERVATION_EXPIRED');
      this.#records.set(observation.observationId, { scope, deadline, observation, fixtureCandidates, target: validatedTarget });
      return structuredClone(observation);
    } finally { this.#pending.delete(ticket); }
  }

  /** Release a failed or cancelled backend read without clearing unrelated records. */
  discard(context: HostContext, ticket: object): void {
    const scope: Scope = { ...context.owner, workspace: context.workspace, lifetime: context.lifetime };
    const pending = this.#pending.get(ticket);
    if (pending && sameScope(pending.scope, scope)) this.#pending.delete(ticket);
  }

  /** Return an isolated public copy only in the same live owner/generation/workspace scope. */
  get(context: HostContext, observationId: string): Observation {
    const scope = scopeOf(context);
    const now = this.#now();
    this.#prune(now);
    const record = this.#records.get(observationId);
    if (!record || !sameScope(record.scope, scope)) throw fail('OBSERVATION_EXPIRED');
    return structuredClone(record.observation);
  }

  /** Private read authorization target, not an input permit. Exists even when the observation has no actionable elements. */
  fixtureTargetFromHost(context: HostContext, observationId: string): FixtureTarget {
    parseContract(opaqueId, observationId);
    const scope = scopeOf(context);
    const now = this.#now(); this.#prune(now);
    const record = this.#records.get(observationId);
    if (!record || !sameScope(scope, record.scope)) throw fail('OBSERVATION_EXPIRED');
    return structuredClone(record.target);
  }

  /** Resolve stored membership, not current native identity. A separate native revalidation is mandatory. */
  resolve(context: HostContext, observationId: string, handle: string): TargetCandidate {
    const observation = this.get(context, observationId);
    const element = observation.elements.find((candidate) => candidate.handle === handle);
    if (!element) throw fail('TARGET_CHANGED');
    if (element.secure || !element.enabled || element.actions.length === 0) throw fail('CAPABILITY_UNAVAILABLE');
    return {
      status: 'candidate', requiresNativeRevalidation: true, observationId,
      app: observation.app, window: observation.window, element,
    };
  }

  /** Internal host-only witness lookup. A candidate only allows a separately authorized read-only revalidation. */
  resolveFixtureFromHost(context: HostContext, observationId: string, handle: string, rawOperation: unknown): FixtureTargetCandidate {
    parseContract(opaqueId, observationId);
    parseContract(opaqueId, handle);
    const operation = parseContract(fixtureElementSchema.shape.operation, rawOperation);
    const candidate = this.resolve(context, observationId, handle);
    const binding = this.#records.get(observationId)?.fixtureCandidates.get(handle);
    if (!binding || binding.element.operation !== operation || !candidate.element.actions.includes(operation)) throw fail('CAPABILITY_UNAVAILABLE');
    return { status: 'candidate', dispatchable: false, requiresNativeRevalidation: true, observationId, handle, ...structuredClone(binding) };
  }

  /** Private membership source with the original mono deadline; no new observation lifetime or input permission is created. */
  actionIntentSourceFromHost(context: HostContext, observationId: string, handle: string, operation: unknown) {
    const candidate = this.resolveFixtureFromHost(context, observationId, handle, operation);
    const record = this.#records.get(observationId);
    if (!record || !sameScope(record.scope, scopeOf(context))) throw fail('OBSERVATION_EXPIRED');
    return { candidate, structureRevision: record.observation.structureRevision, monotonicDeadline: record.deadline };
  }

  /** Clear one host scope on Session end, generation retirement, read revocation, or workspace change. */
  invalidate(context: HostContext): void {
    const scope: Scope = { ...context.owner, workspace: context.workspace, lifetime: context.lifetime };
    for (const [ticket, pending] of this.#pending) if (sameScope(pending.scope, scope)) this.#pending.delete(ticket);
    for (const [id, record] of this.#records) if (sameScope(record.scope, scope)) this.#records.delete(id);
  }

  /** Plugin disposal must discard all observations and pending reads. Nothing is persisted or restored. */
  dispose(): void {
    this.#disposed = true;
    this.#pending.clear();
    this.#records.clear();
  }

  #now(): number {
    if (this.#disposed) throw fail('OBSERVATION_EXPIRED');
    let now: number;
    try { now = this.#clock.monotonicMs(); }
    catch { return this.#clockUnavailable(); }
    if (!Number.isFinite(now) || now < this.#lastMonotonic) return this.#clockUnavailable();
    this.#lastMonotonic = now;
    return now;
  }

  #wallNow(): number {
    let now: number;
    try { now = this.#clock.wallTimeMs(); }
    catch { return this.#clockUnavailable(); }
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return this.#clockUnavailable();
    return now;
  }

  #clockUnavailable(): never {
    this.#pending.clear();
    this.#records.clear();
    throw fail('CLOCK_UNAVAILABLE');
  }

  #prune(now: number): void {
    for (const [ticket, pending] of this.#pending) {
      if (now >= pending.startedAt + this.#ttlMs || pending.signal.aborted) this.#pending.delete(ticket);
    }
    for (const [id, record] of this.#records) if (now >= record.deadline) this.#records.delete(id);
  }
}
