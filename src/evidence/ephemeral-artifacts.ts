import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isArrayBuffer, isPromise, isUint8Array } from 'node:util/types';
import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { sameHostScope, snapshotHostScope, snapshotHostScopeForRevocation, type HostScope } from '../host-adapter/scope.js';
import { opaqueId } from '../contracts/shared.js';

const specSchema = z.strictObject({ observationId: opaqueId, mediaType: z.literal('image/png'), maxBytes: z.number().int().min(1).max(1_048_576) });
type Spec = z.infer<typeof specSchema>;
export interface EphemeralArtifactDescriptor {
  artifactId: string;
  observationId: string;
  mediaType: 'image/png';
  byteLength: number;
  digest: string;
}
interface AuthorizationMetadata {
  readonly operation: 'stage' | 'publish' | 'read';
  readonly observationId: string;
  readonly mediaType: 'image/png';
}
export type ArtifactAuthorizer = (metadata: Readonly<AuthorizationMetadata>) => unknown;
interface Pending {
  scope: HostScope;
  signal: AbortSignal;
  spec: Spec;
  deadline: number;
  committing: boolean;
  timer: ReturnType<typeof setTimeout>;
}
interface Stored {
  scope: HostScope;
  deadline: number;
  descriptor: EphemeralArtifactDescriptor;
  bytes: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
}
class EphemeralArtifactError extends Error {
  constructor(code: string) { super(`${code}: A current host-authorized ephemeral artifact is required.`); }
}
function fail(code = 'ARTIFACT_UNAVAILABLE'): EphemeralArtifactError { return new EphemeralArtifactError(code); }
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsicLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const intrinsicResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')!.get!;
const intrinsicSet = Uint8Array.prototype.set;
const intrinsicFill = Uint8Array.prototype.fill;
const intrinsicThen = Promise.prototype.then;

/** Copy fixed, non-shared byte storage using intrinsic slots, never caller-defined getters or methods. */
function copyPayload(value: unknown, limit: number): Uint8Array {
  let copy: Uint8Array | undefined;
  try {
    if (!isUint8Array(value)) throw fail('ARTIFACT_INVALID');
    const length = intrinsicLength.call(value) as number;
    const backing: unknown = intrinsicBuffer.call(value);
    if (length < 1 || length > limit || !isArrayBuffer(backing) || intrinsicResizable.call(backing)) throw fail('ARTIFACT_INVALID');
    copy = new Uint8Array(length);
    intrinsicSet.call(copy, value);
    return copy;
  } catch {
    if (copy) intrinsicFill.call(copy, 0);
    throw fail('ARTIFACT_INVALID');
  }
}

/** Internal memory staging only. This neither captures images nor authenticates evidence, consent or PNG contents. */
export class EphemeralArtifactStore {
  readonly #enabled: boolean;
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxTotalBytes: number;
  readonly #pending = new Map<object, Pending>();
  readonly #records = new Map<string, Stored>();
  #lastNow = 0;
  #epoch = 0;
  #closed = false;
  #busy = false;

