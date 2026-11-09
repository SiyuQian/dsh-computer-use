import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string; let binary: string; let faultBinary: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp('/tmp/cu-namespace-'));
  binary = join(root, 'namespace-probe');
  const compiled = spawnSync('swiftc', [
    '-swift-version', '6', '-module-cache-path', resolve('.local/swift-module-cache'),
    'native/ControlLock.swift', 'native/ControlNamespace.swift', 'native/StopChannel.swift', 'native/StopDiscovery.swift',
    'tests/support/control-namespace/main.swift', '-o', binary,
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
  faultBinary = join(root, 'namespace-fault');
  const fault = spawnSync('swiftc', [
    '-swift-version', '6', '-module-cache-path', resolve('.local/swift-module-cache'),
    'native/ControlLock.swift', 'native/ControlNamespace.swift', 'native/StopChannel.swift', 'native/StopDiscovery.swift',
    'tests/support/control-namespace-fault/main.swift', '-o', faultBinary,
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(fault.status, fault.stderr || fault.error?.message).toBe(0);
}, 25_000);
afterAll(async () => {
  if (!root) return;
  const actual = await realpath(root);
  if (!actual.startsWith('/private/tmp/cu-namespace-')) throw new Error('Refuse cleanup outside test-owned parent.');
  await rm(actual, { recursive: true });
});
async function parent(name: string) { const path = join(root, name); await mkdir(path, { mode: 0o700 }); return path; }
function probe(mode: string, path: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(binary, [mode, path], { encoding: 'utf8', timeout: 3000, env });
}
async function owner(path: string) {
  const child = spawn(binary, ['owner', path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); });
  const lines = createInterface({ input: child.stdout }); const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next(); expect(first.done, error).toBe(false);
  const ready = JSON.parse(first.value!);
  expect(ready).toMatchObject({ status: 'ready', dispatchable: false });
  return { child, lines, iterator, directory: ready.directory as string };
}
async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
}
function asyncProbe(mode: string, path: string) {
  return new Promise<{ code: number | null; output: string; errors: string }>((done, reject) => {
    const child = spawn(binary, [mode, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
    child.once('error', reject); child.once('close', (code) => done({ code, output, errors }));
  });
}

describe('CU-010b2b1: trusted fixed per-user namespace and stop-only discovery', () => {
  it('derives one production path from OS euid regardless of HOME, TMPDIR, workspace or profile without creating it', () => {
    const expected = `/private/tmp/dsh-computer-use-${process.geteuid!()}`;
    for (const env of [process.env, { ...process.env, HOME: '/tmp/namespace-fake-home', TMPDIR: '/tmp/namespace-fake-temp', DSH_PROFILE: 'other', DSH_WORKSPACE: '/tmp/namespace-other' }]) {
      const result = probe('production-path', root, env);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ directory: expected, dispatchable: false });
    }
  });

  it('creates only the fixed leaf with 0700, preserves an existing leaf, and never removes its stable lock', async () => {
    const path = await parent('create');
    const result = probe('namespace', path);
    expect(result.status, result.stderr).toBe(0);
    const leaf = join(path, `dsh-computer-use-${process.geteuid!()}`);
    expect(JSON.parse(result.stdout)).toEqual({ directory: leaf, dispatchable: false });
    expect((await lstat(leaf)).mode & 0o7777).toBe(0o700);
    const again = probe('namespace', path);
    expect(again.status, again.stderr).toBe(0);
    expect((await lstat(leaf)).ino).toBe((await lstat(JSON.parse(again.stdout).directory)).ino);
  });

  it('lets a separate discovered-stop client revoke without receiving any argv capability and retains lock to drain', async () => {
    const path = await parent('stop'); const first = await owner(path);
    try {
      const endpoint = join(first.directory, 'stop.endpoint');
      expect((await lstat(endpoint)).mode & 0o7777).toBe(0o600);
      const result = await asyncProbe('stop', path);
      expect(result.code, result.errors).toBe(0);
      expect(JSON.parse(result.output)).toEqual({ status: 'revoked', drained: false, dispatchable: false });
      const fields = JSON.parse(await readFile(endpoint, 'utf8'));
      expect(result.output.includes(fields.capability) || result.errors.includes(fields.capability)).toBe(false);
      expect(probe('try-lock', path).status).toBe(3);
      const ended = once(first.child, 'exit'); first.child.stdin.write('drain\n'); await ended;
      expect(probe('try-lock', path).status).toBe(0);
      await expect(lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(join(first.directory, 'control.lock'))).isFile()).toBe(true);
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it.each(['parent_mode', 'parent_alias', 'leaf_mode', 'leaf_symlink', 'leaf_file'])('refuses %s without chmod, redirect or deletion', async (fault) => {
    let path = await parent(fault); let marker: string | undefined;
    if (fault === 'parent_mode') await chmod(path, 0o755);
    if (fault === 'parent_alias') { const alias = join(root, 'parent_alias_link'); await symlink(path, alias); path = alias; }
    const leaf = join(path, `dsh-computer-use-${process.geteuid!()}`);
    if (fault === 'leaf_mode') await mkdir(leaf, { mode: 0o755 });
    if (fault === 'leaf_symlink') { marker = join(path, 'other'); await mkdir(marker, { mode: 0o700 }); await symlink(marker, leaf); }
    if (fault === 'leaf_file') { marker = leaf; await writeFile(leaf, 'test-marker', { mode: 0o600 }); }
    const result = probe('namespace', path);
    expect(result.status).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).toBe('CONTROL_NAMESPACE_UNAVAILABLE\n');
    if (fault === 'leaf_mode') expect((await lstat(leaf)).mode & 0o7777).toBe(0o755);
    if (fault === 'leaf_symlink') expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
    if (fault === 'leaf_file') expect(await readFile(marker!, 'utf8')).toBe('test-marker');
  });

  it('does not create a missing leaf when a stop client only tries discovery', async () => {
    const path = await parent('no_leaf');
    const result = await asyncProbe('stop', path);
    expect(result.code).toBe(2); expect(result.output).toBe('');
    await expect(lstat(join(path, `dsh-computer-use-${process.geteuid!()}`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a second live owner without rewriting the published generation or capability', async () => {
    const path = await parent('second_owner'); const first = await owner(path);
    try {
      const endpoint = join(first.directory, 'stop.endpoint'); const before = await readFile(endpoint, 'utf8');
      const result = probe('owner', path);
      expect(result.status).toBe(3);
      expect((await readFile(endpoint, 'utf8')) === before).toBe(true);
      expect((await asyncProbe('stop', path)).code).toBe(0);
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it('retains a replacement discovery marker during normal cleanup while releasing the old lock after drain', async () => {
    const path = await parent('replaced'); const first = await owner(path);
    try {
      const endpoint = join(first.directory, 'stop.endpoint');
      const exact = await realpath(endpoint); expect(exact).toBe(endpoint);
      await rm(exact); // Replace only the verified test-owned endpoint.
      await writeFile(endpoint, 'test-marker', { mode: 0o600 });
      const ended = once(first.child, 'exit'); first.child.stdin.write('drain\n'); await ended;
      expect(await readFile(endpoint, 'utf8')).toBe('test-marker');
      expect(probe('try-lock', path).status).toBe(0);
    } finally { await terminate(first.child); first.lines.close(); }
  });

  it.each(['partial_pending', 'linked_pair', 'full_stale', 'malformed_stale'])('recovers a %s publication only after the old lock owner has ended', async (fault) => {
    const path = await parent(`stale_${fault}`);
    let leaf: string;
    let old: string | undefined;
    if (fault === 'full_stale') {
      const first = await owner(path); leaf = first.directory;
      old = await readFile(join(leaf, 'stop.endpoint'), 'utf8');
      await terminate(first.child); first.lines.close();
    } else {
      const result = probe('namespace', path); expect(result.status).toBe(0); leaf = JSON.parse(result.stdout).directory;
      const pending = join(leaf, 'stop.endpoint.pending');
      if (fault === 'partial_pending') await writeFile(pending, '{"capability":', { mode: 0o600 });
      if (fault === 'linked_pair') {
        await writeFile(pending, '{"capability":', { mode: 0o600 }); await link(pending, join(leaf, 'stop.endpoint'));
      }
      if (fault === 'malformed_stale') await writeFile(join(leaf, 'stop.endpoint'), '', { mode: 0o600 });
    }
    const next = await owner(path);
    try {
      const current = await readFile(join(next.directory, 'stop.endpoint'), 'utf8');
      if (old) expect(current).not.toBe(old);
      expect((await lstat(join(next.directory, 'stop.endpoint'))).nlink).toBe(1);
      await expect(lstat(join(next.directory, 'stop.endpoint.pending'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await asyncProbe('stop', path)).code).toBe(0);
    } finally { await terminate(next.child); next.lines.close(); }
  });

  it.each(['symlink', 'hardlink', 'oversized', 'mode'])('does not delete an unsafe %s stale endpoint when a new owner tries publication', async (fault) => {
    const path = await parent(`unsafe_${fault}`);
    const result = probe('namespace', path); expect(result.status).toBe(0);
    const leaf = JSON.parse(result.stdout).directory;
    const endpoint = join(leaf, 'stop.endpoint');
    const marker = join(leaf, 'marker'); await writeFile(marker, 'test-marker', { mode: 0o600 });
    if (fault === 'symlink') await symlink(marker, endpoint);
    if (fault === 'hardlink') await link(marker, endpoint);
    if (fault === 'oversized') await writeFile(endpoint, 'x'.repeat(513), { mode: 0o600 });
    if (fault === 'mode') await writeFile(endpoint, 'test-marker', { mode: 0o644 });
    const before = await lstat(endpoint);
    const attempted = probe('owner', path);
    expect(attempted.status).toBe(2); expect(attempted.stdout).toBe('');
    expect((await lstat(endpoint)).ino).toBe(before.ino);
    expect(await readFile(marker, 'utf8')).toBe('test-marker');
  });

  it('never uses a reopened foreign directory descriptor to remove stale discovery or publish outside the witnessed namespace', async () => {
    const path = await parent('redirect_directory');
    const result = spawnSync(faultBinary, ['redirect_directory', path], { encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: true, rejected: false, dispatchable: false });
    expect(await readFile(join(path, 'alternate/stop.endpoint'), 'utf8')).toBe('test-marker');
  });

  it.each(['namespace_init', 'uid_mismatch', 'root_uid'])('fails closed for %s and closes transferred init handles once', async (fault) => {
    const result = spawnSync(faultBinary, [fault, await parent(`init_${fault}`)], { encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.rejected).toBe(true); expect(output.complete).toBe(false);
    if (fault === 'namespace_init') expect(output).toMatchObject({ closeCalls: 2, uniqueCloses: 2, witnessFailures: 1 });
  });

  it.each(['write_fail', 'zero_write', 'file_sync_fail', 'directory_sync_fail', 'link_fail'])('does not publish ready on %s and permits safe lock-owner recovery', async (fault) => {
    const path = await parent(`fault_${fault}`);
    const result = spawnSync(faultBinary, [fault, path], { encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ rejected: true, complete: false, dispatchable: false });
    const next = await owner(path);
    try { expect((await asyncProbe('stop', path)).code).toBe(0); }
    finally { await terminate(next.child); next.lines.close(); }
  });

  it.each(['crash_created', 'crash_partial', 'crash_linked'])('recovers an actual publication process crash at %s without admitting a partial final record', async (fault) => {
    const path = await parent(fault);
    const result = spawnSync(faultBinary, [fault, path], { encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(7);
    expect((await asyncProbe('stop', path)).code).toBe(2);
    const next = await owner(path);
    try { expect((await asyncProbe('stop', path)).code).toBe(0); }
    finally { await terminate(next.child); next.lines.close(); }
  });

  it.each(['different_namespace', 'released_lock'])('never publishes stop discovery with a %s control lock', async (failure) => {
    const result = spawnSync(faultBinary, [failure, await parent(failure)], { encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: false, rejected: true, dispatchable: false });
  });

  it('completes bounded short filesystem writes without publishing a partial discoverable record', async () => {
    const result = spawnSync(faultBinary, ['short_write', await parent('short_write')], { encoding: 'utf8', timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.complete).toBe(true); expect(output.rejected).toBe(false); expect(output.writes).toBeGreaterThan(1);
  });

  it.each(['mode', 'symlink', 'hardlink', 'oversized', 'duplicate', 'extra', 'version', 'truncated'])('refuses a %s discovery record without sending stop', async (fault) => {
    const path = await parent(`discovery_${fault}`); const first = await owner(path);
    try {
      const endpoint = join(first.directory, 'stop.endpoint');
      const original = await readFile(endpoint, 'utf8');
      if (fault === 'mode') await chmod(endpoint, 0o644);
      else if (fault === 'symlink' || fault === 'hardlink') {
        const marker = join(first.directory, 'marker'); await writeFile(marker, original, { mode: 0o600 });
        const exact = await realpath(endpoint); expect(exact).toBe(endpoint);
        await rm(exact); // Test-owned discovery corruption at the verified exact path.
        if (fault === 'symlink') await symlink(marker, endpoint);
        else await link(marker, endpoint);
      } else {
        const content = fault === 'oversized' ? 'x'.repeat(513) : fault === 'duplicate' ? original.replace('"protocolVersion":1', '"protocolVersion":1,"protocolVersion":1') : fault === 'extra' ? original.replace('{', '{"approved":true,') : fault === 'version' ? original.replace('"protocolVersion":1', '"protocolVersion":true') : original.slice(0, -2);
        await writeFile(endpoint, content, { mode: 0o600 });
      }
      const result = await asyncProbe('stop', path);
      expect(result.code).toBe(2); expect(result.output).toBe(''); expect(result.errors).toBe('CONTROL_NAMESPACE_UNAVAILABLE\n');
      first.child.stdin.write('status\n'); expect(JSON.parse((await first.iterator.next()).value!).status).toBe('active');
    } finally { await terminate(first.child); first.lines.close(); }
  });
});
