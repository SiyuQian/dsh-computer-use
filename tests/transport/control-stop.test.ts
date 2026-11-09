import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
let binary: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp('/tmp/cu-stop-'));
  binary = join(root, 'stop-probe');
  const compiled = spawnSync('swiftc', [
    '-swift-version', '6', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
    '-module-cache-path', resolve('.local/swift-module-cache'),
    'native/ControlLock.swift', 'native/StopChannel.swift', 'tests/support/control-stop/main.swift', '-o', binary,
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
}, 25_000);
afterAll(async () => {
  if (root) {
    const actual = await realpath(root);
    if (!actual.startsWith('/private/tmp/cu-stop-')) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(actual, { recursive: true });
  }
});
async function namespace(name: string) {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  return path;
}
async function terminate(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill(signal);
  await ended;
}
async function owner(directory: string, generation = `generation_${randomUUID()}`, mode = '--test-owner') {
  const capability = randomBytes(32).toString('hex');
  const child = spawn(binary, [mode, directory, generation], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const channel = child.stdio[3];
  if (!channel || !('end' in channel)) throw new Error('Test control pipe is unavailable.');
  channel.end(`${capability}\n`);
  let output = ''; let errors = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  const lines = createInterface({ input: child.stdout! });
  const iterator = lines[Symbol.asyncIterator]();
  const ready = await iterator.next();
  expect(ready.done, errors).toBe(false);
  expect(JSON.parse(ready.value!)).toEqual({ status: 'ready', dispatchable: false });
  return { child, generation, capability, lines, iterator, output: () => output, errors: () => errors };
}
async function stop(directory: string, generation: string, capability: string, mode = '--test-stop', executable = binary) {
  const child = spawn(executable, [mode, directory, generation], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const channel = child.stdio[3];
  if (!channel || !('end' in channel)) throw new Error('Test control pipe is unavailable.');
  channel.end(`${capability}\n`);
  let output = ''; let errors = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  const [exitCode] = await once(child, 'exit');
  expect(output.includes(capability) || errors.includes(capability)).toBe(false);
  return { exitCode, output, errors };
}
function probe(directory: string) {
  return spawnSync(binary, ['--test-try-lock', directory], { encoding: 'utf8', timeout: 2000 });
}
function wire(generation: string, capability: string, extra: Record<string, unknown> = {}) {
  return `${JSON.stringify({ capability, command: 'stop', generation, protocolVersion: 1, ...extra })}\n`;
}
async function rawRequest(directory: string, frame: string, halfClose = true) {
  const socket = connect(join(directory, 'stop.sock'));
  let output = '';
  const done = new Promise<string>((done, reject) => {
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error('Test stop response timed out.')); }, 2000);
    socket.on('data', (chunk) => { output += chunk.toString('utf8'); });
    socket.on('end', () => { clearTimeout(deadline); done(output); });
    socket.on('error', (error) => { clearTimeout(deadline); reject(error); });
  });
  socket.on('connect', () => { if (halfClose) socket.end(frame); else socket.write(frame); });
  return done;
}

