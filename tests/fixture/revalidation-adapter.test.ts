import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';

let root: string; let binary: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp('/tmp/cu-revalidation-adapter-')); binary = join(root, 'adapter-probe');
  const compiled = spawnSync('swiftc', [
    '-swift-version', '6', '-module-cache-path', resolve('.local/swift-module-cache'), '-framework', 'ApplicationServices', '-framework', 'AppKit',
    'native/Helper/FixtureElementPolicy.swift', 'native/Helper/FixtureElementScan.swift', 'native/Helper/FixtureTextPolicy.swift', 'native/Helper/FixtureRevalidation.swift',
    'tests/support/revalidation-adapter/main.swift', '-o', binary,
  ], { encoding: 'utf8', timeout: 20_000 });
  expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
}, 25_000);
afterAll(async () => {
  if (!root) return; const exact = await realpath(root);
  if (!exact.startsWith('/private/tmp/cu-revalidation-adapter-')) throw new Error('Refuse cleanup outside test-owned directory.');
  await rm(exact, { recursive: true });
});
it.each([
  ['identifier_error', 'CAPABILITY_UNAVAILABLE'], ['identifier_wrong_type', 'CAPABILITY_UNAVAILABLE'],
  ['zero_children_grow', 'CAPABILITY_UNAVAILABLE'], ['short_children', 'CAPABILITY_UNAVAILABLE'],
  ['children_error', 'CAPABILITY_UNAVAILABLE'], ['detached', 'TARGET_CHANGED'], ['clean', 'exact'],
  ['window_identifier_error', 'CAPABILITY_UNAVAILABLE'], ['window_count_grow', 'CAPABILITY_UNAVAILABLE'],
  ['window_detached_after_scan', 'TARGET_CHANGED'],
])('keeps the real AX adapter closed for %s using isolated API-boundary stubs without querying UI', (fault, expected) => {
  const result = spawnSync(binary, [fault], { encoding: 'utf8', timeout: 2000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: expected, valueReads: 0, dispatchable: false });
});
