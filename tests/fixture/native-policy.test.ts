import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it('never invokes the native value getter for missing, conflicting or secure field metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cu-native-policy-'));
  const binary = join(directory, 'policy-check');
  try {
    const compiled = spawnSync('swiftc', [
      '-swift-version', '6', '-module-cache-path', resolve('.local/swift-module-cache'),
      'native/Helper/FixtureTextPolicy.swift', 'tests/support/native-policy/main.swift', '-o', binary,
    ], { encoding: 'utf8', timeout: 15_000 });
    expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
    const tested = spawnSync(binary, [], { encoding: 'utf8', timeout: 2000 });
    expect(tested.status, tested.stderr || tested.error?.message).toBe(0);
    expect(JSON.parse(tested.stdout)).toEqual({ ok: true, rejectedValueReads: 0, allowedValueReads: 1 });
  } finally {
    const actual = resolve(directory);
    if (!actual.startsWith(resolve(tmpdir(), 'cu-native-policy-'))) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(actual, { recursive: true });
  }
});
