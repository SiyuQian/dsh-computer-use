import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';

type Module = typeof import('../../src/policy/control.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/policy/control.js';
  module = await import(path);
});
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
function spec() {
  return {
    target: { ...target }, mode: 'background', ttlMs: 600_000, idleTimeoutMs: 60_000, maxActions: 3,
    allowedOperations: ['press', 'set_value'],
    targets: [
      { handle: 'text_fixture', identifier: 'fixture.text', role: 'text-field', enabled: true, secure: false, impact: 'ordinary' },
      { handle: 'submit_fixture', identifier: 'fixture.submit', role: 'button', enabled: true, secure: false, impact: 'ordinary' },
      { handle: 'save_fixture', identifier: 'fixture.save', role: 'button', enabled: true, secure: false, impact: 'ordinary' },
      { handle: 'unknown_fixture', identifier: 'unknown', role: 'button', enabled: true, secure: false, impact: 'unknown' },
      { handle: 'high_fixture', identifier: 'fixture.submit', role: 'button', enabled: true, secure: false, impact: 'high-impact' },
      { handle: 'system_fixture', identifier: 'fixture.submit', role: 'button', enabled: true, secure: false, impact: 'system-authorization' },
      { handle: 'secure_fixture', identifier: 'fixture.secure', role: 'text-field', enabled: true, secure: true, impact: 'ordinary' },
      { handle: 'disabled_fixture', identifier: 'fixture.submit', role: 'button', enabled: false, secure: false, impact: 'ordinary' },
    ],
  };
}
function fixture() {
  let now = 100;
  const policy = new module.FixtureControlPolicy({ monotonicMs: () => now, wallTimeMs: () => Date.parse('2026-11-08T08:00:00Z') });
  const context: HostContext = {
    owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    lifetime: Object.freeze({}), workspace: '/tmp/cu-control-fixture', signal: new AbortController().signal, turn: 1, callId: 'call_fixture',
  };
  const lease = policy.issueFromHost(context, spec());
  return {
    policy, context, lease,
    advance: (ms: number) => { now += ms; },
    evaluate: (handle = 'text_fixture', approvalMode = 'request', raiseRisk = false) => policy.evaluate(context, {
      leaseId: lease.taskLeaseId, target, action: { kind: 'set_value', targetHandle: handle, value: 'public test text' }, approvalMode, raiseRisk,
    }),
    press: (handle: string, approvalMode = 'request') => policy.evaluate(context, {
      leaseId: lease.taskLeaseId, target, action: { kind: 'press', targetHandle: handle }, approvalMode,
    }),
  };
}

