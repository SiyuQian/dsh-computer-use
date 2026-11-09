import { beforeAll, describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';

type Module = typeof import('../../src/coordinator/control-queue.js');
let module: Module;
beforeAll(async () => {
  const path = '../../src/coordinator/control-queue.js';
  module = await import(path);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
function host(name = 'first') {
  const abort = new AbortController();
  const context: HostContext = {
    owner: { agentId: `session_${name}`, sessionId: `session_${name}`, generation: 'generation_fixture' },
    lifetime: Object.freeze({}), workspace: '/tmp/cu-queue-fixture', signal: abort.signal, turn: 1, callId: `call_${name}`,
  };
  return { context, abort, current: () => context };
}

describe('CU-010a: inert host serialization and stop/drain barrier', () => {
  it('invalidates an entire exact scope before any active abort observer can enqueue a sibling claim', async () => {
    const queue = new module.HostControlQueue(); const first = host(); const other = host('other');
    const one = queue.claimTargetFromHost(first.context, target); const two = queue.claimTargetFromHost(first.context, { ...target, windowId: 8 });
    const survivor = queue.claimTargetFromHost(other.context, { ...target, windowId: 9 }); const gate = deferred<number>(); let notified = false; let reentrant: Promise<unknown> | undefined;
    try {
      expect(queue.invalidateScopesFromHost).toBeTypeOf('function');
      const active = queue.enqueue(first.current, one, 'action_first', (permit) => { permit.signal.addEventListener('abort', () => {
        notified = true; expect(queue.statusFromHost().pendingCount).toBe(0);
        reentrant = queue.enqueue(first.current, two, 'action_reentry', () => 0).catch(() => 'rejected');
      }, { once: true }); return gate.promise; });
      const pending = queue.enqueue(first.current, two, 'action_second', () => 2);
      queue.invalidateScopesFromHost([{ ...first.context, signal: AbortSignal.abort() }]);
      expect(notified).toBe(true); expect(await reentrant).toBe('rejected'); expect(await pending).toEqual({ outcome: 'cancelled', workStarted: false });
      expect(await queue.waitForDrain(AbortSignal.abort())).toBe(false);
      const next = queue.enqueue(other.current, survivor, 'action_survivor', () => 3);
      gate.resolve(1); expect(await active).toEqual({ outcome: 'cancelled', workStarted: true }); expect(await next).toMatchObject({ value: 3 });
    } finally { queue.dispose(); gate.resolve(1); }
  });

  it('closes batch invalidation admission before reading a host cleanup context', () => {
    const queue = new module.HostControlQueue(); const first = host(); let notified = false;
    try {
      const context = { ...first.context, get owner() { notified = true; expect(() => queue.claimTargetFromHost(first.context, target)).toThrow('CONTROL_STOPPED'); return first.context.owner; } };
      queue.invalidateScopesFromHost([context]); expect(notified).toBe(true); expect(queue.statusFromHost().claimedTargets).toBe(0);
    } finally { queue.dispose(); }
  });

  it('keeps an invalidated active physical target reserved until settlement even though sibling claims are gone', async () => {
    const queue = new module.HostControlQueue(); const first = host(); const other = host('other'); const gate = deferred<number>();
    try {
      const claim = queue.claimTargetFromHost(first.context, target); const active = queue.enqueue(first.current, claim, 'action_active', () => gate.promise);
      queue.invalidateAllFromHost(); expect(() => queue.claimTargetFromHost(other.context, target)).toThrow('CONTROL_BUSY');
      gate.resolve(1); expect(await active).toMatchObject({ outcome: 'cancelled', workStarted: true });
      expect(queue.claimTargetFromHost(other.context, target)).toBeDefined();
    } finally { queue.dispose(); gate.resolve(1); }
  });

  it('refuses claim publication if target parsing synchronously stops the queue', () => {
    const queue = new module.HostControlQueue(); const first = host();
    try {
      const input = { ...target, get pid() { queue.stopFromHost(); return target.pid; } };
      expect(() => queue.claimTargetFromHost(first.context, input)).toThrow('CONTROL_STOPPED');
      expect(queue.statusFromHost().claimedTargets).toBe(0);
    } finally { queue.dispose(); }
  });

  it('serializes work across different owners and targets, and issues only inert scheduling permits', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const second = host('second');
    const one = queue.claimTargetFromHost(first.context, target);
    const two = queue.claimTargetFromHost(second.context, { ...target, windowId: 8, windowInstance: 'window_second', windowKey: 'secondary' });
    const gate = deferred<number>();
    const order: string[] = [];
    const a = queue.enqueue(first.current, one, 'action_first', (permit) => {
      expect(permit).toMatchObject({ dispatchable: false, kind: 'host_scheduling_only' });
      order.push('first'); return gate.promise;
    });
    const b = queue.enqueue(second.current, two, 'action_second', async () => { order.push('second'); return 2; });
    expect(order).toEqual(['first']);
    expect(queue.statusFromHost()).toEqual({ state: 'running', pendingCount: 1, claimedTargets: 2 });
    gate.resolve(1);
    expect(await a).toEqual({ outcome: 'returned', workStarted: true, value: 1 });
    expect(await b).toEqual({ outcome: 'returned', workStarted: true, value: 2 });
    expect(order).toEqual(['first', 'second']);
    queue.dispose();
  });

  it('holds an active control slot after cancellation until work actually settles', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const second = host('second');
    const claim = queue.claimTargetFromHost(first.context, target);
    const other = queue.claimTargetFromHost(second.context, { ...target, windowId: 8 });
    const gate = deferred<number>();
    let activeSignal: AbortSignal | undefined;
    let secondStarted = false;
    const a = queue.enqueue(first.current, claim, 'action_first', (permit) => { activeSignal = permit.signal; return gate.promise; });
    const b = queue.enqueue(second.current, other, 'action_second', async () => { secondStarted = true; return 2; });
    first.abort.abort();
    expect(activeSignal?.aborted).toBe(true);
    expect(secondStarted).toBe(false);
    expect(queue.statusFromHost().state).toBe('running');
    const boundedWait = new AbortController(); boundedWait.abort();
    expect(await queue.waitForDrain(boundedWait.signal)).toBe(false);
    expect(secondStarted).toBe(false);
    gate.resolve(1);
    expect(await a).toEqual({ outcome: 'cancelled', workStarted: true });
    expect(await b).toEqual({ outcome: 'returned', workStarted: true, value: 2 });
    queue.dispose();
  });

  it('cancels only queued work before it starts and reclaims its queue capacity', async () => {
    const queue = new module.HostControlQueue({ maxPending: 1 });
    const first = host();
    const queued = host('queued');
    const claim = queue.claimTargetFromHost(first.context, target);
    const next = queue.claimTargetFromHost(queued.context, { ...target, windowId: 8 });
    const gate = deferred<number>();
    const active = queue.enqueue(first.current, claim, 'action_first', () => gate.promise);
    let queuedCalls = 0;
    const pending = queue.enqueue(queued.current, next, 'action_queued', async () => { queuedCalls += 1; return 1; });
    await expect(queue.enqueue(first.current, claim, 'action_overflow', async () => 1)).rejects.toThrow('CONTROL_CAPACITY');
    queued.abort.abort();
    expect(await pending).toEqual({ outcome: 'cancelled', workStarted: false });
    const replacement = queue.enqueue(first.current, claim, 'action_replacement', async () => 2);
    gate.resolve(1);
    await active;
    expect(await replacement).toMatchObject({ outcome: 'returned', value: 2 });
    expect(queuedCalls).toBe(0);
    queue.dispose();
  });

  it('retains an active target reservation after release until work settles, without blocking unrelated owners', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const second = host('second');
    const claim = queue.claimTargetFromHost(first.context, target);
    const gate = deferred<number>();
    const active = queue.enqueue(first.current, claim, 'action_first', () => gate.promise);
    queue.releaseTargetFromHost(first.context, claim);
    expect(() => queue.claimTargetFromHost(second.context, target)).toThrow('CONTROL_BUSY');
    gate.resolve(1);
    expect(await active).toEqual({ outcome: 'cancelled', workStarted: true });
    const next = queue.claimTargetFromHost(second.context, target);
    expect((await queue.enqueue(second.current, next, 'action_second', async () => 2)).workStarted).toBe(true);
    queue.dispose();
  });

  it('rejects cloned claim tickets and claims owned by another host lifetime', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const second = host('second');
    const claim = queue.claimTargetFromHost(first.context, target);
    await expect(queue.enqueue(first.current, { ...claim }, 'action_cloned', async () => 1)).rejects.toThrow('CONTROL_CLAIM_INVALID');
    await expect(queue.enqueue(second.current, claim, 'action_foreign', async () => 1)).rejects.toThrow('CONTROL_CLAIM_INVALID');
    expect(() => queue.releaseTargetFromHost(second.context, claim)).toThrow('CONTROL_CLAIM_INVALID');
    expect(() => queue.claimTargetFromHost(second.context, target)).toThrow('CONTROL_BUSY');
    queue.dispose();
  });

  it('lets the exact host owner release a cancelled claim for cleanup, but retains its active reservation until drained', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const other = host('other');
    const claim = queue.claimTargetFromHost(first.context, target);
    const gate = deferred<number>();
    const active = queue.enqueue(first.current, claim, 'action_fixture', () => gate.promise);
    first.abort.abort();
    expect(() => queue.releaseTargetFromHost(other.context, claim)).toThrow('CONTROL_CLAIM_INVALID');
    expect(() => queue.releaseTargetFromHost(first.context, claim)).not.toThrow();
    expect(() => queue.claimTargetFromHost(other.context, target)).toThrow('CONTROL_BUSY');
    gate.resolve(1);
    await active;
    expect(() => queue.claimTargetFromHost(other.context, target)).not.toThrow();
    queue.dispose();
  });

  it('does not accept two logical window names for the same reserved physical window', () => {
    const queue = new module.HostControlQueue();
    const first = host();
    queue.claimTargetFromHost(first.context, target);
    expect(() => queue.claimTargetFromHost(first.context, { ...target, windowKey: 'secondary' })).toThrow('CONTROL_BUSY');
    queue.dispose();
  });

  it.each(['scope', 'turn', 'call', 'signal', 'throw'])('rebinds the current host before queued work starts after a %s change', async (mutation) => {
    const queue = new module.HostControlQueue();
    const first = host();
    const claim = queue.claimTargetFromHost(first.context, target);
    const gate = deferred<number>();
    const active = queue.enqueue(first.current, claim, 'action_first', () => gate.promise);
    let changed = false;
    let calls = 0;
    const current = () => {
      if (changed && mutation === 'throw') throw new Error('private-fixture-value');
      if (!changed) return first.context;
      if (mutation === 'turn') return { ...first.context, turn: 2 };
      if (mutation === 'call') return { ...first.context, callId: 'call_changed' };
      if (mutation === 'signal') return { ...first.context, signal: new AbortController().signal };
      return { ...first.context, workspace: '/tmp/changed-workspace' };
    };
    const pending = queue.enqueue(current, claim, 'action_second', async () => { calls += 1; return 2; });
    changed = true;
    gate.resolve(1);
    await active;
    expect(await pending).toEqual({ outcome: 'rejected', workStarted: false, code: 'HOST_CONTEXT_CHANGED' });
    expect(calls).toBe(0);
    queue.dispose();
  });

  it('does not start work if a host rebind synchronously stops or disposes the queue', async () => {
    for (const mutation of ['stop', 'dispose', 'release'] as const) {
      const queue = new module.HostControlQueue();
      const first = host();
      const claim = queue.claimTargetFromHost(first.context, target);
      let reads = 0;
      let calls = 0;
      const current = () => {
        reads += 1;
        if (reads === 2) {
          if (mutation === 'stop') queue.stopFromHost();
          else if (mutation === 'dispose') queue.dispose();
          else queue.releaseTargetFromHost(first.context, claim);
        }
        return first.context;
      };
      const result = await queue.enqueue(current, claim, 'action_fixture', async () => { calls += 1; return 1; });
      expect(result.workStarted).toBe(false);
      expect(calls).toBe(0);
      queue.dispose();
    }
  });

  it('does not admit an item across stop and synchronous resume during its initial host bind', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    let claim = queue.claimTargetFromHost(first.context, target);
    let calls = 0;
    const current = () => {
      queue.stopFromHost(); queue.resumeFromHost();
      claim = queue.claimTargetFromHost(first.context, target);
      return first.context;
    };
    await expect(queue.enqueue(current, claim, 'action_fixture', async () => { calls += 1; return 1; })).rejects.toThrow('CONTROL_CLAIM_INVALID');
    expect(calls).toBe(0);
    queue.dispose();
  });

  it('does not let a reentrant enqueue during host rebind start a second work item concurrently', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const claim = queue.claimTargetFromHost(first.context, target);
    const gate = deferred<number>();
    let reads = 0;
    let nested: Promise<unknown> | undefined;
    let active = 0;
    let peak = 0;
    const work = async () => { active += 1; peak = Math.max(peak, active); await gate.promise; active -= 1; return 1; };
    const current = () => {
      reads += 1;
      if (reads === 2) nested = queue.enqueue(first.current, claim, 'action_nested', work);
      return first.context;
    };
    const original = queue.enqueue(current, claim, 'action_original', work);
    gate.resolve(1);
    await original;
    await nested;
    expect(peak).toBe(1);
    queue.dispose();
  });

  it('sanitizes work failures, never retries them, and does not expose returned data after cancellation', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const claim = queue.claimTargetFromHost(first.context, target);
    let calls = 0;
    const sync = await queue.enqueue(first.current, claim, 'action_sync', () => { calls += 1; throw new Error('private-fixture-value'); });
    expect(sync).toEqual({ outcome: 'failed', workStarted: true, code: 'CONTROL_WORK_FAILED' });
    const async = await queue.enqueue(first.current, claim, 'action_async', async () => { calls += 1; throw new Error('private-fixture-value'); });
    expect(async).toEqual(sync);
    expect(calls).toBe(2);
    queue.dispose();
    await expect(queue.enqueue(first.current, claim, 'action_after_dispose', async () => 1)).rejects.toThrow('CONTROL_STOPPED');
    expect(() => queue.resumeFromHost()).toThrow('CONTROL_STOPPED');
  });

  it('keeps the stop gate closed during synchronous active abort listeners', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const claim = queue.claimTargetFromHost(first.context, target);
    const gate = deferred<number>();
    let blocked = false;
    const active = queue.enqueue(first.current, claim, 'action_fixture', (permit) => {
      permit.signal.addEventListener('abort', () => {
        try { queue.resumeFromHost(); } catch { blocked = true; }
        expect(() => queue.claimTargetFromHost(first.context, target)).toThrow('CONTROL_STOPPED');
      });
      return gate.promise;
    });
    queue.stopFromHost();
    expect(blocked).toBe(true);
    gate.resolve(1);
    await active;
    expect(queue.statusFromHost().state).toBe('paused');
    queue.dispose();
  });

  it('bounds target claims and drain waiters, and removes aborted drain waiters without unlocking active work', async () => {
    const queue = new module.HostControlQueue({ maxClaims: 1 });
    const first = host();
    const claim = queue.claimTargetFromHost(first.context, target);
    expect(() => queue.claimTargetFromHost(first.context, { ...target, windowId: 8 })).toThrow('CONTROL_CAPACITY');
    const gate = deferred<number>();
    const active = queue.enqueue(first.current, claim, 'action_fixture', () => gate.promise);
    const abort = new AbortController();
    const waiters = Array.from({ length: 256 }, () => queue.waitForDrain(abort.signal));
    await expect(queue.waitForDrain()).rejects.toThrow('CONTROL_CAPACITY');
    abort.abort();
    expect((await Promise.all(waiters)).every((result) => result === false)).toBe(true);
    expect(queue.statusFromHost().state).toBe('running');
    const valid = queue.waitForDrain();
    gate.resolve(1);
    await active;
    expect(await valid).toBe(true);
    queue.dispose();
  });

  it('rejects malformed IDs before invoking work and never admits pre-cancelled callers', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const claim = queue.claimTargetFromHost(first.context, target);
    let calls = 0;
    await expect(queue.enqueue(first.current, claim, 'bad id', async () => { calls += 1; })).rejects.toThrow('INVALID_REQUEST');
    first.abort.abort();
    expect(await queue.enqueue(first.current, claim, 'action_fixture', async () => { calls += 1; })).toEqual({ outcome: 'cancelled', workStarted: false });
    expect(calls).toBe(0);
    queue.dispose();
  });

  it('stops independently of model work, cancels queued work, and refuses resume until drain', async () => {
    const queue = new module.HostControlQueue();
    const first = host();
    const claim = queue.claimTargetFromHost(first.context, target);
    const gate = deferred<number>();
    let signal: AbortSignal | undefined;
    let queuedStarted = false;
    const a = queue.enqueue(first.current, claim, 'action_first', (permit) => { signal = permit.signal; return gate.promise; });
    const b = queue.enqueue(first.current, claim, 'action_second', async () => { queuedStarted = true; return 2; });
    queue.stopFromHost();
    expect(signal?.aborted).toBe(true);
    expect(queue.statusFromHost()).toEqual({ state: 'stopping', pendingCount: 0, claimedTargets: 0 });
    expect(await b).toEqual({ outcome: 'cancelled', workStarted: false });
    expect(queuedStarted).toBe(false);
    expect(() => queue.resumeFromHost()).toThrow('CONTROL_BUSY');
    await expect(queue.enqueue(first.current, claim, 'action_third', async () => 3)).rejects.toThrow('CONTROL_STOPPED');
    const drain = queue.waitForDrain();
    gate.resolve(1);
    expect(await a).toEqual({ outcome: 'cancelled', workStarted: true });
    expect(await drain).toBe(true);
    expect(queue.statusFromHost().state).toBe('paused');
    queue.resumeFromHost();
    await expect(queue.enqueue(first.current, claim, 'action_old_claim', async () => 1)).rejects.toThrow('CONTROL_CLAIM_INVALID');
    const fresh = queue.claimTargetFromHost(first.context, target);
    expect((await queue.enqueue(first.current, fresh, 'action_fresh', async () => 1)).workStarted).toBe(true);
    queue.dispose();
  });
});
