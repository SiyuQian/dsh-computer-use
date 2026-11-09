import { mkdtemp, mkdir, readFile, realpath, rm, lstat, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';

import * as module from '../../src/coordinator/action-ledger.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const actual = await realpath(directory);
    if (!actual.startsWith(join(await realpath(tmpdir()), 'cu-action-ledger-'))) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(actual, { recursive: true });
  }
});
async function directory() {
  const value = await realpath(await mkdtemp(join(tmpdir(), 'cu-action-ledger-')));
  directories.push(value);
  return value;
}
function host(): HostContext {
  return {
    owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    lifetime: Object.freeze({}), workspace: '/tmp/cu-ledger-fixture', signal: new AbortController().signal, turn: 1, callId: 'call_fixture',
  };
}
function proposal() {
  return {
    taskLeaseId: 'lease_fixture', observationId: 'obs_fixture',
    target: { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' },
    action: { kind: 'set_value', targetHandle: 'text_fixture', value: 'private-fixture-value' },
    mode: 'background', policyVersion: 'policy_fixture', revocationVersion: 0, materialContext: 'context_fixture',
  };
}
const completed = { execution: 'completed', effect: 'unverified', taskOutcome: 'not_evaluated' };

describe('CU-011a: inert durable action binding and conservative replay rejection', () => {
  it('creates signed bounded IDs, durably seals one dispatch transition and returns an existing terminal without another transition', async () => {
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      expect(prepared.actionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      expect(prepared).toMatchObject({ state: 'prepared', dispatchable: false });
      expect(await ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).toMatchObject({ state: 'dispatch_pending', firstTransition: true, dispatchable: false });
      expect(await ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).toMatchObject({ state: 'dispatch_pending', firstTransition: false });
      await ledger.finishFromHost(context, prepared.actionId, completed);
      expect(await ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).toMatchObject({ state: 'terminal', firstTransition: false, summary: completed });
      const disk = await readFile(join(path, 'actions.journal'), 'utf8');
      expect(disk.split('\n').filter(Boolean)).toHaveLength(3);
      for (const value of ['private-fixture-value', '/tmp/cu-ledger-fixture', 'session_fixture', 'window_fixture', 'text_fixture']) expect(disk.includes(value)).toBe(false);
      expect((await lstat(join(path, 'actions.journal'))).mode & 0o777).toBe(0o600);
    } finally { await ledger.close(); }
  });

  it('has one winner for two concurrent attempts before persistent sealing completes', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory() });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      const results = await Promise.all([1, 2].map(() => ledger.beginDispatchFromHost(context, prepared.actionId, proposal())));
      expect(results.filter((result) => result.firstTransition)).toHaveLength(1);
      expect(results.every((result) => result.state === 'dispatch_pending')).toBe(true);
    } finally { await ledger.close(); }
  });

  it.each(['input', 'target', 'lease', 'observation', 'policy', 'context'])('rejects a changed %s proposal for the same signed ID without another journal event', async (field) => {
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      const changed = proposal();
      if (field === 'input') changed.action.value = 'another-fixture-value';
      if (field === 'target') changed.target.windowInstance = 'window_other';
      if (field === 'lease') changed.taskLeaseId = 'lease_other';
      if (field === 'observation') changed.observationId = 'obs_other';
      if (field === 'policy') changed.policyVersion = 'policy_next';
      if (field === 'context') changed.materialContext = 'context_next';
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, changed)).rejects.toThrow('ACTION_ID_CONFLICT');
      expect((await readFile(join(path, 'actions.journal'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
    } finally { await ledger.close(); }
  });

  it.each(['lifetime', 'workspace', 'generation'])('refuses a changed host %s and forged or modified action IDs', async (field) => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory() });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      const other = { ...context, owner: { ...context.owner } };
      if (field === 'lifetime') other.lifetime = Object.freeze({});
      if (field === 'workspace') other.workspace = '/tmp/other-workspace';
      if (field === 'generation') other.owner.generation = 'generation_other';
      await expect(ledger.beginDispatchFromHost(other, prepared.actionId, proposal())).rejects.toThrow('ACTION_UNAVAILABLE');
      await expect(ledger.beginDispatchFromHost(context, 'action_model_approved', proposal())).rejects.toThrow('ACTION_UNAVAILABLE');
      const tampered = `${prepared.actionId.slice(0, -1)}${prepared.actionId.endsWith('a') ? 'b' : 'a'}`;
      await expect(ledger.beginDispatchFromHost(context, tampered, proposal())).rejects.toThrow('ACTION_UNAVAILABLE');
      expect((await ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).firstTransition).toBe(true);
    } finally { await ledger.close(); }
  });

  it('keeps expiry monotonic and never extends a signed ID by polling or wall clock movement', async () => {
    let mono = 100; let wall = 1_800_000_000_000;
    const ledger = await module.DurableActionLedger.create({ directory: await directory(), monotonicMs: () => mono, wallTimeMs: () => wall, ttlMs: 5000 });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      mono += 4999; wall += 100_000;
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('ACTION_UNAVAILABLE');
      mono += 1;
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('ACTION_UNAVAILABLE');
    } finally { await ledger.close(); }
  });

  it('recovers pending work as unknown and prepared work as replay-rejected, never as a dispatch permit', async () => {
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path });
    const context = host();
    const one = await ledger.prepareFromHost(context, proposal());
    await ledger.beginDispatchFromHost(context, one.actionId, proposal());
    const two = await ledger.prepareFromHost(context, proposal());
    await ledger.close();
    const recovered = await module.recoverActionJournalFromHost(path);
    expect(recovered).toMatchObject({ dispatchable: false, truncatedTail: false });
    expect(recovered.actions).toEqual([
      { actionId: one.actionId, state: 'unknown', dispatchable: false },
      { actionId: two.actionId, state: 'replay_rejected', dispatchable: false },
    ]);
    await expect(module.DurableActionLedger.create({ directory: path })).rejects.toThrow('LEDGER_UNAVAILABLE');
  });

  it('retains host-reported terminal summaries on recovery without claiming independent evidence', async () => {
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path });
    const context = host();
    const prepared = await ledger.prepareFromHost(context, proposal());
    await ledger.beginDispatchFromHost(context, prepared.actionId, proposal());
    await ledger.finishFromHost(context, prepared.actionId, completed);
    await ledger.close();
    expect((await module.recoverActionJournalFromHost(path)).actions).toEqual([{ actionId: prepared.actionId, state: 'terminal', summary: completed, dispatchable: false }]);
  });

  it('rejects malicious shape and refuses unsupported verified or retroactively not-executed summaries', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory() });
    const context = host();
    try {
      await expect(ledger.prepareFromHost(context, { ...proposal(), approved: true })).rejects.toThrow('INVALID_REQUEST');
      const prepared = await ledger.prepareFromHost(context, proposal());
      await expect(ledger.finishFromHost(context, prepared.actionId, completed)).rejects.toThrow('ACTION_STATE_INVALID');
      await ledger.beginDispatchFromHost(context, prepared.actionId, proposal());
      await expect(ledger.finishFromHost(context, prepared.actionId, { ...completed, effect: 'verified' })).rejects.toThrow('INVALID_REQUEST');
      await expect(ledger.finishFromHost(context, prepared.actionId, { ...completed, execution: 'not_executed' })).rejects.toThrow('ACTION_STATE_INVALID');
      await ledger.finishFromHost(context, prepared.actionId, { execution: 'unknown', effect: 'unknown', taskOutcome: 'not_evaluated' });
      await expect(ledger.finishFromHost(context, prepared.actionId, completed)).rejects.toThrow('ACTION_ID_CONFLICT');
    } finally { await ledger.close(); }
  });

  it('never reports an unknown execution result as no-change or a newly proven effect', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory() });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      await ledger.beginDispatchFromHost(context, prepared.actionId, proposal());
      await expect(ledger.finishFromHost(context, prepared.actionId, { execution: 'unknown', effect: 'no_change_observed', taskOutcome: 'not_evaluated' })).rejects.toThrow('INVALID_REQUEST');
      await expect(ledger.finishFromHost(context, prepared.actionId, { execution: 'unknown', effect: 'unverified', taskOutcome: 'not_evaluated' })).rejects.toThrow('INVALID_REQUEST');
    } finally { await ledger.close(); }
  });

  it('expires exactly at its monotonic deadline even when wall time remains constant', async () => {
    let mono = 100;
    const ledger = await module.DurableActionLedger.create({ directory: await directory(), monotonicMs: () => mono, wallTimeMs: () => 1_800_000_000_000, ttlMs: 5000 });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      mono = 5100;
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('ACTION_UNAVAILABLE');
    } finally { await ledger.close(); }
  });

  it('poisons every old ID on clock regression or exception without exposing source messages', async () => {
    let mono = 100;
    const ledger = await module.DurableActionLedger.create({ directory: await directory(), monotonicMs: () => {
      if (mono === -1) throw new Error('private-fixture-value');
      return mono;
    } });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      mono = 99;
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('CLOCK_UNAVAILABLE');
      mono = 100;
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('LEDGER_UNAVAILABLE');
    } finally { await ledger.close(); }
    const broken = await module.DurableActionLedger.create({ directory: await directory(), monotonicMs: () => { throw new Error('private-fixture-value'); } });
    try { await expect(broken.prepareFromHost(context, proposal())).rejects.toThrow('CLOCK_UNAVAILABLE'); }
    finally { await broken.close(); }
  });

  it('isolates a captured proposal from caller edits while waiting behind durable work', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory() });
    const context = host();
    try {
      const source = proposal();
      const captured = ledger.prepareFromHost(context, source);
      source.action.value = 'caller-edited-fixture';
      const prepared = await captured;
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, source)).rejects.toThrow('ACTION_ID_CONFLICT');
      expect((await ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).firstTransition).toBe(true);
    } finally { await ledger.close(); }
  });

  it('does not revive a prepared ID after the caller was cancelled before durable dispatch sealing', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory() });
    const controller = new AbortController();
    const context = { ...host(), signal: controller.signal };
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      controller.abort();
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('CANCELLED');
    } finally { await ledger.close(); }
  });

  it('cannot revive a cancelled prepared action by replacing its host call signal', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory() });
    const abort = new AbortController();
    const context = { ...host(), signal: abort.signal };
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      abort.abort();
      await expect(ledger.beginDispatchFromHost({ ...context, signal: new AbortController().signal }, prepared.actionId, proposal())).rejects.toThrow('ACTION_UNAVAILABLE');
    } finally { await ledger.close(); }
  });

  it('treats a partially written trailing record as incomplete history without authorizing replay', async () => {
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path });
    const context = host();
    const prepared = await ledger.prepareFromHost(context, proposal());
    await ledger.beginDispatchFromHost(context, prepared.actionId, proposal());
    await ledger.close();
    const journal = join(path, 'actions.journal');
    const source = await readFile(journal, 'utf8');
    await writeFile(journal, `${source}{"partial":`, { mode: 0o600 });
    const recovered = await module.recoverActionJournalFromHost(path);
    expect(recovered.truncatedTail).toBe(true);
    expect(recovered.actions).toEqual([{ actionId: prepared.actionId, state: 'unknown', dispatchable: false }]);
  });

  it.each(['corrupt', 'duplicate', 'out_of_order', 'symlink', 'mode'])('rejects %s recovery records rather than granting a recovery path', async (fault) => {
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path });
    const prepared = await ledger.prepareFromHost(host(), proposal());
    await ledger.close();
    const journal = join(path, 'actions.journal');
    const source = await readFile(journal, 'utf8');
    if (fault === 'corrupt') await writeFile(journal, source.replace('"state":"prepared"', '"state":"terminal"'), { mode: 0o600 });
    if (fault === 'duplicate') await writeFile(journal, source + source, { mode: 0o600 });
    if (fault === 'out_of_order') await writeFile(journal, source.replace('"seq":1', '"seq":2'), { mode: 0o600 });
    if (fault === 'mode') await chmod(journal, 0o644);
    if (fault === 'symlink') {
      const exact = await realpath(journal); expect(exact).toBe(journal);
      await rm(exact); // Intentional replacement of this test-owned journal to exercise O_NOFOLLOW.
      const actual = join(path, 'actual'); await writeFile(actual, source, { mode: 0o600 }); await symlink(actual, journal);
    }
    await expect(module.recoverActionJournalFromHost(path)).rejects.toThrow('LEDGER_UNAVAILABLE');
    expect(prepared.dispatchable).toBe(false);
  });

  it.each(['expired', 'cancelled'])('records known terminal facts after the dispatch ID is %s, without allowing another dispatch', async (failure) => {
    let mono = 100;
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path, monotonicMs: () => mono, wallTimeMs: () => 1_800_000_000_000, ttlMs: 5000 });
    const abort = new AbortController();
    const context = { ...host(), signal: abort.signal };
    const prepared = await ledger.prepareFromHost(context, proposal());
    await ledger.beginDispatchFromHost(context, prepared.actionId, proposal());
    if (failure === 'expired') mono += 5000;
    else abort.abort();
    try {
      expect(await ledger.finishFromHost(context, prepared.actionId, completed)).toMatchObject({ state: 'terminal', summary: completed });
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow(failure === 'expired' ? 'ACTION_UNAVAILABLE' : 'CANCELLED');
    } finally { await ledger.close(); }
    expect((await module.recoverActionJournalFromHost(path)).actions[0]).toMatchObject({ state: 'terminal', summary: completed });
  });

  it('bounds queued journal operations instead of retaining an unbounded set of concurrent proposals', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory() });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      const admitted = Array.from({ length: 64 }, () => ledger.beginDispatchFromHost(context, prepared.actionId, proposal()));
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('LEDGER_CAPACITY');
      const results = await Promise.all(admitted);
      expect(results.filter((result) => result.firstTransition)).toHaveLength(1);
    } finally { await ledger.close(); }
  });

  it('never reopens an expired ID from a newer journal or a concurrent writer in the same directory', async () => {
    const firstPath = await directory();
    const secondPath = await directory();
    const first = await module.DurableActionLedger.create({ directory: firstPath });
    const second = await module.DurableActionLedger.create({ directory: secondPath });
    const context = host();
    try {
      const prepared = await first.prepareFromHost(context, proposal());
      await expect(module.DurableActionLedger.create({ directory: firstPath })).rejects.toThrow('LEDGER_UNAVAILABLE');
      await expect(second.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('ACTION_UNAVAILABLE');
    } finally { await first.close(); await second.close(); }
  });

  it('bounds action records without silently evicting replay tombstones', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory(), maxActions: 1 });
    const context = host();
    try {
      await ledger.prepareFromHost(context, proposal());
      await expect(ledger.prepareFromHost(context, proposal())).rejects.toThrow('LEDGER_CAPACITY');
    } finally { await ledger.close(); }
  });

  it('fails closed on journal path replacement and poisons the writer instead of dispatching or retrying', async () => {
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path });
    const context = host();
    try {
      const prepared = await ledger.prepareFromHost(context, proposal());
      const journal = join(path, 'actions.journal');
      expect(await realpath(journal)).toBe(journal);
      await rm(journal); // Intentional fault on the exact verified file owned by this test.
      await writeFile(journal, '', { mode: 0o600 });
      await expect(ledger.beginDispatchFromHost(context, prepared.actionId, proposal())).rejects.toThrow('LEDGER_UNAVAILABLE');
      await expect(ledger.prepareFromHost(context, proposal())).rejects.toThrow('LEDGER_UNAVAILABLE');
    } finally { await ledger.close(); }
  });

  it.each(['directory_mode', 'symlink', 'existing'])('rejects a %s namespace or journal without repairing it', async (fault) => {
    const path = await directory();
    if (fault === 'directory_mode') await chmod(path, 0o755);
    if (fault === 'existing') await writeFile(join(path, 'actions.journal'), '', { mode: 0o600 });
    if (fault === 'symlink') {
      const actual = join(path, 'actual'); await mkdir(actual, { mode: 0o700 });
      await symlink(actual, join(path, 'alias'));
      await expect(module.DurableActionLedger.create({ directory: join(path, 'alias') })).rejects.toThrow('LEDGER_UNAVAILABLE');
    } else await expect(module.DurableActionLedger.create({ directory: path })).rejects.toThrow('LEDGER_UNAVAILABLE');
  });
});

