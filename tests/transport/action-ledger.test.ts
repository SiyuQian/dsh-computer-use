import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverActionJournalFromHost } from '../../src/coordinator/action-ledger.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const actual = await realpath(directory);
    if (!actual.startsWith(join(await realpath(tmpdir()), 'cu-ledger-process-'))) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(actual, { recursive: true });
  }
});
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'cu-ledger-process-')));
  directories.push(path); return path;
}
const probe = resolve('tests/support/action-ledger-probe.mjs');
describe('CU-011a: real disk/process dispatch boundary faults without native work', () => {
  it.each(['prepared', 'dispatch_pending', 'terminal'])('does not recover a new dispatch permission after SIGKILL at %s', async (phase) => {
    const path = await directory();
    const child = spawn(process.execPath, [probe, path, phase], { stdio: ['pipe', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); });
    const lines = createInterface({ input: child.stdout });
    try {
      const ready = await lines[Symbol.asyncIterator]().next();
      expect(ready.done, error).toBe(false);
      expect(JSON.parse(ready.value!)).toMatchObject({ state: phase, dispatchable: false });
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
      expect(child.signalCode).toBe('SIGKILL');
      const recovered = await recoverActionJournalFromHost(path);
      expect(recovered.actions).toHaveLength(1);
      expect(recovered.actions[0]).toMatchObject({ state: phase === 'prepared' ? 'replay_rejected' : phase === 'dispatch_pending' ? 'unknown' : 'terminal', dispatchable: false });
      expect((await readFile(join(path, 'actions.journal'), 'utf8')).includes('private-fixture-value')).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
      lines.close();
    }
  });

  it.each(['write_fail', 'zero_write', 'sync_fail', 'terminal_sync_fail'])('fails closed after %s without handing off or repeating work', async (fault) => {
    const path = await directory();
    const result = spawnSync(process.execPath, [probe, path, fault], { encoding: 'utf8', timeout: 4000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    const outcome = JSON.parse(result.stdout);
    expect(outcome).toEqual({ rejected: true, handoffs: fault === 'terminal_sync_fail' ? 1 : 0, poisoned: true, dispatchable: false });
    expect(result.stderr.includes('private-fixture-value') || result.stdout.includes('private-fixture-value')).toBe(false);
  });

  it.each(['expire_after_sync', 'cancel_after_sync'])('refuses a first handoff when %s occurs during durable sealing', async (fault) => {
    const path = await directory();
    const result = spawnSync(process.execPath, [probe, path, fault], { encoding: 'utf8', timeout: 4000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rejected: true, handoffs: 0, dispatchable: false });
    expect((await recoverActionJournalFromHost(path)).actions[0]).toMatchObject({ state: 'unknown', dispatchable: false });
  });

  it('closes both owned handles even when one close reports failure and never exposes the native detail', async () => {
    const result = spawnSync(process.execPath, [probe, await directory(), 'close_fail'], { encoding: 'utf8', timeout: 4000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ fileCloseAttempts: 1, parentCloseAttempts: 1, fixedErrors: 2, dispatchable: false });
    expect(result.stdout.includes('private-fixture-value') || result.stderr.includes('private-fixture-value')).toBe(false);
  });

  it('returns a fixed recovery error when a read handle close reports native details', async () => {
    const result = spawnSync(process.execPath, [probe, await directory(), 'recovery_close_fail'], { encoding: 'utf8', timeout: 4000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rejected: true, dispatchable: false });
    expect(result.stdout.includes('private-fixture-value') || result.stderr.includes('private-fixture-value')).toBe(false);
  });

  it('does not publish an action when directory fsync fails while creating its journal', async () => {
    const path = await directory();
    const result = spawnSync(process.execPath, [probe, path, 'directory_sync_fail'], { encoding: 'utf8', timeout: 4000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rejected: true, handoffs: 0, dispatchable: false });
    expect((await recoverActionJournalFromHost(path)).actions).toHaveLength(0);
  });

  it('does not hand off on a partial pending write followed by failure, and recovers only a replay-rejected prepare', async () => {
    const path = await directory();
    const result = spawnSync(process.execPath, [probe, path, 'partial_write_fail'], { encoding: 'utf8', timeout: 4000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rejected: true, handoffs: 0, poisoned: true, dispatchable: false });
    const recovered = await recoverActionJournalFromHost(path);
    expect(recovered.truncatedTail).toBe(true);
    expect(recovered.actions[0]).toMatchObject({ state: 'replay_rejected', dispatchable: false });
  });

  it('retries a short filesystem write only to finish the same record, not to hand off a second action', async () => {
    const result = spawnSync(process.execPath, [probe, await directory(), 'short_write'], { encoding: 'utf8', timeout: 4000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ handoffs: 1, shortWrites: true, dispatchable: false });
  });
});
