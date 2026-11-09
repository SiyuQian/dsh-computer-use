import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { HostContext } from '../../src/host-adapter/context.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Module = typeof import('../../src/evidence/ephemeral-artifacts.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/evidence/ephemeral-artifacts.js';
  module = await import(path).catch(() => ({} as Module));
});
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
const allow = () => true;
const spec = { observationId: 'observation_fixture', mediaType: 'image/png', maxBytes: 3 };
const bytes = () => new Uint8Array([97, 98, 99]); // Public test bytes "abc", not an image or screenshot.
function host(): HostContext { return { owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
  lifetime: Object.freeze({}), workspace: '/tmp/cu-artifacts', callId: 'call_fixture', turn: 1, signal: new AbortController().signal }; }
function fixture(options: { enabledFromHost?: boolean; ttlMs?: number; maxEntries?: number; maxTotalBytes?: number } = {}) {
  expect(module.EphemeralArtifactStore).toBeTypeOf('function');
  let now = 100;
  const store = new module.EphemeralArtifactStore({ enabledFromHost: true, ttlMs: 5000, ...options, monotonicMs: () => now });
  cleanups.push(() => store.dispose()); const context = host();
  return { store, context, advance(ms: number) { now += ms; }, regress() { now = 99; },
    begin: () => store.beginFromHost(context, spec, allow),
    put: () => store.commitFromHost(context, store.beginFromHost(context, spec, allow), bytes(), allow),
  };
}

