import { beforeAll, describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';

type Module = typeof import('../../src/policy/approvals.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/policy/approvals.js';
  module = await import(path);
});
function host(): HostContext {
  return {
    owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    lifetime: Object.freeze({}), workspace: '/tmp/cu-approval-fixture', signal: new AbortController().signal, turn: 1, callId: 'call_fixture',
  };
}
function envelope() {
  return {
    actionId: 'action_fixture', leaseId: 'lease_fixture', observationId: 'observation_fixture',
    target: { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' },
    action: { kind: 'set_value', targetHandle: 'text_fixture', value: 'private-fixture-value' },
    mode: 'background', policyVersion: 'policy_fixture', revocationVersion: 0,
    materialContext: 'context_fixture', riskReason: 'unclassified_effect',
  };
}
function fixture() {
  let now = 100;
  const approvals = new module.SingleUseApprovals({ monotonicMs: () => now });
  const context = host();
  return { approvals, context, advance: (ms: number) => { now += ms; }, regress: () => { now = 99; } };
}

describe('CU-009a: host-only exact single-use approval binding', () => {
  it('binds a host decision to the full envelope and consumes a mismatched decision ticket permanently', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope()); expect(f.approvals.decideBoundFromHost).toBeTypeOf('function');
      expect(() => f.approvals.decideBoundFromHost(f.context, pending.approvalId, { ...envelope(), actionId: 'action_other' }, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
      expect(() => f.approvals.decideBoundFromHost(f.context, pending.approvalId, envelope(), 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
      const fresh = f.approvals.prepare(f.context, envelope());
      f.approvals.decideBoundFromHost(f.context, fresh.approvalId, envelope(), 'allowed-once');
      expect(f.approvals.consume(f.context, fresh.approvalId, envelope()).dispatchable).toBe(false);
    } finally { f.approvals.dispose(); }
  });

  it('invalidates only an exact scope even after cancellation and supports discarding a failed publication', () => {
    const f = fixture(); const other = { ...f.context, lifetime: Object.freeze({}) };
    try {
      const first = f.approvals.prepare(f.context, envelope()); const second = f.approvals.prepare(other, envelope());
      expect(f.approvals.invalidateScopeFromHost).toBeTypeOf('function'); expect(f.approvals.discardFromHost).toBeTypeOf('function');
      f.approvals.invalidateScopeFromHost({ ...f.context, signal: AbortSignal.abort() });
      expect(() => f.approvals.decideFromHost(f.context, first.approvalId, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
      f.approvals.decideBoundFromHost(other, second.approvalId, envelope(), 'allowed-once');
      expect(f.approvals.consume(other, second.approvalId, envelope()).status).toBe('consumed');
      const discarded = f.approvals.prepare(f.context, envelope()); f.approvals.discardFromHost(f.context, discarded.approvalId);
      expect(() => f.approvals.decideFromHost(f.context, discarded.approvalId, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('binds the explicit raise-risk input even if the derived risk reason stays unclassified', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, { ...envelope(), raiseRisk: false });
      f.approvals.decideBoundFromHost(f.context, pending.approvalId, { ...envelope(), raiseRisk: false }, 'allowed-once');
      expect(() => f.approvals.consume(f.context, pending.approvalId, { ...envelope(), raiseRisk: true })).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('cannot prepare after an envelope getter invalidates or disposes the registry', () => {
    const f = fixture();
    try {
      const raw = { ...envelope(), get target() { f.approvals.invalidateFromHost(); return envelope().target; } };
      expect(() => f.approvals.prepare(f.context, raw)).toThrow('APPROVAL_INVALIDATED');
      const disposing = { ...envelope(), get target() { f.approvals.dispose(); return envelope().target; } };
      expect(() => f.approvals.prepare(f.context, disposing)).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('lets exact-ticket discard cancel a consume that has already started validating its envelope', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      f.approvals.decideBoundFromHost(f.context, pending.approvalId, envelope(), 'allowed-once');
      const raw = { ...envelope(), get target() { f.approvals.discardFromHost(f.context, pending.approvalId); return envelope().target; } };
      expect(() => f.approvals.consume(f.context, pending.approvalId, raw)).toThrow('APPROVAL_INVALIDATED');
      expect(() => f.approvals.consume(f.context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('does not admit a recursive consume while the original record remains visible for revocation', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope()); f.approvals.decideBoundFromHost(f.context, pending.approvalId, envelope(), 'allowed-once');
      const raw = { ...envelope(), get target() { expect(() => f.approvals.consume(f.context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED'); return envelope().target; } };
      expect(f.approvals.consume(f.context, pending.approvalId, raw).status).toBe('consumed');
    } finally { f.approvals.dispose(); }
  });

  it('does not consume an approved record after an envelope getter invalidates the registry', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope()); f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      const raw = { ...envelope(), get target() { f.approvals.invalidateFromHost(); return envelope().target; } };
      expect(() => f.approvals.consume(f.context, pending.approvalId, raw)).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it.each(['prepare', 'consume', 'decide'] as const)('does not finish %s after a clock callback synchronously invalidates the registry', (phase) => {
    const context = host(); let invalidate = false;
    const approvals = new module.SingleUseApprovals({ monotonicMs: () => { if (invalidate) { invalidate = false; approvals.invalidateFromHost(); } return 100; } });
    try {
      const pending = approvals.prepare(context, envelope());
      if (phase === 'consume') approvals.decideFromHost(context, pending.approvalId, 'allowed-once');
      invalidate = true;
      expect(() => {
        if (phase === 'prepare') approvals.prepare(context, envelope());
        if (phase === 'consume') approvals.consume(context, pending.approvalId, envelope());
        if (phase === 'decide') approvals.decideBoundFromHost(context, pending.approvalId, envelope(), 'allowed-once');
      }).toThrow('APPROVAL_INVALIDATED');
    } finally { approvals.dispose(); }
  });

  it('returns only a safe summary and does not accept a pending approval as authorization', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      expect(pending).toMatchObject({ approvalId: expect.stringMatching(/^approval_/), summary: {
        operation: 'set_value', inputLength: 21, pid: 41, windowId: 7, mode: 'background',
        actionId: 'action_fixture', leaseId: 'lease_fixture', observationId: 'observation_fixture',
        targetHandle: 'text_fixture', processStart: 'process_fixture', windowKey: 'primary',
        windowInstance: 'window_fixture', riskReason: 'unclassified_effect',
      } });
      expect(JSON.stringify(pending)).not.toContain('private-fixture-value');
      expect(pending).not.toHaveProperty('fingerprint');
      expect(() => f.approvals.consume(f.context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('consumes exactly once only after an allowed-once host decision', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      expect(f.approvals.consume(f.context, pending.approvalId, envelope())).toEqual({ status: 'consumed', dispatchable: false });
      expect(() => f.approvals.consume(f.context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
      expect(() => f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('has only one winner when two callers consume the same approved envelope in one turn', async () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      const attempts = await Promise.allSettled([1, 2].map(() => Promise.resolve().then(() => f.approvals.consume(f.context, pending.approvalId, envelope()))));
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    } finally { f.approvals.dispose(); }
  });

  it.each(['rejected', 'cancelled', 'unavailable'])('never authorizes a host %s outcome or accepts a late allowed-once answer', (outcome) => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      f.approvals.decideFromHost(f.context, pending.approvalId, outcome);
      expect(() => f.approvals.consume(f.context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
      expect(() => f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it.each(['actionId', 'leaseId', 'observationId', 'target', 'handle', 'input', 'policy', 'revocation', 'material', 'risk'])('invalidates an approval after %s changes, with no return to the original envelope', (field) => {
    const f = fixture();
    try {
      const original = envelope();
      const pending = f.approvals.prepare(f.context, original);
      f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      const changed = structuredClone(original);
      if (field === 'actionId') changed.actionId = 'action_other';
      if (field === 'leaseId') changed.leaseId = 'lease_other';
      if (field === 'observationId') changed.observationId = 'observation_next';
      if (field === 'target') changed.target.windowInstance = 'window_replaced';
      if (field === 'handle') changed.action.targetHandle = 'text_other';
      if (field === 'input') changed.action.value = 'different-fixture-value';
      if (field === 'policy') changed.policyVersion = 'policy_next';
      if (field === 'revocation') changed.revocationVersion += 1;
      if (field === 'material') changed.materialContext = 'context_next';
      if (field === 'risk') changed.riskReason = 'raised_risk';
      expect(() => f.approvals.consume(f.context, pending.approvalId, changed)).toThrow('APPROVAL_INVALIDATED');
      expect(() => f.approvals.consume(f.context, pending.approvalId, original)).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('canonicalizes property order without normalizing or storing the original input', () => {
    const f = fixture();
    try {
      const original = envelope();
      const pending = f.approvals.prepare(f.context, original);
      f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      const reordered = { ...original, action: { value: original.action.value, targetHandle: original.action.targetHandle, kind: original.action.kind } };
      expect(f.approvals.consume(f.context, pending.approvalId, reordered).status).toBe('consumed');
    } finally { f.approvals.dispose(); }
  });

  it.each(['lifetime', 'workspace', 'generation'])('rejects a changed %s host context without accepting an ID-only match', (field) => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      const changed = { ...f.context, owner: { ...f.context.owner } };
      if (field === 'lifetime') changed.lifetime = Object.freeze({});
      if (field === 'workspace') changed.workspace = '/tmp/different-workspace';
      if (field === 'generation') changed.owner.generation = 'generation_next';
      expect(() => f.approvals.consume(changed, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
      expect(f.approvals.consume(f.context, pending.approvalId, envelope()).status).toBe('consumed');
    } finally { f.approvals.dispose(); }
  });

  it('permanently invalidates an old approval when the same host scope advances to another turn', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      expect(() => f.approvals.consume({ ...f.context, turn: 2 }, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
      expect(() => f.approvals.consume(f.context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('expires exactly at 60 seconds and refuses approval or consumption after expiry', () => {
    const f = fixture();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      f.advance(59_999);
      f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      f.advance(1);
      expect(() => f.approvals.consume(f.context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
      expect(() => f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
    } finally { f.approvals.dispose(); }
  });

  it('rechecks the deadline after input parsing and fingerprint comparison before consuming approval', () => {
    let reads = 0;
    const approvals = new module.SingleUseApprovals({ monotonicMs: () => [100, 100, 60_099, 60_100][reads++]! });
    const context = host();
    try {
      const pending = approvals.prepare(context, envelope());
      approvals.decideFromHost(context, pending.approvalId, 'allowed-once');
      expect(() => approvals.consume(context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
    } finally { approvals.dispose(); }
  });

  it('invalidates all pending approvals on host revocation, cancellation, clock failure or disposal', () => {
    const f = fixture();
    try {
      const one = f.approvals.prepare(f.context, envelope());
      f.approvals.invalidateFromHost();
      expect(() => f.approvals.decideFromHost(f.context, one.approvalId, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
      const two = f.approvals.prepare(f.context, envelope());
      f.regress();
      expect(() => f.approvals.decideFromHost(f.context, two.approvalId, 'allowed-once')).toThrow('CLOCK_UNAVAILABLE');
    } finally { f.approvals.dispose(); }
    expect(() => f.approvals.prepare(f.context, envelope())).toThrow('APPROVAL_INVALIDATED');
    const cancelled = fixture();
    const abort = new AbortController();
    const context = { ...cancelled.context, signal: abort.signal };
    const pending = cancelled.approvals.prepare(context, envelope());
    abort.abort();
    expect(() => cancelled.approvals.decideFromHost(cancelled.context, pending.approvalId, 'allowed-once')).toThrow('APPROVAL_INVALIDATED');
    cancelled.approvals.dispose();
  });

  it('cannot carry approvals into another registry even for identical data and host objects', () => {
    const f = fixture();
    const second = new module.SingleUseApprovals();
    try {
      const pending = f.approvals.prepare(f.context, envelope());
      f.approvals.decideFromHost(f.context, pending.approvalId, 'allowed-once');
      expect(() => second.consume(f.context, pending.approvalId, envelope())).toThrow('APPROVAL_INVALIDATED');
    } finally { second.dispose(); f.approvals.dispose(); }
  });

  it('rejects injected identity/approval fields and takeover rather than allowing summary tampering', () => {
    const f = fixture();
    try {
      for (const invalid of [
        { ...envelope(), approved: true }, { ...envelope(), mode: 'takeover' },
        { ...envelope(), owner: f.context.owner },
        { ...envelope(), action: { ...envelope().action, sensitive: false } },
      ]) expect(() => f.approvals.prepare(f.context, invalid)).toThrow('INVALID_REQUEST');
    } finally { f.approvals.dispose(); }
  });

  it('bounds pending approvals and reclaims expiry without reusing IDs', () => {
    let now = 100;
    const approvals = new module.SingleUseApprovals({ monotonicMs: () => now, maxPending: 1 });
    const context = host();
    try {
      const first = approvals.prepare(context, envelope());
      expect(() => approvals.prepare(context, envelope())).toThrow('APPROVAL_CAPACITY');
      now += 60_000;
      const next = approvals.prepare(context, envelope());
      expect(next.approvalId).not.toBe(first.approvalId);
    } finally { approvals.dispose(); }
  });
});
