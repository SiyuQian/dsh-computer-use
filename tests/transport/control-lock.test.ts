import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
let binary: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cu-control-lock-')));
  binary = join(root, 'lock-probe');
  const compiled = spawnSync('swiftc', [
    '-swift-version', '6', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
    '-module-cache-path', resolve('.local/swift-module-cache'),
    'native/ControlLock.swift', 'tests/support/control-lock/main.swift', '-o', binary,
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
}, 25_000);
afterAll(async () => {
  if (root) {
    const actual = await realpath(root);
    const parent = await realpath(tmpdir());
    if (!actual.startsWith(join(parent, 'cu-control-lock-'))) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(actual, { recursive: true });
  }
});
async function namespace(name: string) {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  return path;
}
function probe(path: string) {
  return spawnSync(binary, ['--test-try-lock', path], { encoding: 'utf8', timeout: 2000 });
}
async function owner(path: string) {
  const child = spawn(binary, ['--test-hold-lock', path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const line = await iterator.next();
  expect(line.done, stderr).toBe(false);
  expect(JSON.parse(line.value!)).toMatchObject({ status: 'locked', dispatchable: false });
  return { child, iterator, lines, stderr: () => stderr };
}
async function closeOwner(child: ChildProcessWithoutNullStreams, signal?: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  if (signal) child.kill(signal); else child.stdin.end();
  await ended;
}

describe('CU-010b1: real cross-process Darwin lock in a test-owned namespace', () => {
  it('excludes a second OS process and reuses the same lock inode after normal release', async () => {
    const directory = await namespace('normal');
    const first = await owner(directory);
    try {
      const busy = probe(directory);
      expect(busy.status, busy.stderr).toBe(3);
      expect(JSON.parse(busy.stdout)).toEqual({ status: 'busy', dispatchable: false });
      const before = await lstat(join(directory, 'control.lock'));
      expect(before.mode & 0o777).toBe(0o600);
      await closeOwner(first.child);
      expect(first.child.exitCode).toBe(0);
      const next = probe(directory);
      expect(next.status, next.stderr).toBe(0);
      expect(JSON.parse(next.stdout)).toEqual({ status: 'locked', dispatchable: false });
      const after = await lstat(join(directory, 'control.lock'));
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(await readFile(join(directory, 'control.lock'), 'utf8')).toBe('');
    } finally { await closeOwner(first.child, 'SIGKILL'); first.lines.close(); }
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('recovers OS lock ownership after owner death by %s without deleting its file', async (signal) => {
    const directory = await namespace(signal);
    const first = await owner(directory);
    try {
      const before = await lstat(join(directory, 'control.lock'));
      await closeOwner(first.child, signal);
      expect(first.child.signalCode).toBe(signal);
      const next = probe(directory);
      expect(next.status, next.stderr).toBe(0);
      expect((await lstat(join(directory, 'control.lock'))).ino).toBe(before.ino);
    } finally { await closeOwner(first.child, 'SIGKILL'); first.lines.close(); }
  });

  it('does not leak the lock descriptor across exec into an unrelated owned child', async () => {
    const directory = await namespace('exec');
    const first = await owner(directory);
    let helperPid: number | undefined;
    try {
      first.child.stdin.write('exec\n');
      const line = await first.iterator.next();
      expect(line.done).toBe(false);
      const response = JSON.parse(line.value!);
      expect(response).toMatchObject({ status: 'exec_started', dispatchable: false, childPid: expect.any(Number) });
      helperPid = response.childPid;
      await closeOwner(first.child, 'SIGKILL');
      expect(() => process.kill(helperPid!, 0)).not.toThrow();
      const next = probe(directory);
      expect(next.status, next.stderr).toBe(0);
    } finally {
      await closeOwner(first.child, 'SIGKILL'); first.lines.close();
      if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch { /* The test-only child may have already exited. */ } }
    }
  });

  it('closes each descriptor once when the final constructor ownership witness fails', async () => {
    const directory = await namespace('constructor-fault');
    const faultBinary = join(root, 'fault-probe');
    const compiled = spawnSync('swiftc', [
      '-swift-version', '6', '-module-cache-path', resolve('.local/swift-module-cache'),
      'native/ControlLock.swift', 'tests/support/control-lock-fault/main.swift', '-o', faultBinary,
    ], { encoding: 'utf8', timeout: 15_000 });
    expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
    const faulted = spawnSync(faultBinary, [directory], { encoding: 'utf8', timeout: 2000 });
    expect(faulted.status, faulted.stderr || faulted.stdout).toBe(0);
    expect(JSON.parse(faulted.stdout)).toEqual({ ok: true, rejected: true, witnessFailures: 1, uniqueDescriptors: 2, closeCalls: 2 });
    expect(probe(directory).status).toBe(0);
  });

  it('checks that ownership still names the exact locked file before a caller can rely on it', async () => {
    const directory = await namespace('replaced');
    const first = await owner(directory);
    try {
      const lock = join(directory, 'control.lock');
      expect(await realpath(lock)).toBe(join(directory, 'control.lock'));
      await rm(lock); // Deliberate unlink fault inside this test-owned verified directory, not production lock cleanup.
      await writeFile(lock, '', { mode: 0o600 });
      first.child.stdin.write('check\n');
      const line = await first.iterator.next();
      expect(JSON.parse(line.value!)).toEqual({ status: 'lost', dispatchable: false });
    } finally { await closeOwner(first.child, 'SIGKILL'); first.lines.close(); }
  });

  it.each(['directory_mode', 'symlink_directory', 'file_mode', 'symlink_file', 'hardlink_file', 'directory_file'])('fails closed for %s instead of repairing or switching namespaces', async (fault) => {
    const directory = await namespace(fault);
    const lock = join(directory, 'control.lock');
    let path = directory;
    if (fault === 'directory_mode') await chmod(directory, 0o755);
    if (fault === 'symlink_directory') { path = join(root, 'namespace_link'); await symlink(directory, path); }
    if (fault === 'file_mode') await writeFile(lock, '', { mode: 0o644 });
    if (fault === 'symlink_file') { const source = join(root, 'source_link'); await writeFile(source, '', { mode: 0o600 }); await symlink(source, lock); }
    if (fault === 'hardlink_file') { const source = join(root, 'source_hard'); await writeFile(source, '', { mode: 0o600 }); await link(source, lock); }
    if (fault === 'directory_file') await mkdir(lock, { mode: 0o700 });
    const result = probe(path);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CONTROL_LOCK_UNAVAILABLE');
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(directory);
  });
});