describe('CU-014a: explicit, in-memory host artifact lifetime; no capture or evidence claims', () => {
  it('is disabled by default and never treats a callback alone as host enablement', () => {
    const f = fixture(); const disabled = new module.EphemeralArtifactStore(); cleanups.push(() => disabled.dispose());
    expect(() => disabled.beginFromHost(f.context, spec, allow)).toThrow('ARTIFACT_DENIED');
    expect(() => disabled.readFromHost(f.context, 'artifact_model', allow)).toThrow('ARTIFACT_DENIED');
  });

  it('requires an explicit successful authorization for stage, publication and every byte access', () => {
    const f = fixture();
    expect(() => f.store.beginFromHost(f.context, spec)).toThrow('ARTIFACT_DENIED');
    const doomed = f.begin(); expect(() => f.store.commitFromHost(f.context, doomed, bytes())).toThrow('ARTIFACT_DENIED');
    expect(() => f.store.commitFromHost(f.context, doomed, bytes(), allow)).toThrow('ARTIFACT_UNAVAILABLE');
    const descriptor = f.put();
    expect(() => f.store.readFromHost(f.context, descriptor.artifactId)).toThrow('ARTIFACT_DENIED');
    expect(f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes).toEqual(bytes());
    expect(() => f.store.readFromHost(f.context, descriptor.artifactId, () => false)).toThrow('ARTIFACT_DENIED');
  });

  it('publishes an opaque digest descriptor without paths, capture geometry or verification authority', () => {
    const f = fixture(); const descriptor = f.put();
    expect(descriptor).toEqual({ artifactId: expect.stringMatching(/^artifact_/), observationId: 'observation_fixture', mediaType: 'image/png', byteLength: 3,
      digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    const read = f.store.readFromHost(f.context, descriptor.artifactId, allow);
    expect(read.descriptor).toEqual(descriptor); expect(read.bytes).toEqual(bytes());
    expect(descriptor).not.toHaveProperty('coherent'); expect(descriptor).not.toHaveProperty('evidenceId'); expect(descriptor).not.toHaveProperty('path');
  });

  it('retains only owned copies and never returns its internal byte storage', () => {
    const f = fixture(); const input = bytes(); const descriptor = f.store.commitFromHost(f.context, f.begin(), input, allow);
    input.fill(0); descriptor.observationId = 'observation_changed';
    const first = f.store.readFromHost(f.context, descriptor.artifactId, allow); first.bytes.fill(0); first.descriptor.digest = 'changed';
    const next = f.store.readFromHost(f.context, descriptor.artifactId, allow);
    expect(next.bytes).toEqual(bytes()); expect(next.descriptor.observationId).toBe('observation_fixture');
    expect(next.descriptor.digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it.each(['agentId', 'sessionId', 'generation', 'workspace', 'lifetime'] as const)('denies access across a changed %s scope', (field) => {
    const f = fixture(); const descriptor = f.put(); const current = { ...f.context, owner: { ...f.context.owner } };
    if (field === 'workspace') current.workspace = '/tmp/other';
    else if (field === 'lifetime') current.lifetime = Object.freeze({});
    else current.owner[field] = 'other_identity';
    expect(() => f.store.readFromHost(current, descriptor.artifactId, allow)).toThrow('ARTIFACT_UNAVAILABLE');
    expect(f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes).toEqual(bytes());
  });

  it('rejects a copied, foreign-store or already-consumed ticket without creating another artifact', () => {
    const f = fixture(); const ticket = f.begin(); const other = fixture();
    expect(() => f.store.commitFromHost(f.context, { ...ticket }, bytes(), allow)).toThrow('ARTIFACT_UNAVAILABLE');
    expect(() => other.store.commitFromHost(f.context, ticket, bytes(), allow)).toThrow('ARTIFACT_UNAVAILABLE');
    const descriptor = f.store.commitFromHost(f.context, ticket, bytes(), allow);
    expect(() => f.store.commitFromHost(f.context, ticket, bytes(), allow)).toThrow('ARTIFACT_UNAVAILABLE');
    expect(f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes).toEqual(bytes());
  });

  it('ages pending and committed bytes from stage start without extending TTL at commit or read', () => {
    const f = fixture(); const ticket = f.begin(); f.advance(4999);
    const descriptor = f.store.commitFromHost(f.context, ticket, bytes(), allow);
    expect(f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes).toEqual(bytes()); f.advance(1);
    expect(() => f.store.readFromHost(f.context, descriptor.artifactId, allow)).toThrow('ARTIFACT_UNAVAILABLE');
    const next = f.begin(); f.advance(5000); expect(() => f.store.commitFromHost(f.context, next, bytes(), allow)).toThrow('ARTIFACT_UNAVAILABLE');
  });

  it('counts pending reservations and committed bytes together without evicting a live artifact', () => {
    const f = fixture({ maxEntries: 2, maxTotalBytes: 6 }); const first = f.begin(); const second = f.begin();
    expect(() => f.begin()).toThrow('ARTIFACT_CAPACITY');
    const descriptor = f.store.commitFromHost(f.context, first, bytes(), allow);
    expect(() => f.begin()).toThrow('ARTIFACT_CAPACITY');
    f.store.discardFromHost(f.context, second);
    const next = f.begin(); expect(() => f.begin()).toThrow('ARTIFACT_CAPACITY');
    expect(f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes).toEqual(bytes()); f.store.discardFromHost(f.context, next);
  });

  it('reclaims expired and discarded reservations, including after caller cancellation', () => {
    const f = fixture({ maxEntries: 1, maxTotalBytes: 3 }); const abort = new AbortController(); const context = { ...f.context, signal: abort.signal };
    const pending = f.store.beginFromHost(context, spec, allow); abort.abort(); f.store.discardFromHost(context, pending);
    const ticket = f.begin(); f.advance(5000); const next = f.begin();
    expect(() => f.store.commitFromHost(f.context, ticket, bytes(), allow)).toThrow('ARTIFACT_UNAVAILABLE');
    expect(f.store.commitFromHost(f.context, next, bytes(), allow).byteLength).toBe(3);
  });

  it('invalidates only the exact scope even after abort, without erasing a same-ID different lifetime', () => {
    const f = fixture(); const other = { ...f.context, lifetime: Object.freeze({}) };
    const first = f.put(); const second = f.store.commitFromHost(other, f.store.beginFromHost(other, spec, allow), bytes(), allow);
    const abort = new AbortController(); abort.abort(); f.store.invalidateFromHost({ ...f.context, signal: abort.signal });
    expect(() => f.store.readFromHost(f.context, first.artifactId, allow)).toThrow('ARTIFACT_UNAVAILABLE');
    expect(f.store.readFromHost(other, second.artifactId, allow).bytes).toEqual(bytes());
  });

  it.each(['invalidate', 'dispose', 'expire', 'cancel'] as const)('does not publish after %s inside the host authorization callback', (fault) => {
    const f = fixture(); const abort = new AbortController(); const context = { ...f.context, signal: abort.signal };
    const ticket = f.store.beginFromHost(context, spec, allow);
    expect(() => f.store.commitFromHost(context, ticket, bytes(), () => {
      if (fault === 'invalidate') f.store.invalidateFromHost(context);
      if (fault === 'dispose') f.store.dispose();
      if (fault === 'expire') f.advance(5000);
      if (fault === 'cancel') abort.abort();
      return true;
    })).toThrow();
    expect(() => f.store.commitFromHost(context, ticket, bytes(), allow)).toThrow();
  });

  it.each(['invalidate', 'dispose', 'expire', 'cancel'] as const)('does not return bytes after %s inside read authorization', (fault) => {
    const f = fixture(); const descriptor = f.put(); const abort = new AbortController(); const context = { ...f.context, signal: abort.signal };
    expect(() => f.store.readFromHost(context, descriptor.artifactId, () => {
      if (fault === 'invalidate') f.store.invalidateFromHost(context);
      if (fault === 'dispose') f.store.dispose();
      if (fault === 'expire') f.advance(5000);
      if (fault === 'cancel') abort.abort();
      return true;
    })).toThrow();
  });

  it.each([false, undefined, 'true', 1, {}, Promise.resolve(true)])('does not treat a non-true synchronous authorization outcome as permission', (outcome) => {
    const f = fixture(); expect(() => f.store.beginFromHost(f.context, spec, () => outcome)).toThrow('ARTIFACT_DENIED');
  });

  it('never sends payload bytes to authorization callbacks or echoes their exceptions', () => {
    const f = fixture(); let received: unknown;
    const descriptor = f.store.commitFromHost(f.context, f.begin(), bytes(), (metadata) => { received = metadata; expect(Object.isFrozen(metadata)).toBe(true); return true; });
    expect(Object.keys(received as object).sort()).toEqual(['mediaType', 'observationId', 'operation']);
    expect(() => f.store.readFromHost(f.context, descriptor.artifactId, () => { throw new Error('private-fixture-value'); })).toThrow('ARTIFACT_DENIED');
    try { f.store.readFromHost(f.context, descriptor.artifactId, () => { throw new Error('private-fixture-value'); }); } catch (error) { expect(String(error)).not.toContain('private-fixture-value'); }
  });

  it('prevents authorizer reentry from publishing or reading a second path', () => {
    const f = fixture(); const descriptor = f.put(); const ticket = f.begin(); let nested = 0;
    const result = f.store.commitFromHost(f.context, ticket, bytes(), () => {
      try { f.store.commitFromHost(f.context, ticket, bytes(), allow); nested += 1; } catch { /* closed during callback */ }
      try { f.store.readFromHost(f.context, descriptor.artifactId, allow); nested += 1; } catch { /* closed during callback */ }
      return true;
    });
    expect(nested).toBe(0); expect(f.store.readFromHost(f.context, result.artifactId, allow).bytes).toEqual(bytes());
  });

  it('fails closed on a regressing or throwing clock and does not restore previous bytes', () => {
    const f = fixture(); const descriptor = f.put(); f.regress(); expect(() => f.store.readFromHost(f.context, descriptor.artifactId, allow)).toThrow('CLOCK_UNAVAILABLE');
    f.advance(2); expect(() => f.store.readFromHost(f.context, descriptor.artifactId, allow)).toThrow('ARTIFACT_UNAVAILABLE');
    const broken = new module.EphemeralArtifactStore({ enabledFromHost: true, monotonicMs: () => { throw new Error('private-fixture-value'); } }); cleanups.push(() => broken.dispose());
    expect(() => broken.beginFromHost(f.context, spec, allow)).toThrow('CLOCK_UNAVAILABLE');
  });

  it.each([{}, { ...spec, path: '/private/data' }, { ...spec, maxBytes: 0 }, { ...spec, maxBytes: 1_048_577 }, { ...spec, mediaType: 'text/plain' }])('rejects malformed or broadened staging metadata', (input) => {
    const f = fixture(); expect(() => f.store.beginFromHost(f.context, input, allow)).toThrow('INVALID_REQUEST');
  });

  it.each([new Uint8Array(), new Uint8Array(4), 'abc', { byteLength: 3, slice: () => bytes() }])('rejects invalid payloads and consumes their pending ticket', (input) => {
    const f = fixture(); const ticket = f.begin(); expect(() => f.store.commitFromHost(f.context, ticket, input, allow)).toThrow('ARTIFACT_INVALID');
    expect(() => f.store.commitFromHost(f.context, ticket, bytes(), allow)).toThrow('ARTIFACT_UNAVAILABLE'); expect(f.put().byteLength).toBe(3);
  });

  it('uses intrinsic byte-view length and copy operations, not overridable byteLength or slice methods', () => {
    const f = fixture(); const input = bytes();
    Object.defineProperty(input, 'byteLength', { get() { throw new Error('Do not call source accessors'); } });
    Object.defineProperty(input, 'slice', { value() { throw new Error('Do not call source methods'); } });
    const descriptor = f.store.commitFromHost(f.context, f.begin(), input, allow);
    expect(f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes).toEqual(bytes());
  });

  it('rejects shared and resizable backing memory instead of claiming a coherent snapshot', () => {
    const f = fixture();
    for (const backing of [new SharedArrayBuffer(3), Reflect.construct(ArrayBuffer, [3, { maxByteLength: 6 }]) as ArrayBuffer]) {
      expect(() => f.store.commitFromHost(f.context, f.begin(), new Uint8Array(backing), allow)).toThrow('ARTIFACT_INVALID');
    }
  });

  it('clears expired owned records on a timer even when no further caller touches the store', () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ maxEntries: 1, maxTotalBytes: 3 }); const descriptor = f.put();
      vi.advanceTimersByTime(5000);
      // The injected monotonic clock deliberately remains at 100: the scheduled expiry itself must remove storage.
      expect(() => f.store.readFromHost(f.context, descriptor.artifactId, allow)).toThrow('ARTIFACT_UNAVAILABLE');
      expect(f.put().byteLength).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it.each(['commit', 'read'] as const)('checks final membership after context signal getters can invalidate %s', (operation) => {
    const f = fixture(); const descriptor = f.put(); const ticket = f.begin(); let armed = false; let fired = false;
    const context = { ...f.context, get signal() {
      if (armed && !fired) { fired = true; f.store.invalidateFromHost(f.context); }
      return f.context.signal;
    } };
    const authorizer = () => { armed = true; return true; };
    expect(() => operation === 'commit'
      ? f.store.commitFromHost(context, ticket, bytes(), authorizer)
      : f.store.readFromHost(context, descriptor.artifactId, authorizer)).toThrow();
    expect(fired).toBe(true);
  });

  it('reserves requested bytes before staging and releases unused reservation after a smaller commit', () => {
    const f = fixture({ maxEntries: 3, maxTotalBytes: 6 }); const larger = { ...spec, maxBytes: 5 };
    const ticket = f.store.beginFromHost(f.context, larger, allow);
    expect(() => f.begin()).toThrow('ARTIFACT_CAPACITY');
    const descriptor = f.store.commitFromHost(f.context, ticket, bytes(), allow);
    expect(descriptor.byteLength).toBe(3); const second = f.begin();
    expect(() => f.begin()).toThrow('ARTIFACT_CAPACITY'); f.store.discardFromHost(f.context, second);
  });

  it('accepts the exact per-item bound and rejects a larger intrinsic length before copying', () => {
    const f = fixture(); const specAtBound = { ...spec, maxBytes: 1_048_576 };
    const descriptor = f.store.commitFromHost(f.context, f.store.beginFromHost(f.context, specAtBound, allow), new Uint8Array(1_048_576), allow);
    expect(descriptor.byteLength).toBe(1_048_576);
    const ticket = f.store.beginFromHost(f.context, specAtBound, allow);
    const tooLarge = new Uint8Array(1_048_577); Object.defineProperty(tooLarge, 'byteLength', { value: 3 });
    expect(() => f.store.commitFromHost(f.context, ticket, tooLarge, allow)).toThrow('ARTIFACT_INVALID');
  });

  it('blocks staging when input getters dispose or invalidate the store before reservation publication', () => {
    for (const fault of ['dispose', 'invalidate'] as const) {
      const f = fixture();
      const input = { ...spec, get observationId() {
        if (fault === 'dispose') f.store.dispose(); else f.store.invalidateFromHost(f.context);
        return 'observation_fixture';
      } };
      expect(() => f.store.beginFromHost(f.context, input, allow)).toThrow();
    }
  });

  it('does not lose committing capacity when the authorizer reenters staging', () => {
    const f = fixture({ maxEntries: 1, maxTotalBytes: 3 }); const ticket = f.begin(); let staged = false;
    const descriptor = f.store.commitFromHost(f.context, ticket, bytes(), () => {
      try { f.begin(); staged = true; } catch { /* store remains closed during authorization */ }
      return true;
    });
    expect(staged).toBe(false); expect(f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes).toEqual(bytes());
    expect(() => f.begin()).toThrow('ARTIFACT_CAPACITY');
  });

  it('fails closed if a typed byte view is detached before commit, without retaining a reservation', () => {
    const f = fixture({ maxEntries: 1, maxTotalBytes: 3 }); const input = bytes();
    structuredClone(input.buffer, { transfer: [input.buffer] });
    expect(() => f.store.commitFromHost(f.context, f.begin(), input, allow)).toThrow('ARTIFACT_INVALID');
    expect(f.put().byteLength).toBe(3);
  });

  it('copies only the visible byte range and preserves lifetime across later calls rather than the staging caller signal', () => {
    const f = fixture(); const backing = new Uint8Array([0, 97, 98, 99, 0]); const abort = new AbortController();
    const context = { ...f.context, signal: abort.signal };
    const descriptor = f.store.commitFromHost(context, f.store.beginFromHost(context, spec, allow), backing.subarray(1, 4), allow);
    abort.abort();
    expect(f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes).toEqual(bytes());
    expect(() => f.store.readFromHost(context, descriptor.artifactId, allow)).toThrow('ARTIFACT_UNAVAILABLE');
  });

  it('discards future access without claiming it erased a copy already returned to a caller', () => {
    const f = fixture(); const descriptor = f.put(); const returned = f.store.readFromHost(f.context, descriptor.artifactId, allow).bytes;
    f.store.invalidateFromHost(f.context);
    expect(returned).toEqual(bytes()); expect(() => f.store.readFromHost(f.context, descriptor.artifactId, allow)).toThrow('ARTIFACT_UNAVAILABLE');
  });

  it.each(['begin', 'commit', 'read', 'discard', 'invalidate'] as const)('sanitizes current host scope getter exceptions during %s', (operation) => {
    const f = fixture(); const descriptor = f.put(); const ticket = f.begin();
    const context = { ...f.context, get workspace(): string { throw new Error('private-fixture-value'); } };
    let failure: unknown;
    try {
      if (operation === 'begin') f.store.beginFromHost(context, spec, allow);
      if (operation === 'commit') f.store.commitFromHost(context, ticket, bytes(), allow);
      if (operation === 'read') f.store.readFromHost(context, descriptor.artifactId, allow);
      if (operation === 'discard') f.store.discardFromHost(context, ticket);
      if (operation === 'invalidate') f.store.invalidateFromHost(context);
    } catch (error) { failure = error; }
    expect(String(failure)).not.toContain('private-fixture-value'); expect(String(failure)).toContain('ARTIFACT_UNAVAILABLE');
  });

  it('overwrites only owned byte views on revoke, refused publication and dispose through an isolated real-copy probe', () => {
    const result = spawnSync(process.execPath, [resolve('tests/support/ephemeral-artifact-probe.mjs')], { encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout).toBe('OWNED_VIEWS_OVERWRITTEN; RETURNED_COPY_NOT_ERASED\n');
  });

  it('rejects async authorizers without leaving an unhandled promise rejection in the host process', () => {
    const result = spawnSync(process.execPath, [resolve('tests/support/ephemeral-artifact-probe.mjs'), 'async-authorizer'], { encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout).toBe('ASYNC_AUTH_DENIED_WITHOUT_UNHANDLED_REJECTION\n');
    expect(result.stderr).not.toContain('PUBLIC_ASYNC_AUTH_REFUSAL');
  });

  it('does not extend lifetime or preserve state across dispose or another store instance', () => {
    const f = fixture(); const descriptor = f.put(); const other = fixture();
    expect(() => other.store.readFromHost(f.context, descriptor.artifactId, allow)).toThrow('ARTIFACT_UNAVAILABLE');
    f.store.dispose(); f.store.dispose(); expect(() => f.begin()).toThrow('ARTIFACT_DENIED');
    expect(() => f.store.readFromHost(f.context, descriptor.artifactId, allow)).toThrow('ARTIFACT_DENIED');
  });
});