describe('CU-008b1: inert fixture control lease and independent risk floor', () => {
  it('removes all exact-scope leases and timers before any abort observer can read a sibling lease', () => {
    const f = fixture(); const second = f.policy.issueFromHost(f.context, spec());
    const other = { ...f.context, lifetime: Object.freeze({}) }; const survivor = f.policy.issueFromHost(other, spec());
    try {
      expect(f.policy.revokeScopeFromHost).toBeTypeOf('function');
      let notified = false;
      f.policy.signalForHost(f.context, f.lease.taskLeaseId).addEventListener('abort', () => {
        notified = true; expect(() => f.policy.getForHost(f.context, second.taskLeaseId)).toThrow('CONTROL_DENIED');
      });
      f.policy.revokeScopeFromHost({ ...f.context, signal: AbortSignal.abort() });
      expect(notified).toBe(true); expect(f.policy.getForHost(other, survivor.taskLeaseId).taskLeaseId).toBe(survivor.taskLeaseId);
    } finally { f.policy.dispose(); }
  });

  it('returns an isolated private lease target for internal claim admission without accepting a target supplied by the caller', () => {
    const f = fixture();
    try {
      expect(f.policy.fixtureTargetFromHost).toBeTypeOf('function');
      const first = f.policy.fixtureTargetFromHost(f.context, f.lease.taskLeaseId); expect(first).toEqual(target); first.windowId = 99;
      expect(f.policy.fixtureTargetFromHost(f.context, f.lease.taskLeaseId)).toEqual(target);
      f.policy.revokeScopeFromHost(f.context); expect(() => f.policy.fixtureTargetFromHost(f.context, f.lease.taskLeaseId)).toThrow('CONTROL_DENIED');
    } finally { f.policy.dispose(); }
  });

  it('issues an exact host lease but never an executable native permit', () => {
    const f = fixture();
    try {
      expect(f.lease).toMatchObject({
        owner: f.context.owner, app: { bundleId: 'dev.siyuqian.computer-use.fixture', pid: 41, processStart: 'process_fixture' },
        window: { id: 7, instance: 'window_fixture' }, mode: 'background', authorization: 'static-fixture-policy',
        issuedAt: '2026-11-08T08:00:00.000Z', expiresAt: '2026-11-08T08:10:00.000Z', maxActions: 3,
      });
      expect(f.evaluate()).toMatchObject({ decision: 'ALLOW_WITHIN_LEASE', dispatchable: false, requiresNativeRevalidation: true });
      expect(f.press('submit_fixture').decision).toBe('ALLOW_WITHIN_LEASE');
      expect(JSON.stringify(f.policy.getForHost(f.context, f.lease.taskLeaseId))).not.toContain('public test text');
    } finally { f.policy.dispose(); }
  });

  it('denies a model-created lease, ungranted handle, or widened operation allowlist', () => {
    const f = fixture();
    try {
      const forged = f.policy.evaluate(f.context, { leaseId: 'model_approved', target, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' });
      expect(forged.decision).toBe('DENY');
      expect(f.press('ungranted').decision).toBe('DENY');
      const narrow = { ...spec(), allowedOperations: ['set_value'] };
      const lease = f.policy.issueFromHost(f.context, narrow);
      expect(f.policy.evaluate(f.context, { leaseId: lease.taskLeaseId, target, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' })).toMatchObject({ decision: 'DENY', code: 'CONTROL_DENIED' });
    } finally { f.policy.dispose(); }
  });

  it.each(['save_fixture', 'unknown_fixture'])('requires approval for %s and cannot bypass approval=never', (handle) => {
    const f = fixture();
    try {
      expect(f.press(handle)).toMatchObject({ decision: 'REQUIRE_APPROVAL', code: 'APPROVAL_REQUIRED', dispatchable: false });
      expect(f.press(handle, 'never')).toMatchObject({ decision: 'DENY', code: 'APPROVAL_UNAVAILABLE' });
    } finally { f.policy.dispose(); }
  });

  it.each(['high_fixture', 'system_fixture'])('rejects %s even if its identifier looks like a harmless fixture submit', (handle) => {
    const f = fixture();
    try { expect(f.press(handle)).toMatchObject({ decision: 'DENY', code: 'CONTROL_DENIED' }); }
    finally { f.policy.dispose(); }
  });

  it('lets a model raise risk but never lower the host floor or set an approved flag', () => {
    const f = fixture();
    try {
      expect(f.evaluate('text_fixture', 'request', true).decision).toBe('REQUIRE_APPROVAL');
      expect(f.evaluate('text_fixture', 'never', true).code).toBe('APPROVAL_UNAVAILABLE');
      expect(() => f.policy.evaluate(f.context, {
        leaseId: f.lease.taskLeaseId, target, action: { kind: 'press', targetHandle: 'save_fixture', approved: true }, approvalMode: 'request',
      })).toThrow('INVALID_REQUEST');
    } finally { f.policy.dispose(); }
  });

  it('denies secure, disabled and role/action-conflicting targets regardless of descriptive labels', () => {
    const f = fixture();
    try {
      expect(f.evaluate('secure_fixture').decision).toBe('DENY');
      expect(f.press('disabled_fixture').decision).toBe('DENY');
      expect(f.evaluate('submit_fixture').decision).toBe('DENY');
      expect(f.press('text_fixture').decision).toBe('DENY');
    } finally { f.policy.dispose(); }
  });

  it('denies a known secure identifier even if a host metadata flag incorrectly says it is public', () => {
    const f = fixture();
    try {
      const metadata = spec();
      metadata.targets[0]!.identifier = 'fixture.secure';
      const lease = f.policy.issueFromHost(f.context, metadata);
      expect(f.policy.evaluate(f.context, {
        leaseId: lease.taskLeaseId, target, action: { kind: 'set_value', targetHandle: 'text_fixture', value: 'public test text' }, approvalMode: 'request',
      })).toMatchObject({ decision: 'DENY', code: 'CONTROL_DENIED' });
    } finally { f.policy.dispose(); }
  });

  it('bounds live leases and clears all scope state on clock regression without leaking clock errors', () => {
    let now = 100;
    const f = fixture();
    const policy = new module.FixtureControlPolicy({ maxLeases: 1, monotonicMs: () => now });
    try {
      const lease = policy.issueFromHost(f.context, spec());
      expect(() => policy.issueFromHost(f.context, spec())).toThrow('CONTROL_CAPACITY');
      const signal = policy.signalForHost(f.context, lease.taskLeaseId);
      now = 99;
      expect(() => policy.getForHost(f.context, lease.taskLeaseId)).toThrow('CLOCK_UNAVAILABLE');
      expect(signal.aborted).toBe(true);
      now = 100;
      expect(() => policy.getForHost(f.context, lease.taskLeaseId)).toThrow('CONTROL_DENIED');
      const broken = new module.FixtureControlPolicy({ monotonicMs: () => { throw new Error('private-fixture-value'); } });
      expect(() => broken.issueFromHost(f.context, spec())).toThrow('CLOCK_UNAVAILABLE');
      broken.dispose();
    } finally { policy.dispose(); f.policy.dispose(); }
  });

  it.each(['pid', 'processStart', 'windowKey', 'windowId', 'windowInstance'])('denies a changed %s target instead of reusing its lease', (field) => {
    const f = fixture();
    try {
      const changed: Record<string, unknown> = { ...target, [field]: field === 'pid' ? 42 : field === 'windowId' ? 8 : field === 'windowKey' ? 'secondary' : 'changed_identity' };
      expect(f.policy.evaluate(f.context, { leaseId: f.lease.taskLeaseId, target: changed, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' })).toMatchObject({ decision: 'DENY', code: 'TARGET_CHANGED' });
    } finally { f.policy.dispose(); }
  });

  it.each(['lifetime', 'workspace', 'generation'])('rejects a changed host %s scope', (field) => {
    const f = fixture();
    try {
      const changed = { ...f.context, owner: { ...f.context.owner } };
      if (field === 'lifetime') changed.lifetime = Object.freeze({});
      if (field === 'workspace') changed.workspace = '/tmp/other-workspace';
      if (field === 'generation') changed.owner.generation = 'next_generation';
      expect(f.policy.evaluate(changed, { leaseId: f.lease.taskLeaseId, target, action: { kind: 'press', targetHandle: 'submit_fixture' }, approvalMode: 'request' }).decision).toBe('DENY');
      expect(f.press('submit_fixture').decision).toBe('ALLOW_WITHIN_LEASE');
    } finally { f.policy.dispose(); }
  });

  it('does not renew idle time when a model only asks for another policy decision', () => {
    const f = fixture();
    try {
      f.advance(59_999);
      expect(f.evaluate().decision).toBe('ALLOW_WITHIN_LEASE');
      f.advance(1);
      expect(f.evaluate()).toMatchObject({ decision: 'DENY', code: 'LEASE_EXPIRED' });
    } finally { f.policy.dispose(); }
  });

  it('charges an attempt budget atomically, refreshes idle on charge, and never extends absolute TTL', () => {
    const f = fixture();
    try {
      for (let count = 0; count < 3; count += 1) {
        f.advance(59_000);
        expect(f.evaluate().decision).toBe('ALLOW_WITHIN_LEASE');
        f.policy.chargeAttemptFromHost(f.context, f.lease.taskLeaseId);
      }
      expect(f.evaluate()).toMatchObject({ decision: 'DENY', code: 'CONTROL_DENIED', reason: 'action_limit' });
      expect(() => f.policy.chargeAttemptFromHost(f.context, f.lease.taskLeaseId)).toThrow('CONTROL_DENIED');
      const short = f.policy.issueFromHost(f.context, { ...spec(), ttlMs: 5000 });
      f.advance(4999);
      f.policy.chargeAttemptFromHost(f.context, short.taskLeaseId);
      f.advance(1);
      expect(() => f.policy.getForHost(f.context, short.taskLeaseId)).toThrow('LEASE_EXPIRED');
    } finally { f.policy.dispose(); }
  });

  it('revokes and invalidates all leases on policy replacement before synchronous abort callbacks can reenter', () => {
    const f = fixture();
    try {
      const another = f.policy.issueFromHost(f.context, spec());
      const signal = f.policy.signalForHost(f.context, f.lease.taskLeaseId);
      let secondAllowed = false;
      signal.addEventListener('abort', () => {
        try { f.policy.getForHost(f.context, another.taskLeaseId); secondAllowed = true; } catch { /* All old leases must already be invalid. */ }
      });
      f.policy.policyChangedFromHost();
      expect(signal.aborted).toBe(true);
      expect(secondAllowed).toBe(false);
      expect(f.evaluate().decision).toBe('DENY');
      const fresh = f.policy.issueFromHost(f.context, spec());
      expect(fresh.policyVersion).not.toBe(f.lease.policyVersion);
      expect(fresh.revocationVersion).toBeGreaterThan(f.lease.revocationVersion);
    } finally { f.policy.dispose(); }
  });

  it('does not issue a new lease across a synchronous policy change or disposal during expiry cleanup', () => {
    for (const mutation of ['policy', 'dispose'] as const) {
      const f = fixture();
      try {
        const signal = f.policy.signalForHost(f.context, f.lease.taskLeaseId);
        signal.addEventListener('abort', () => {
          if (mutation === 'policy') f.policy.policyChangedFromHost();
          else f.policy.dispose();
        });
        f.advance(60_000);
        expect(() => f.policy.issueFromHost(f.context, spec())).toThrow('CONTROL_DENIED');
      } finally { f.policy.dispose(); }
    }
  });

  it('aborts its lease signal at the idle deadline without another lookup, and rearms it only on a charged attempt', () => {
    vi.useFakeTimers();
    const policy = new module.FixtureControlPolicy({ monotonicMs: () => Date.now() });
    const f = fixture();
    try {
      const lease = policy.issueFromHost(f.context, { ...spec(), idleTimeoutMs: 1000 });
      const signal = policy.signalForHost(f.context, lease.taskLeaseId);
      vi.advanceTimersByTime(999);
      expect(signal.aborted).toBe(false);
      policy.chargeAttemptFromHost(f.context, lease.taskLeaseId);
      vi.advanceTimersByTime(999);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(signal.aborted).toBe(true);
    } finally { policy.dispose(); f.policy.dispose(); vi.useRealTimers(); }
  });

  it('does not accept takeover, duplicate handles, extra authorization fields, or unbounded leases', () => {
    const f = fixture();
    try {
      for (const invalid of [
        { ...spec(), mode: 'takeover' }, { ...spec(), approved: true }, { ...spec(), maxActions: 101 },
        { ...spec(), targets: [spec().targets[0], spec().targets[0]] }, { ...spec(), ttlMs: 600_001 },
      ]) expect(() => f.policy.issueFromHost(f.context, invalid)).toThrow('INVALID_REQUEST');
    } finally { f.policy.dispose(); }
  });

  it('copies stored host target descriptors and lease outputs, rather than trusting later caller edits', () => {
    const f = fixture();
    try {
      const source = spec();
      const lease = f.policy.issueFromHost(f.context, source);
      source.targets[4]!.impact = 'ordinary';
      lease.allowedOperations.length = 0;
      expect(f.policy.evaluate(f.context, { leaseId: lease.taskLeaseId, target, action: { kind: 'press', targetHandle: 'high_fixture' }, approvalMode: 'request' }).decision).toBe('DENY');
      expect(f.policy.getForHost(f.context, lease.taskLeaseId).allowedOperations).toEqual(['press', 'set_value']);
    } finally { f.policy.dispose(); }
  });
});