  constructor(options: { enabledFromHost?: boolean; monotonicMs?: () => number; ttlMs?: number; maxEntries?: number; maxTotalBytes?: number } = {}) {
    this.#enabled = options.enabledFromHost === true;
    this.#clock = options.monotonicMs ?? (() => performance.now());
    this.#ttlMs = options.ttlMs ?? 900_000;
    this.#maxEntries = options.maxEntries ?? 16;
    this.#maxTotalBytes = options.maxTotalBytes ?? 8_388_608;
    if (!Number.isInteger(this.#ttlMs) || this.#ttlMs < 1000 || this.#ttlMs > 900_000 ||
        !Number.isInteger(this.#maxEntries) || this.#maxEntries < 1 || this.#maxEntries > 64 ||
        !Number.isInteger(this.#maxTotalBytes) || this.#maxTotalBytes < 1 || this.#maxTotalBytes > 16_777_216) throw fail('INVALID_REQUEST');
  }

  /** Reserve entry and maximum payload capacity before any asynchronous capture would start. No capture is performed. */
  beginFromHost(context: HostContext, rawSpec: unknown, authorize?: ArtifactAuthorizer): object {
    return this.#operation(() => {
      const epoch = this.#epoch;
      const scope = snapshotHostScope(context);
      const originalSignal = context.signal;
      let spec: Spec;
      try { spec = specSchema.parse(rawSpec); } catch { throw fail('INVALID_REQUEST'); }
      const now = this.#now(); this.#prune(now);
      this.#authorize('stage', spec, authorize);
      this.#fresh(context, scope, originalSignal, now + this.#ttlMs, epoch);
      this.#capacity(spec.maxBytes);
      const ticket = Object.freeze({});
      const timer = setTimeout(() => this.#dropPending(ticket), Math.max(1, now + this.#ttlMs - this.#lastNow));
      timer.unref();
      this.#pending.set(ticket, { scope, spec, signal: originalSignal, deadline: now + this.#ttlMs, committing: false, timer });
      return ticket;
    });
  }

  /** Consume the exact ticket once. Failed publication never returns it to pending or retains caller bytes. */
  commitFromHost(context: HostContext, ticket: object, value: unknown, authorize?: ArtifactAuthorizer): EphemeralArtifactDescriptor {
    return this.#operation(() => {
      const pending = this.#pending.get(ticket);
      if (!pending || pending.committing) throw fail();
      pending.committing = true;
      let owned: Uint8Array | undefined;
      let stored = false;
      try {
        const epoch = this.#epoch;
        this.#fresh(context, pending.scope, pending.signal, pending.deadline, epoch);
        owned = copyPayload(value, pending.spec.maxBytes);
        this.#authorize('publish', pending.spec, authorize);
        const descriptor: EphemeralArtifactDescriptor = {
          artifactId: `artifact_${randomUUID()}`, observationId: pending.spec.observationId, mediaType: pending.spec.mediaType,
          byteLength: owned.byteLength, digest: createHash('sha256').update(owned).digest('hex'),
        };
        this.#fresh(context, pending.scope, pending.signal, pending.deadline, epoch);
        if (this.#pending.get(ticket) !== pending) throw fail();
        clearTimeout(pending.timer);
        const timer = setTimeout(() => {
          const record = this.#records.get(descriptor.artifactId);
          if (record) this.#erase(descriptor.artifactId, record);
        }, Math.max(1, pending.deadline - this.#lastNow));
        timer.unref();
        this.#records.set(descriptor.artifactId, { scope: pending.scope, deadline: pending.deadline, descriptor, bytes: owned, timer });
        stored = true;
        return { ...descriptor };
      } finally {
        this.#dropPending(ticket);
        if (owned && !stored) intrinsicFill.call(owned, 0);
      }
    });
  }

  /** Require current authorization on every access, then return a separate copy. An opaque ID is never permission. */
  readFromHost(context: HostContext, artifactId: string, authorize?: ArtifactAuthorizer): { descriptor: EphemeralArtifactDescriptor; bytes: Uint8Array } {
    return this.#operation(() => {
      const epoch = this.#epoch;
      const scope = snapshotHostScope(context);
      const signal = context.signal;
      const now = this.#now(); this.#prune(now);
      const record = this.#records.get(artifactId);
      if (!record || !sameHostScope(record.scope, scope)) throw fail();
      this.#authorize('read', record.descriptor, authorize);
      this.#fresh(context, record.scope, signal, record.deadline, epoch);
      if (this.#records.get(artifactId) !== record) throw fail();
      return { descriptor: { ...record.descriptor }, bytes: copyPayload(record.bytes, 1_048_576) };
    });
  }

  /** Authority-reducing cleanup; cancellation does not prevent release. Never use this path for admission. */
  discardFromHost(context: HostContext, ticket: object): void {
    const scope = this.#revocationScope(context);
    const pending = this.#pending.get(ticket);
    if (pending && sameHostScope(pending.scope, scope)) this.#dropPending(ticket);
  }

  invalidateFromHost(context: HostContext): void {
    const scope = this.#revocationScope(context);
    this.#epoch += 1;
    for (const [ticket, pending] of this.#pending) if (sameHostScope(pending.scope, scope)) this.#dropPending(ticket);
    for (const [id, record] of this.#records) if (sameHostScope(record.scope, scope)) this.#erase(id, record);
  }

  /** Best-effort overwrite of owned buffers, not erasure of returned copies or a secure-memory guarantee. */
  dispose(): void { this.#closed = true; this.#clear(); }

  #operation<T>(work: () => T): T {
    this.#running();
    if (this.#busy) throw fail('ARTIFACT_DENIED');
    this.#busy = true;
    try { return work(); }
    catch (error) {
      if (error instanceof EphemeralArtifactError) throw error;
      throw fail();
    } finally { this.#busy = false; }
  }

  #authorize(operation: AuthorizationMetadata['operation'], spec: Pick<Spec, 'observationId' | 'mediaType'>, authorize?: ArtifactAuthorizer): void {
    try {
      if (!authorize) throw fail('ARTIFACT_DENIED');
      const outcome = authorize(Object.freeze({ operation, observationId: spec.observationId, mediaType: spec.mediaType }));
      // Async authorizers remain denied. Observe native promise rejection without executing arbitrary thenables.
      if (isPromise(outcome)) intrinsicThen.call(outcome, () => undefined, () => undefined);
      if (outcome !== true) throw fail('ARTIFACT_DENIED');
    } catch { throw fail('ARTIFACT_DENIED'); }
  }

  #fresh(context: HostContext, expected: HostScope, originalSignal: AbortSignal, deadline: number, epoch: number): void {
    const current = snapshotHostScope(context);
    const now = this.#now();
    if (!sameHostScope(expected, current) || originalSignal.aborted || context.signal.aborted || now >= deadline || epoch !== this.#epoch) throw fail();
    this.#running();
  }

  #capacity(reservation: number): void {
    let used = 0;
    for (const pending of this.#pending.values()) used += pending.spec.maxBytes;
    for (const record of this.#records.values()) used += record.bytes.byteLength;
    if (this.#pending.size + this.#records.size >= this.#maxEntries || used + reservation > this.#maxTotalBytes) throw fail('ARTIFACT_CAPACITY');
  }

  #revocationScope(context: HostContext): HostScope {
    try { return snapshotHostScopeForRevocation(context); }
    catch { throw fail(); }
  }

  #running(): void { if (!this.#enabled || this.#closed) throw fail('ARTIFACT_DENIED'); }

  #now(): number {
    this.#running();
    let now: number;
    try { now = this.#clock(); }
    catch { this.#clear(); throw fail('CLOCK_UNAVAILABLE'); }
    if (!Number.isFinite(now) || now < this.#lastNow) { this.#clear(); throw fail('CLOCK_UNAVAILABLE'); }
    this.#lastNow = now;
    return now;
  }

  #prune(now: number): void {
    for (const [ticket, pending] of this.#pending) if (now >= pending.deadline || pending.signal.aborted) this.#dropPending(ticket);
    for (const [id, record] of this.#records) if (now >= record.deadline) this.#erase(id, record);
  }

  #dropPending(ticket: object): void {
    const pending = this.#pending.get(ticket);
    this.#pending.delete(ticket);
    if (pending) clearTimeout(pending.timer);
  }
  #erase(id: string, record: Stored): void { this.#records.delete(id); clearTimeout(record.timer); intrinsicFill.call(record.bytes, 0); }
  #clear(): void {
    this.#epoch += 1;
    for (const ticket of this.#pending.keys()) this.#dropPending(ticket);
    for (const [id, record] of this.#records) this.#erase(id, record);
  }
}
