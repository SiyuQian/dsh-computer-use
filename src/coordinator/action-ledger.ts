import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, realpath, lstat, type FileHandle } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { snapshotHostScope, snapshotHostScopeForRevocation, sameHostScope, type HostScope } from '../host-adapter/scope.js';
import { actionSchema } from '../contracts/actions.js';
import { fixtureTargetSchema } from '../contracts/fixture-observation.js';
import { opaqueId, parseContract } from '../contracts/shared.js';

const proposalSchema = z.strictObject({
  taskLeaseId: opaqueId, observationId: opaqueId, target: fixtureTargetSchema, action: actionSchema,
  mode: z.literal('background'), policyVersion: opaqueId, revocationVersion: z.number().int().nonnegative(), materialContext: opaqueId,
});
const summarySchema = z.strictObject({
  execution: z.enum(['not_executed', 'completed', 'attempted', 'cancelled', 'unknown']),
  effect: z.enum(['unverified', 'no_change_observed', 'unknown']), taskOutcome: z.literal('not_evaluated'),
}).refine((summary) => summary.execution !== 'unknown' || summary.effect === 'unknown');
type Summary = z.infer<typeof summarySchema>;
type Proposal = z.infer<typeof proposalSchema>;
/** Hard journal bound; each action needs prepared, dispatch_pending and terminal events. */
const maxJournalEvents = 768;
const eventsPerAction = 3;
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const eventSchema = z.strictObject({
  version: z.literal(1), seq: z.number().int().positive().max(maxJournalEvents), previous: hex, actionId: opaqueId,
  owner: hex, fingerprint: hex, expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['prepared', 'dispatch_pending', 'terminal']), summary: summarySchema.optional(), hash: hex,
});
type JournalEvent = z.infer<typeof eventSchema>;
interface Record {
  scope: HostScope; signal: AbortSignal; owner: string; fingerprint: string; deadline: number; expiresAt: number;
  state: 'prepared' | 'dispatch_pending' | 'terminal'; summary?: Summary;
}
export interface LedgerState {
  actionId: string; state: 'prepared' | 'dispatch_pending' | 'terminal'; dispatchable: false;
  firstTransition?: boolean; summary?: Summary;
}
function fail(code = 'LEDGER_UNAVAILABLE'): Error { return new Error(`${code}: The host action ledger is unavailable. No new dispatch is authorized.`); }
function fingerprintInput(value: Proposal): string {
  return JSON.stringify([
    value.taskLeaseId, value.observationId, value.target.pid, value.target.processStart, value.target.windowKey,
    value.target.windowId, value.target.windowInstance, value.action.kind, value.action.targetHandle,
    value.action.kind === 'set_value' ? value.action.value : null, value.mode, value.policyVersion, value.revocationVersion, value.materialContext,
  ]);
}
function eventHash(event: Omit<JournalEvent, 'hash'>): string { return createHash('sha256').update(JSON.stringify(event)).digest('hex'); }
const initialHash = '0'.repeat(64);
const maxJournalBytes = 2 * 1024 * 1024;
function validDirectory(info: Stats): boolean {
  return info.isDirectory() && info.uid === process.geteuid?.() && (Number(info.mode) & 0o7777) === 0o700;
}
function validFile(info: Stats): boolean {
  return info.isFile() && info.uid === process.geteuid?.() && (Number(info.mode) & 0o7777) === 0o600 && info.nlink === 1;
}

/** Fresh, exclusive append-only journal. Not a broker or native capability; an existing journal is never reopened for writing. */
export class DurableActionLedger {
  readonly #key = randomBytes(32);
  readonly #run = randomBytes(8);
  readonly #records = new Map<string, Record>();
  readonly #mono: () => number;
  readonly #wall: () => number;
  readonly #ttl: number;
  readonly #maxActions: number;
  #lastMono = 0;
  #lastWall = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #sequence = 0;
  #previous = initialHash;
  #bytes = 0;
  #queued = 0;
  #poisoned = false;
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(
    private readonly directory: string, private readonly file: FileHandle,
    private readonly parent: FileHandle, private readonly fileIdentity: { dev: number; ino: number },
    private readonly parentIdentity: { dev: number; ino: number },
    options: { monotonicMs?: () => number; wallTimeMs?: () => number; ttlMs?: number; maxActions?: number },
  ) {
    this.#mono = options.monotonicMs ?? (() => performance.now());
    this.#wall = options.wallTimeMs ?? (() => Date.now());
    this.#ttl = options.ttlMs ?? 60_000;
    this.#maxActions = options.maxActions ?? 64;
  }

