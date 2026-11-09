import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { probeNativeHealth } from '../../lib/backend/macos/health.js';
import { runNativeRead } from '../../lib/backend/macos/transport.js';

const [root, mode] = process.argv.slice(2);
if (!root || !mode || !resolve(root).startsWith('/private/tmp/cu-helper-artifact-')) process.exit(2);
const seed = await open(join(root, 'dist/native/helper-manifest.json'), 'r');
const prototype = Object.getPrototypeOf(seed);
await seed.close();
const originalRead = prototype.read; const originalStat = prototype.stat;
const touched = new Set(); const closed = new Set();
const abort = new AbortController();
let now = 100; let spawns = 0; let readCalls = 0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
prototype.stat = async function (...args) {
  if (!touched.has(this)) {
    touched.add(this); const close = this.close.bind(this);
    this.close = async () => { closed.add(this); await close(); if (mode === 'close_error') throw new Error('private-fixture-value'); };
  }
  return originalStat.apply(this, args);
};
prototype.read = async function (buffer, offset, length, position) {
  readCalls += 1;
  if (mode === 'read_error') throw new Error('private-fixture-value');
  if (mode === 'zero_read') return { bytesRead: 0, buffer };
  const result = await originalRead.call(this, buffer, offset, mode === 'short_read' ? Math.min(17, length) : length, position);
  if (mode === 'cancel') abort.abort();
  if (mode === 'deadline') now = 10_100;
  return result;
};
let error;
try {
  if (mode === 'deadline_after_done' || mode === 'deadline_after_parse' || mode === 'cancel_after_parse') {
    const stdout = new PassThrough(); const control = new PassThrough();
    const request = { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', command: 'health' };
    const provider = { spawn() {
      spawns += 1;
      return { stdout, control, collected: {}, done: Promise.resolve().then(() => {
        stdout.write(`${JSON.stringify({ requestId: request.requestId, launchId: request.launchId })}\n`);
        if (mode === 'deadline_after_done') now = 10_100;
        return { exitCode: 0, signal: null };
      }), terminate() {}, waitForExit: async () => true };
    } };
    await runNativeRead(provider, root, request, (raw) => {
      if (mode === 'deadline_after_parse') now = 10_100;
      if (mode === 'cancel_after_parse') abort.abort();
      return raw;
    }, { signal: abort.signal, timeoutMs: 2000 }); // Real timer must not race the faked mono clock under load.
    stdout.destroy(); control.destroy();
  } else {
    await probeNativeHealth({ spawn() { spawns += 1; throw new Error('controlled provider refusal'); } }, root, { signal: abort.signal, timeoutMs: mode === 'short_read' ? 5000 : 50 });
  }
} catch (failure) { error = String(failure); }
finally { prototype.read = originalRead; prototype.stat = originalStat; }
const expected = mode.startsWith('cancel') ? 'CANCELLED' : mode.startsWith('deadline') ? 'NATIVE_TIMEOUT' : mode === 'short_read' ? 'NATIVE_TRANSPORT_ERROR' : 'ARTIFACT_INVALID';
process.stdout.write(`${JSON.stringify({ rejected: Boolean(error?.includes(expected) && !error.includes('private-fixture-value')), error, spawns, opened: touched.size, closed: closed.size, readCalls })}\n`);