describe('CU-010b2a: independent stop-only channel in an owned test namespace', () => {
  it('authenticates a separate stop process, revokes immediately and retains OS exclusion until drain', async () => {
    const directory = await namespace('drain');
    const first = await owner(directory);
    try {
      const lockBefore = await lstat(join(directory, 'control.lock'));
      expect((await lstat(join(directory, 'stop.sock'))).mode & 0o777).toBe(0o600);
      const answer = await stop(directory, first.generation, first.capability);
      expect(answer.exitCode, answer.errors).toBe(0);
      expect(JSON.parse(answer.output)).toEqual({ status: 'revoked', drained: false, dispatchable: false });
      expect(JSON.parse((await first.iterator.next()).value!)).toEqual({ status: 'revoked', drained: false, dispatchable: false });
      expect(probe(directory).status).toBe(3);
      const again = await stop(directory, first.generation, first.capability);
      expect(JSON.parse(again.output)).toEqual({ status: 'revoked', drained: false, dispatchable: false });
      const ended = once(first.child, 'exit');
      first.child.stdin!.end('drain\n');
      await ended;
      expect(first.child.exitCode).toBe(0);
      expect(probe(directory).status).toBe(0);
      expect((await lstat(join(directory, 'control.lock'))).ino).toBe(lockBefore.ino);
      expect(await lstat(join(directory, 'stop.sock')).then(() => true, () => false)).toBe(false);
      expect((first.output() + first.errors()).includes(first.capability)).toBe(false);
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it('rejects a wrong capability or generation and cannot grant, resume or dispatch', async () => {
    const directory = await namespace('auth');
    const first = await owner(directory);
    try {
      for (const [generation, capability] of [[first.generation, randomBytes(32).toString('hex')], ['generation_other', first.capability]]) {
        const answer = await stop(directory, generation!, capability!);
        expect(answer.exitCode).toBe(2);
        expect(JSON.parse(answer.output)).toEqual({ status: 'denied', dispatchable: false });
      }
      for (const command of ['resume', 'grant', 'dispatch']) {
        expect(JSON.parse(await rawRequest(directory, wire(first.generation, first.capability, { command })))).toEqual({ status: 'denied', dispatchable: false });
      }
      first.child.stdin!.write('status\n');
      expect(JSON.parse((await first.iterator.next()).value!)).toEqual({ status: 'active', dispatchable: false });
      expect(probe(directory).status).toBe(3);
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it.each(['extra', 'invalid_json', 'extra_frame', 'truncated', 'oversized', 'boolean_version', 'duplicate_key', 'duplicate_same_key'])('rejects %s frames with fixed errors and no capability leakage', async (fault) => {
    const directory = await namespace(`frame_${fault}`);
    const first = await owner(directory);
    try {
      let frame = wire(first.generation, first.capability);
      if (fault === 'extra') frame = wire(first.generation, first.capability, { approved: true });
      if (fault === 'invalid_json') frame = `{${first.capability}\n`;
      if (fault === 'extra_frame') frame += frame;
      if (fault === 'truncated') frame = frame.slice(0, -1);
      if (fault === 'oversized') frame = `${first.capability}${'x'.repeat(600)}\n`;
      if (fault === 'boolean_version') frame = wire(first.generation, first.capability, { protocolVersion: true });
      if (fault === 'duplicate_key') frame = frame.replace('"command":"stop"', '"command":"dispatch","command":"stop"');
      if (fault === 'duplicate_same_key') frame = frame.replace('"command":"stop"', '"command":"stop","command":"stop"');
      const answer = await rawRequest(directory, frame);
      expect(answer.includes(first.capability)).toBe(false);
      expect(JSON.parse(answer)).toEqual({ status: 'denied', dispatchable: false });
      first.child.stdin!.write('status\n');
      expect(JSON.parse((await first.iterator.next()).value!)).toEqual({ status: 'active', dispatchable: false });
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it('rejects a socket with widened permissions before transmitting its private capability', async () => {
    const directory = await namespace('socket_mode');
    const first = await owner(directory);
    try {
      await chmod(join(directory, 'stop.sock'), 0o666);
      const result = await stop(directory, first.generation, first.capability);
      expect(result.exitCode).toBe(2);
      expect(result.output).toBe('');
      expect(result.errors).toContain('CONTROL_STOP_UNAVAILABLE');
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it.each(['directory_mode', 'symlink_directory'])('refuses a %s client namespace before transmitting capability', async (fault) => {
    const directory = await namespace(fault);
    const first = await owner(directory);
    let requested = directory;
    try {
      if (fault === 'directory_mode') await chmod(directory, 0o755);
      else { requested = join(root, 'client_alias'); await symlink(directory, requested); }
      const result = await stop(requested, first.generation, first.capability);
      expect(result.exitCode).toBe(2);
      expect(result.output).toBe('');
      expect(result.errors).toContain('CONTROL_STOP_UNAVAILABLE');
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it('rejects a foreign peer UID reported by the OS boundary without sending an authenticated stop', async () => {
    const directory = await namespace('peer_uid');
    const first = await owner(directory);
    const fault = join(root, 'peer-mismatch');
    try {
      const compiled = spawnSync('swiftc', [
        '-swift-version', '6', '-module-cache-path', resolve('.local/swift-module-cache'),
        'native/ControlLock.swift', 'native/StopChannel.swift', 'tests/support/control-stop/PeerMismatch.swift',
        'tests/support/control-stop/main.swift', '-o', fault,
      ], { encoding: 'utf8', timeout: 20_000 });
      expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
      const result = await stop(directory, first.generation, first.capability, '--test-stop', fault);
      expect(result.exitCode).toBe(2);
      expect(result.output).toBe('');
      first.child.stdin!.write('status\n');
      expect(JSON.parse((await first.iterator.next()).value!).status).toBe('active');
      expect(probe(directory).status).toBe(3);
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it('does not let partial stdin or an incomplete peer block a later stop while inert work retains the lock', async () => {
    const directory = await namespace('partial_stdin');
    const first = await owner(directory);
    try {
      first.child.stdin!.write('sta');
      const result = await stop(directory, first.generation, first.capability);
      expect(result.exitCode).toBe(0);
      expect(probe(directory).status).toBe(3);
      expect(first.child.exitCode).toBe(null);
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it('survives a peer closing before its acknowledgement without releasing the lock before drain', async () => {
    const directory = await namespace('disconnect');
    const first = await owner(directory, `generation_${randomUUID()}`, '--test-paused-owner');
    try {
      const socket = connect(join(directory, 'stop.sock'));
      await once(socket, 'connect');
      await new Promise<void>((resolve) => socket.end(wire(first.generation, first.capability), () => resolve()));
      socket.destroy();
      first.child.stdin!.write('service\n');
      const result = await stop(directory, first.generation, first.capability);
      expect(result.exitCode).toBe(0);
      expect(probe(directory).status).toBe(3);
      expect(first.child.exitCode).toBe(null);
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it('expires all stalled connections at an absolute deadline and admits a later stop', async () => {
    const directory = await namespace('slots');
    const first = await owner(directory);
    const stalled = Array.from({ length: 8 }, () => connect(join(directory, 'stop.sock')));
    try {
      await Promise.all(stalled.map((socket) => once(socket, 'connect')));
      const expired = stalled.map((socket) => new Promise<void>((resolve) => {
        socket.on('data', () => {});
        socket.on('end', () => resolve());
      }));
      for (const socket of stalled) socket.write('{');
      await Promise.all(expired);
      const result = await stop(directory, first.generation, first.capability);
      expect(result.exitCode).toBe(0);
      expect(probe(directory).status).toBe(3);
    } finally { for (const socket of stalled) socket.destroy(); await terminate(first.child); first.lines.close(); }
  });

  it('reclaims expired slots before accepting a queued authenticated stop in the same service step', async () => {
    const directory = await namespace('expired_admission');
    const first = await owner(directory, `generation_${randomUUID()}`, '--test-paused-owner');
    const stalled = Array.from({ length: 8 }, () => connect(join(directory, 'stop.sock')));
    let accepted: ReturnType<typeof connect> | undefined;
    try {
      await Promise.all(stalled.map((socket) => once(socket, 'connect')));
      for (const socket of stalled) { socket.on('data', () => {}); socket.write('{'); }
      first.child.stdin!.write('step\n');
      expect(JSON.parse((await first.iterator.next()).value!).status).toBe('stepped');
      await new Promise((resolve) => setTimeout(resolve, 300)); // Cross the real native monotonic deadline while service is deliberately paused.
      accepted = connect(join(directory, 'stop.sock'));
      await once(accepted, 'connect');
      const result = new Promise<string>((resolve, reject) => {
        let output = '';
        accepted!.on('data', (chunk) => { output += chunk.toString('utf8'); });
        accepted!.on('end', () => resolve(output));
        accepted!.on('error', reject);
      });
      accepted.end(wire(first.generation, first.capability));
      first.child.stdin!.write('service\n');
      expect(JSON.parse(await result)).toEqual({ status: 'revoked', drained: false, dispatchable: false });
      expect(probe(directory).status).toBe(3);
    } finally { accepted?.destroy(); for (const socket of stalled) socket.destroy(); await terminate(first.child); first.lines.close(); }
  });

  it('fails closed on a missing or partial inherited capability without publishing a listener', async () => {
    const directory = await namespace('no_secret');
    const missing = spawnSync(binary, ['--test-owner', directory, 'generation_fixture'], { encoding: 'utf8', timeout: 2000 });
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('CONTROL_STOP_UNAVAILABLE');
    const partial = await stop(directory, 'generation_fixture', 'bad', '--test-owner');
    expect(partial.exitCode).toBe(2);
    expect(partial.output).toBe('');
    expect(await lstat(join(directory, 'stop.sock')).then(() => true, () => false)).toBe(false);
  });

  it('does not delete another file placed at its former socket path during cleanup', async () => {
    const directory = await namespace('socket_replaced');
    const first = await owner(directory);
    try {
      const path = join(directory, 'stop.sock');
      expect((await lstat(path)).isSocket()).toBe(true);
      await rm(path); // Deliberate test-owned namespace replacement fault, never production cleanup.
      await writeFile(path, 'test-marker', { mode: 0o600 });
      const ended = once(first.child, 'exit');
      first.child.stdin!.end('drain\n');
      await ended;
      expect(first.child.exitCode).toBe(0);
      expect(await readFile(path, 'utf8')).toBe('test-marker');
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it('cannot create or clean a stop socket in a namespace other than the held lock', async () => {
    const owned = await namespace('lock_namespace');
    const different = await namespace('other_namespace');
    const result = await stop(owned, different, randomBytes(32).toString('hex'), '--test-mismatched-listener');
    expect(result.exitCode).toBe(2);
    expect(result.output).toBe('');
    expect(await lstat(join(different, 'stop.sock')).then(() => true, () => false)).toBe(false);
  });

  it('does not let a slow incomplete connection block a later authenticated stop', async () => {
    const directory = await namespace('slow');
    const first = await owner(directory);
    const slow = connect(join(directory, 'stop.sock'));
    try {
      await once(slow, 'connect');
      slow.write('{');
      const answer = await stop(directory, first.generation, first.capability);
      expect(answer.exitCode).toBe(0);
      expect(JSON.parse(answer.output).status).toBe('revoked');
      expect(probe(directory).status).toBe(3);
    } finally { slow.destroy(); await terminate(first.child); first.lines.close(); }
  });

  it('rejects stale generation/capability after crash and only a new lock owner removes its stale socket', async () => {
    const directory = await namespace('crash');
    const first = await owner(directory);
    await terminate(first.child); first.lines.close();
    expect((await lstat(join(directory, 'stop.sock'))).isSocket()).toBe(true);
    const next = await owner(directory);
    try {
      const old = await stop(directory, first.generation, first.capability);
      expect(old.exitCode).toBe(2);
      expect(JSON.parse(old.output).status).toBe('denied');
      expect((await stop(directory, next.generation, next.capability)).exitCode).toBe(0);
    } finally { await terminate(next.child); next.lines.close(); }
  });

  it('refuses a preexisting regular or symlink socket entry without deleting or rewriting it', async () => {
    for (const kind of ['regular', 'symlink'] as const) {
      const directory = await namespace(kind);
      const entry = join(directory, 'stop.sock');
      if (kind === 'regular') await writeFile(entry, 'test-marker', { mode: 0o600 });
      else { const file = join(directory, 'marker'); await writeFile(file, 'test-marker', { mode: 0o600 }); await symlink(file, entry); }
      const result = await stop(directory, 'generation_fixture', randomBytes(32).toString('hex'), '--test-owner');
      expect(result.exitCode).toBe(2);
      expect(result.output).toBe('');
      expect(await readFile(entry, 'utf8')).toBe('test-marker');
    }
  });
});