  static async create(options: { directory: string; monotonicMs?: () => number; wallTimeMs?: () => number; ttlMs?: number; maxActions?: number }): Promise<DurableActionLedger> {
    const ttl = options.ttlMs ?? 60_000;
    const limit = options.maxActions ?? 64;
    if (!Number.isInteger(ttl) || ttl < 5000 || ttl > 60_000 || !Number.isInteger(limit) || limit < 1 || limit > 256) throw fail('INVALID_REQUEST');
    let parent: FileHandle | undefined;
    let file: FileHandle | undefined;
    try {
      if (!isAbsolute(options.directory) || await realpath(options.directory) !== options.directory) throw fail();
      parent = await open(options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const parentInfo = await parent.stat();
      if (!validDirectory(parentInfo)) throw fail();
      file = await open(join(options.directory, 'actions.journal'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      const fileInfo = await file.stat();
      if (!validFile(fileInfo)) throw fail();
      await file.sync();
      await parent.sync();
      const ledger = new DurableActionLedger(options.directory, file, parent, fileInfo, parentInfo, options);
      await ledger.#requireWitness();
      return ledger;
    } catch {
      await file?.close().catch(() => {}); await parent?.close().catch(() => {});
      throw fail();
    }
  }

  async prepareFromHost(context: HostContext, rawProposal: unknown): Promise<LedgerState> {
    const scope = snapshotHostScope(context);
    const proposal = parseContract(proposalSchema, rawProposal);
    return this.#serialize(async () => {
      this.#requireOpen();
      const { mono, wall } = this.#now();
      if (context.signal.aborted) throw fail('ACTION_UNAVAILABLE');
      if (!this.#hasRoom()) throw fail('LEDGER_CAPACITY');
      const owner = this.#owner(scope);
      const expiresAt = wall + this.#ttl;
      const actionId = this.#sign(owner, expiresAt);
      const record: Record = { scope, signal: context.signal, owner, fingerprint: this.#hmac('proposal', fingerprintInput(proposal)), deadline: mono + this.#ttl, expiresAt, state: 'prepared' };
      await this.#append(actionId, record);
      this.#records.set(actionId, record);
      this.#require(context, actionId);
      return this.#state(actionId, record);
    });
  }

  /** Seal a host bookkeeping transition only. A first transition still cannot dispatch native work. */
  async beginDispatchFromHost(context: HostContext, actionId: string, rawProposal: unknown): Promise<LedgerState> {
    const proposal = parseContract(proposalSchema, rawProposal);
    return this.#serialize(async () => {
      const record = this.#require(context, actionId);
      if (!timingSafeEqual(Buffer.from(record.fingerprint, 'hex'), Buffer.from(this.#hmac('proposal', fingerprintInput(proposal)), 'hex'))) throw fail('ACTION_ID_CONFLICT');
      if (record.state !== 'prepared') return { ...this.#state(actionId, record), firstTransition: false };
      const next = { ...record, state: 'dispatch_pending' as const };
      await this.#append(actionId, next);
      this.#records.set(actionId, next);
      this.#require(context, actionId);
      return { ...this.#state(actionId, next), firstTransition: true };
    });
  }

  async finishFromHost(context: HostContext, actionId: string, rawSummary: unknown): Promise<LedgerState> {
    const summary = parseContract(summarySchema, rawSummary);
    return this.#serialize(async () => {
      const record = this.#requireForSettlement(context, actionId);
      if (record.state === 'terminal') {
        if (JSON.stringify(record.summary) !== JSON.stringify(summary)) throw fail('ACTION_ID_CONFLICT');
        return this.#state(actionId, record);
      }
      if (record.state !== 'dispatch_pending' || summary.execution === 'not_executed') throw fail('ACTION_STATE_INVALID');
      const next = { ...record, state: 'terminal' as const, summary };
      await this.#append(actionId, next);
      this.#records.set(actionId, next);
      return this.#state(actionId, next);
    });
  }

  /**
   * Whether a new action can be fully recorded (prepare, dispatch_pending and terminal). Terminal records are kept as
   * replay tombstones, so a full ledger must be replaced by the host, never pruned.
   */
  hasCapacityFromHost(): boolean {
    return !this.#closing && !this.#closed && !this.#poisoned && this.#hasRoom();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#tail.then(async () => {
      this.#closed = true;
      this.#records.clear(); this.#key.fill(0); this.#run.fill(0);
      const results = await Promise.allSettled([this.file.close(), this.parent.close()]);
      if (results.some((result) => result.status === 'rejected')) throw fail();
    });
    return this.#closePromise;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed || this.#poisoned) return Promise.reject(fail());
    if (this.#queued >= 64) return Promise.reject(fail('LEDGER_CAPACITY'));
    this.#queued += 1;
    const next = this.#tail.then(operation).finally(() => { this.#queued -= 1; });
    this.#tail = next.catch(() => {});
    return next;
  }
  #hasRoom(): boolean { return this.#records.size < this.#maxActions && this.#sequence + eventsPerAction <= maxJournalEvents; }
  #requireOpen(): void { if (this.#closing || this.#closed || this.#poisoned) throw fail(); }
  #now(): { mono: number; wall: number } {
    let mono: number; let wall: number;
    try { mono = this.#mono(); wall = this.#wall(); }
    catch { this.#poisoned = true; throw fail('CLOCK_UNAVAILABLE'); }
    if (!Number.isFinite(mono) || mono < this.#lastMono || !Number.isSafeInteger(wall) || wall < this.#lastWall || wall < 1 || wall > Number.MAX_SAFE_INTEGER - 60_000) {
      this.#poisoned = true; throw fail('CLOCK_UNAVAILABLE');
    }
    this.#lastMono = mono; this.#lastWall = wall;
    return { mono, wall };
  }
  #require(context: HostContext, actionId: string): Record {
    this.#requireOpen();
    const scope = snapshotHostScope(context);
    const record = this.#records.get(actionId);
    const { mono, wall } = this.#now();
    if (!record || record.signal.aborted || !sameHostScope(scope, record.scope) || !this.#validToken(actionId, record.owner, record.expiresAt) || mono >= record.deadline || wall >= record.expiresAt) throw fail('ACTION_UNAVAILABLE');
    return record;
  }
  #requireForSettlement(context: HostContext, actionId: string): Record {
    this.#requireOpen();
    const scope = snapshotHostScopeForRevocation(context);
    const record = this.#records.get(actionId);
    this.#now();
    if (!record || !sameHostScope(scope, record.scope) || !this.#validToken(actionId, record.owner, record.expiresAt)) throw fail('ACTION_UNAVAILABLE');
    return record;
  }
  #owner(scope: HostScope): string {
    return this.#hmac('owner', JSON.stringify([scope.agentId, scope.sessionId, scope.generation, scope.workspace]));
  }
  #hmac(domain: string, input: string | Buffer): string { return createHmac('sha256', this.#key).update(domain).update('\0').update(input).digest('hex'); }
  #sign(owner: string, expires: number): string {
    const header = Buffer.alloc(33);
    header[0] = 1; this.#run.copy(header, 1); randomBytes(16).copy(header, 9); header.writeBigUInt64BE(BigInt(expires), 25);
    const mac = Buffer.from(this.#hmac('action-id', Buffer.concat([header, Buffer.from(owner, 'hex')])), 'hex');
    return Buffer.concat([header, mac]).toString('base64url');
  }
  #validToken(token: string, owner: string, expires: number): boolean {
    if (!/^[A-Za-z0-9_-]{87}$/.test(token)) return false;
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length !== 65 || bytes.toString('base64url') !== token || bytes[0] !== 1 || !bytes.subarray(1, 9).equals(this.#run) || bytes.readBigUInt64BE(25) !== BigInt(expires)) return false;
    const expected = Buffer.from(this.#hmac('action-id', Buffer.concat([bytes.subarray(0, 33), Buffer.from(owner, 'hex')])), 'hex');
    return timingSafeEqual(expected, bytes.subarray(33));
  }
  #state(actionId: string, record: Record): LedgerState {
    return { actionId, state: record.state, dispatchable: false, ...(record.summary ? { summary: structuredClone(record.summary) } : {}) };
  }
  async #requireWitness(): Promise<void> {
    const parent = await lstat(this.directory);
    const entry = await lstat(join(this.directory, 'actions.journal'));
    const fd = await this.file.stat();
    if (!validDirectory(parent) || parent.dev !== this.parentIdentity.dev || parent.ino !== this.parentIdentity.ino ||
        !validFile(entry) || !validFile(fd) || entry.dev !== this.fileIdentity.dev || entry.ino !== this.fileIdentity.ino || fd.dev !== entry.dev || fd.ino !== entry.ino || fd.size !== this.#bytes) throw fail();
  }
  async #append(actionId: string, record: Record): Promise<void> {
    try {
      this.#requireOpen();
      await this.#requireWitness();
      const base = {
        version: 1 as const, seq: this.#sequence + 1, previous: this.#previous, actionId,
        owner: record.owner, fingerprint: record.fingerprint, expiresAt: record.expiresAt, state: record.state,
        ...(record.summary ? { summary: record.summary } : {}),
      };
      const hash = eventHash(base);
      const bytes = Buffer.from(`${JSON.stringify({ ...base, hash })}\n`);
      if (this.#bytes + bytes.length > maxJournalBytes || this.#sequence >= maxJournalEvents) throw fail('LEDGER_CAPACITY');
      let offset = 0;
      while (offset < bytes.length) {
        const written = await this.file.write(bytes, offset, bytes.length - offset, null);
        if (written.bytesWritten < 1) throw fail();
        offset += written.bytesWritten;
      }
      await this.file.sync();
      this.#bytes += bytes.length;
      await this.#requireWitness();
      this.#sequence += 1; this.#previous = hash;
    } catch { this.#poisoned = true; throw fail(); }
  }
}

/** Recovery is host-only, read-only and never restores payloads, signing keys, or execution permission. */
export async function recoverActionJournalFromHost(directory: string): Promise<{
  dispatchable: false; truncatedTail: boolean;
  actions: Array<{ actionId: string; state: 'unknown' | 'replay_rejected' | 'terminal'; dispatchable: false; summary?: Summary }>;
}> {
  let file: FileHandle | undefined;
  try {
    if (!isAbsolute(directory) || await realpath(directory) !== directory || !validDirectory(await lstat(directory))) throw fail();
    file = await open(join(directory, 'actions.journal'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!validFile(info) || info.size > maxJournalBytes) throw fail();
    const raw = await file.readFile('utf8');
    const truncatedTail = raw.length > 0 && !raw.endsWith('\n');
    const lines = raw.split('\n'); lines.pop();
    const records = new Map<string, JournalEvent>();
    let previous = initialHash; let sequence = 0;
    for (const line of lines) {
      if (Buffer.byteLength(line) > 2048) throw fail();
      const event = parseContract(eventSchema, JSON.parse(line));
      const { hash, ...base } = event;
      const prior = records.get(event.actionId);
      if (event.seq !== ++sequence || event.previous !== previous || hash !== eventHash(base) || JSON.stringify(event) !== line ||
          (event.state === 'terminal' ? !event.summary || event.summary.execution === 'not_executed' : !!event.summary) ||
          (!prior ? event.state !== 'prepared' : prior.owner !== event.owner || prior.fingerprint !== event.fingerprint || prior.expiresAt !== event.expiresAt ||
            (prior.state === 'prepared' ? event.state !== 'dispatch_pending' : prior.state === 'dispatch_pending' ? event.state !== 'terminal' : true))) throw fail();
      previous = hash; records.set(event.actionId, event);
    }
    return {
      dispatchable: false, truncatedTail,
      actions: [...records.values()].map((event) => ({
        actionId: event.actionId, state: event.state === 'terminal' ? 'terminal' : event.state === 'prepared' ? 'replay_rejected' : 'unknown',
        dispatchable: false, ...(event.summary ? { summary: event.summary } : {}),
      })),
    };
  } catch { throw fail(); }
  finally {
    try { await file?.close(); }
    catch { throw fail(); }
  }
}
