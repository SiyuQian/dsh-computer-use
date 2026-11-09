import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';

let root: string; let binary: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp('/tmp/cu-action-adapter-')); binary = join(root, 'action-probe');
  const compiled = spawnSync('swiftc', [
    '-swift-version', '6', '-module-cache-path', resolve('.local/swift-module-cache'), '-framework', 'ApplicationServices', '-framework', 'AppKit',
    'native/Helper/FixtureElementPolicy.swift', 'native/Helper/FixtureElementScan.swift', 'native/Helper/FixtureTextPolicy.swift',
    'native/Helper/FixtureRevalidation.swift', 'native/Helper/FixtureAction.swift', 'tests/support/action-adapter/main.swift', '-o', binary,
  ], { encoding: 'utf8', timeout: 30_000 });
  expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
}, 35_000);
afterAll(async () => {
  if (!root) return; const exact = await realpath(root);
  if (!exact.startsWith('/private/tmp/cu-action-adapter-')) throw new Error('Refuse cleanup outside test-owned directory.');
  await rm(exact, { recursive: true });
});
function run(mode: string) {
  const result = spawnSync(binary, [mode], { encoding: 'utf8', timeout: 2000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

it.each([
  ['set_clean', { status: 'dispatched', execution: 'completed', readback: 'match', dispatches: 1, valueReads: 1 }],
  ['set_readback_mismatch', { status: 'dispatched', execution: 'completed', readback: 'mismatch', dispatches: 1, valueReads: 1 }],
  ['set_readback_error', { status: 'dispatched', execution: 'completed', readback: 'unavailable', dispatches: 1, valueReads: 1 }],
  ['set_error', { status: 'dispatched', execution: 'unknown', readback: 'unavailable', dispatches: 1, valueReads: 0 }],
  ['press_clean', { status: 'dispatched', execution: 'completed', readback: 'not_applicable', dispatches: 1, valueReads: 0 }],
  ['press_timeout', { status: 'dispatched', execution: 'unknown', readback: 'not_applicable', dispatches: 1, valueReads: 0 }],
  ['set_unsupported_subrole', { status: 'dispatched', execution: 'completed', readback: 'match', dispatches: 1, valueReads: 1 }],
  ['press_unsupported_subrole', { status: 'dispatched', execution: 'completed', readback: 'not_applicable', dispatches: 1, valueReads: 0 }],
])('dispatches exactly once after exact revalidation and reports %s conservatively', (mode, expected) => {
  expect(run(mode)).toEqual(expected);
});

it.each([
  ['replaced', 'TARGET_CHANGED'], ['untrusted', 'READ_DENIED'], ['set_subrole_error', 'CAPABILITY_UNAVAILABLE'], ['press_subrole_error', 'CAPABILITY_UNAVAILABLE'], ['identity_lost_before_dispatch', 'TARGET_CHANGED'],
])('never dispatches when %s before input', (mode, code) => {
  expect(run(mode)).toEqual({ status: 'error', code, dispatches: 0, valueReads: 0 });
});

it('never echoes the written value in its result', () => {
  expect(JSON.stringify(run('set_clean'))).not.toContain('PUBLIC_FIXTURE_VALUE');
});
