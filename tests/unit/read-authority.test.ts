import { beforeAll, describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';

type Module = typeof import('../../src/policy/read-authority.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/policy/read-authority.js';
  module = await import(path);
});
function host(): HostContext {
  return {
    owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    lifetime: Object.freeze({}), workspace: '/tmp/cu-policy-fixture', callId: 'call_fixture', turn: 1, signal: new AbortController().signal,
  };
}
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
function fixture() {
  let now = 100;
  const authority = new module.FixtureReadAuthority({ monotonicMs: () => now });
  const context = host();
  return { authority, context, advance: (ms: number) => { now += ms; }, regress: () => { now = 99; } };
}

describe('CU-008a: exact short-lived host fixture read grants', () => {
  it('denies by default; a caller-supplied grant name or approved boolean cannot create permission', () => {
    const f = fixture();
    expect(() => f.authority.requireRead(f.context, 'model_approved', target)).toThrow('READ_DENIED');
    expect(() => f.authority.requireRead(f.context, 'model_approved', { ...target, approved: true })).toThrow('INVALID_REQUEST');
  });

  it('allows only a grant issued by this host registry and returns no control authority', () => {
    const f = fixture();
    const grant = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    expect(grant).toMatch(/^read_grant_/);
    const permit = f.authority.requireRead(f.context, grant, target);
    expect(permit).toMatchObject({ kind: 'fixture_read_only', target, source: 'host-static-fixture', grantId: grant });
    expect(permit.signal.aborted).toBe(false);
    expect(permit.monotonicDeadline).toBe(30_100);
    expect(permit).not.toHaveProperty('allowedOperations');
    expect(permit).not.toHaveProperty('approved');
    const other = new module.FixtureReadAuthority();
    expect(() => other.requireRead(f.context, grant, target)).toThrow('READ_DENIED');
  });

  it.each(['pid', 'processStart', 'windowKey', 'windowId', 'windowInstance'] as const)('denies a changed %s target without silently widening a grant', (field) => {
    const f = fixture();
    const grant = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const changed = { ...target };
    if (field === 'pid') changed.pid = 42;
    if (field === 'processStart') changed.processStart = 'process_restarted';
    if (field === 'windowKey') changed.windowKey = 'secondary';
    if (field === 'windowId') changed.windowId = 8;
    if (field === 'windowInstance') changed.windowInstance = 'window_replaced';
    expect(() => f.authority.requireRead(f.context, grant, changed)).toThrow('READ_DENIED');
  });

  it.each(['agent', 'session', 'generation', 'workspace', 'lifetime'] as const)('denies a changed %s caller scope', (field) => {
    const f = fixture();
    const grant = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const changed = { ...f.context, owner: { ...f.context.owner } };
    if (field === 'agent') changed.owner.agentId = 'another_agent';
    if (field === 'session') changed.owner.sessionId = 'another_session';
    if (field === 'generation') changed.owner.generation = 'another_generation';
    if (field === 'workspace') changed.workspace = '/tmp/different-workspace';
    if (field === 'lifetime') changed.lifetime = Object.freeze({});
    expect(() => f.authority.requireRead(changed, grant, target)).toThrow('READ_DENIED');
    expect(f.authority.requireRead(f.context, grant, target).kind).toBe('fixture_read_only');
  });

  it('expires exactly at its monotonic deadline and aborts issued read permits', () => {
    const f = fixture();
    const grant = f.authority.grantFromHost(f.context, target, { ttlMs: 5000 });
    const permit = f.authority.requireRead(f.context, grant, target);
    f.advance(4999);
    expect(f.authority.requireRead(f.context, grant, target).kind).toBe('fixture_read_only');
    f.advance(1);
    expect(() => f.authority.requireRead(f.context, grant, target)).toThrow('READ_DENIED');
    expect(permit.signal.aborted).toBe(true);
  });

  it('revokes only the named grant and aborts its in-flight permits without treating abort as rollback', () => {
    const f = fixture();
    const grant = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const second = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const permit = f.authority.requireRead(f.context, grant, target);
    f.authority.revokeFromHost(grant);
    f.authority.revokeFromHost(grant);
    expect(permit.signal.aborted).toBe(true);
    expect(() => f.authority.requireRead(f.context, grant, target)).toThrow('READ_DENIED');
    expect(f.authority.requireRead(f.context, second, target).signal.aborted).toBe(false);
  });

  it('revokes one exact scope even after caller abort, without revoking a same-ID replacement lifetime', () => {
    const f = fixture();
    const other = { ...f.context, lifetime: Object.freeze({}) };
    const first = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const second = f.authority.grantFromHost(other, target, { ttlMs: 30_000 });
    const permit = f.authority.requireRead(f.context, first, target);
    const abort = new AbortController(); abort.abort();
    expect(f.authority.revokeScopeFromHost).toBeTypeOf('function');
    f.authority.revokeScopeFromHost({ ...f.context, signal: abort.signal });
    expect(permit.signal.aborted).toBe(true);
    expect(() => f.authority.requireRead(f.context, first, target)).toThrow('READ_DENIED');
    expect(f.authority.requireRead(other, second, target).signal.aborted).toBe(false);
  });

  it('removes every sibling grant before notifying synchronous scope-revocation listeners', () => {
    const f = fixture();
    const first = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const second = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    let reentrantAllowed = false;
    f.authority.requireRead(f.context, first, target).signal.addEventListener('abort', () => {
      try { f.authority.requireRead(f.context, second, target); reentrantAllowed = true; } catch { /* revoked */ }
    });
    expect(f.authority.revokeScopeFromHost).toBeTypeOf('function');
    f.authority.revokeScopeFromHost(f.context);
    expect(reentrantAllowed).toBe(false);
    f.authority.dispose();
  });

  it('invalidates all old grants on policy replacement and all state on disposal', () => {
    const f = fixture();
    const grant = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const permit = f.authority.requireRead(f.context, grant, target);
    f.authority.policyChangedFromHost();
    expect(permit.signal.aborted).toBe(true);
    expect(() => f.authority.requireRead(f.context, grant, target)).toThrow('READ_DENIED');
    const fresh = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    f.authority.dispose();
    expect(() => f.authority.requireRead(f.context, fresh, target)).toThrow('READ_DENIED');
    expect(() => f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 })).toThrow('READ_DENIED');
  });

  it('invalidates every old grant before synchronous abort listeners can reenter the registry', () => {
    const f = fixture();
    const first = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const second = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const permit = f.authority.requireRead(f.context, first, target);
    let reentrantReadAllowed = false;
    permit.signal.addEventListener('abort', () => {
      try { f.authority.requireRead(f.context, second, target); reentrantReadAllowed = true; }
      catch { /* A policy replacement must already deny every old grant here. */ }
    });
    f.authority.policyChangedFromHost();
    expect(reentrantReadAllowed).toBe(false);
  });

  it('does not mint a grant from a stale request if expiry cleanup reenters policy replacement', () => {
    const f = fixture();
    const first = f.authority.grantFromHost(f.context, target, { ttlMs: 5000 });
    const permit = f.authority.requireRead(f.context, first, target);
    permit.signal.addEventListener('abort', () => f.authority.policyChangedFromHost());
    f.advance(5000);
    expect(() => f.authority.grantFromHost(f.context, target, { ttlMs: 5000 })).toThrow('READ_DENIED');
    f.authority.dispose();
  });

  it('propagates caller cancellation to the permit but does not let it revoke a distinct later caller', () => {
    const f = fixture();
    const abort = new AbortController();
    const current = { ...f.context, signal: abort.signal };
    const grant = f.authority.grantFromHost(current, target, { ttlMs: 30_000 });
    const permit = f.authority.requireRead(current, grant, target);
    abort.abort();
    expect(permit.signal.aborted).toBe(true);
    expect(() => f.authority.requireRead(current, grant, target)).toThrow('CANCELLED');
    expect(f.authority.requireRead(f.context, grant, target).signal.aborted).toBe(false);
  });

  it('keeps target snapshots isolated from edits to grant inputs and permit outputs', () => {
    const f = fixture();
    const mutable = { ...target };
    const grant = f.authority.grantFromHost(f.context, mutable, { ttlMs: 30_000 });
    mutable.pid = 42;
    const permit = f.authority.requireRead(f.context, grant, target);
    permit.target.pid = 43;
    expect(f.authority.requireRead(f.context, grant, target).target.pid).toBe(41);
  });

  it('bounds live grants and reclaims expired entries without extending old grant IDs', () => {
    let now = 100;
    const authority = new module.FixtureReadAuthority({ monotonicMs: () => now, maxGrants: 1 });
    const context = host();
    const first = authority.grantFromHost(context, target, { ttlMs: 5000 });
    expect(() => authority.grantFromHost(context, target, { ttlMs: 5000 })).toThrow('READ_CAPACITY');
    now += 5000;
    const next = authority.grantFromHost(context, target, { ttlMs: 5000 });
    expect(next).not.toBe(first);
    expect(() => authority.requireRead(context, first, target)).toThrow('READ_DENIED');
  });

  it('revokes all permits if the clock regresses or throws, without echoing the clock error', () => {
    const f = fixture();
    const grant = f.authority.grantFromHost(f.context, target, { ttlMs: 30_000 });
    const permit = f.authority.requireRead(f.context, grant, target);
    f.regress();
    expect(() => f.authority.requireRead(f.context, grant, target)).toThrow('CLOCK_UNAVAILABLE');
    expect(permit.signal.aborted).toBe(true);
    const broken = new module.FixtureReadAuthority({ monotonicMs: () => { throw new Error('private-fixture-value'); } });
    expect(() => broken.grantFromHost(f.context, target, { ttlMs: 30_000 })).toThrow('CLOCK_UNAVAILABLE');
  });

  it.each([0, 4999, 600_001, Number.NaN])('rejects an unbounded or invalid host grant TTL %s', (ttlMs) => {
    const f = fixture();
    expect(() => f.authority.grantFromHost(f.context, target, { ttlMs })).toThrow('INVALID_REQUEST');
  });
});
