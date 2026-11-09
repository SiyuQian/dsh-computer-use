import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { DurableActionLedger, recoverActionJournalFromHost } from '../../lib/coordinator/action-ledger.js';

const [directory, phase] = process.argv.slice(2);
if (!directory || !phase) process.exit(2);
const cancel = new AbortController();
const context = {
  owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
  lifetime: Object.freeze({}), workspace: '/tmp/cu-ledger-fixture', signal: cancel.signal, turn: 1, callId: 'call_fixture',
};
const proposal = {
  taskLeaseId: 'lease_fixture', observationId: 'obs_fixture',
  target: { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' },
  action: { kind: 'set_value', targetHandle: 'text_fixture', value: 'private-fixture-value' },
  mode: 'background', policyVersion: 'policy_fixture', revocationVersion: 0, materialContext: 'context_fixture',
};
const summary = { execution: 'completed', effect: 'unverified', taskOutcome: 'not_evaluated' };
if (phase === 'directory_sync_fail') {
  const handle = await open(directory, 'r');
  const prototype = Object.getPrototypeOf(handle); const originalSync = prototype.sync;
  await handle.close();
  prototype.sync = async function () {
    if ((await this.stat()).isDirectory()) throw new Error('private-fixture-value');
    return originalSync.call(this);
  };
  let rejected = false;
  try { await DurableActionLedger.create({ directory }); }
  catch (error) { rejected = String(error).includes('LEDGER_UNAVAILABLE') && !String(error).includes('private-fixture-value'); }
  finally { prototype.sync = originalSync; }
  process.stdout.write(`${JSON.stringify({ rejected, handoffs: 0, dispatchable: false })}\n`);
  process.exit(0);
}
let mono = 100;
const ledger = await DurableActionLedger.create({ directory, monotonicMs: () => mono, wallTimeMs: () => 1_800_000_000_000, ttlMs: 5000 });
const prepared = await ledger.prepareFromHost(context, proposal);
if (phase === 'recovery_close_fail') {
  await ledger.close();
  const handle = await open(join(directory, 'actions.journal'), 'r');
  const originalRead = Object.getPrototypeOf(handle).readFile;
  const originalClose = handle.close.bind(handle);
  const prototype = Object.getPrototypeOf(handle);
  await originalClose();
  prototype.readFile = async function (...args) {
    const close = this.close.bind(this);
    this.close = async () => { await close(); throw new Error('private-fixture-value'); };
    return originalRead.apply(this, args);
  };
  let rejected = false;
  try { await recoverActionJournalFromHost(directory); }
  catch (error) { rejected = String(error).includes('LEDGER_UNAVAILABLE') && !String(error).includes('private-fixture-value'); }
  finally { prototype.readFile = originalRead; }
  process.stdout.write(`${JSON.stringify({ rejected, dispatchable: false })}\n`);
  process.exit(0);
}
if (['prepared', 'dispatch_pending', 'terminal'].includes(phase)) {
  if (phase !== 'prepared') await ledger.beginDispatchFromHost(context, prepared.actionId, proposal);
  if (phase === 'terminal') await ledger.finishFromHost(context, prepared.actionId, summary);
  process.stdout.write(`${JSON.stringify({ state: phase, dispatchable: false })}\n`);
  process.stdin.resume();
  process.stdin.on('end', async () => { await ledger.close(); });
} else {
  // Interpose only in the child test process. Real FileHandle I/O remains in use; no production fault hooks exist.
  const handle = await open(join(directory, 'actions.journal'), 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const originalWrite = prototype.write;
  const originalSync = prototype.sync;
  if (phase === 'close_fail') {
    const originalFileClose = ledger.file.close.bind(ledger.file);
    const originalParentClose = ledger.parent.close.bind(ledger.parent);
    let fileCloseAttempts = 0; let parentCloseAttempts = 0; let fixedErrors = 0;
    ledger.file.close = async function () {
      fileCloseAttempts += 1; await originalFileClose(); throw new Error('private-fixture-value');
    };
    ledger.parent.close = async function () { parentCloseAttempts += 1; await originalParentClose(); };
    try {
      for (let index = 0; index < 2; index += 1) {
        try { await ledger.close(); }
        catch (error) { if (String(error).includes('LEDGER_UNAVAILABLE') && !String(error).includes('private-fixture-value')) fixedErrors += 1; }
      }
    } finally {
      if (fileCloseAttempts === 0) await originalFileClose();
      if (parentCloseAttempts === 0) await originalParentClose();
    }
    process.stdout.write(`${JSON.stringify({ fileCloseAttempts, parentCloseAttempts, fixedErrors, dispatchable: false })}\n`);
    process.exit(0);
  }
  let handoffs = 0;
  let shortWrites = false;
  if (phase === 'terminal_sync_fail') {
    await ledger.beginDispatchFromHost(context, prepared.actionId, proposal); handoffs += 1;
  }
  if (phase === 'write_fail') prototype.write = async function () { throw new Error('private-fixture-value'); };
  if (phase === 'zero_write') prototype.write = async function (buffer) { return { bytesWritten: 0, buffer }; };
  if (phase === 'partial_write_fail') {
    let first = true;
    prototype.write = async function (buffer, offset, length, position) {
      if (!first) throw new Error('private-fixture-value');
      first = false;
      return originalWrite.call(this, buffer, offset, Math.min(17, length), position);
    };
  }
  if (phase === 'short_write') prototype.write = async function (buffer, offset, length, position) {
    shortWrites = true;
    return originalWrite.call(this, buffer, offset, Math.min(17, length), position);
  };
  if (phase === 'sync_fail' || phase === 'terminal_sync_fail') prototype.sync = async function () { throw new Error('private-fixture-value'); };
  if (phase === 'expire_after_sync' || phase === 'cancel_after_sync') prototype.sync = async function () {
    await originalSync.call(this);
    if (phase === 'expire_after_sync') mono += 5000;
    else cancel.abort();
  };
  let rejected = false;
  try {
    if (phase === 'terminal_sync_fail') await ledger.finishFromHost(context, prepared.actionId, summary);
    else { await ledger.beginDispatchFromHost(context, prepared.actionId, proposal); handoffs += 1; }
  } catch (error) {
    const expected = phase === 'expire_after_sync' ? 'ACTION_UNAVAILABLE' : phase === 'cancel_after_sync' ? 'CANCELLED' : 'LEDGER_UNAVAILABLE';
    rejected = String(error).includes(expected) && !String(error).includes('private-fixture-value');
  }
  prototype.write = originalWrite; prototype.sync = originalSync;
  if (phase === 'expire_after_sync' || phase === 'cancel_after_sync') {
    await ledger.close();
    process.stdout.write(`${JSON.stringify({ rejected, handoffs, dispatchable: false })}\n`);
    process.exit(0);
  }
  let poisoned = false;
  if (rejected) {
    try { await ledger.beginDispatchFromHost(context, prepared.actionId, proposal); }
    catch { poisoned = true; }
  } else {
    const duplicate = await ledger.beginDispatchFromHost(context, prepared.actionId, proposal);
    if (duplicate.firstTransition) handoffs += 1;
  }
  await ledger.close();
  process.stdout.write(`${JSON.stringify(phase === 'short_write' ? { handoffs, shortWrites, dispatchable: false } : { rejected, handoffs, poisoned, dispatchable: false })}\n`);
}