describe('review #2: ledger lifetime capacity is reported before dispatch and never loses a terminal fact', () => {
  it('reports no capacity once the record bound is reached, without poisoning the writer', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory(), maxActions: 1 });
    const context = host();
    try {
      expect(ledger.hasCapacityFromHost()).toBe(true);
      const prepared = await ledger.prepareFromHost(context, proposal());
      expect(ledger.hasCapacityFromHost()).toBe(false);
      await ledger.beginDispatchFromHost(context, prepared.actionId, proposal());
      expect(await ledger.finishFromHost(context, prepared.actionId, completed)).toMatchObject({ state: 'terminal' });
    } finally { await ledger.close(); }
  });

  it('reserves journal room for a whole action so a terminal record is never refused by the sequence bound', async () => {
    const ledger = await module.DurableActionLedger.create({ directory: await directory(), maxActions: 256 });
    const context = host();
    try {
      let completedActions = 0;
      while (ledger.hasCapacityFromHost()) {
        const prepared = await ledger.prepareFromHost(context, proposal());
        await ledger.beginDispatchFromHost(context, prepared.actionId, proposal());
        await ledger.finishFromHost(context, prepared.actionId, completed);
        completedActions += 1;
      }
      expect(completedActions).toBe(256);
      await expect(ledger.prepareFromHost(context, proposal())).rejects.toThrow('LEDGER_CAPACITY');
      expect(ledger.hasCapacityFromHost()).toBe(false);
    } finally { await ledger.close(); }
  }, 60_000);

  it('reports no capacity after the writer is poisoned', async () => {
    const path = await directory();
    const ledger = await module.DurableActionLedger.create({ directory: path });
    try {
      await rm(join(path, 'actions.journal')); // Intentional fault on the exact file owned by this test.
      await expect(ledger.prepareFromHost(host(), proposal())).rejects.toThrow('LEDGER_UNAVAILABLE');
      expect(ledger.hasCapacityFromHost()).toBe(false);
    } finally { await ledger.close().catch(() => {}); }
  });
});
