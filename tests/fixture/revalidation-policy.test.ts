import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

let root: string; let binary: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp('/tmp/cu-revalidation-')); binary = join(root, 'policy-probe');
  const compiled = spawnSync('swiftc', ['-swift-version', '6', 'native/Helper/FixtureElementPolicy.swift', 'native/Helper/FixtureElementScan.swift', 'tests/support/revalidation-policy/main.swift', '-o', binary], { encoding: 'utf8', timeout: 15_000 });
  expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
}, 20_000);
afterAll(async () => {
  if (!root) return; const exact = await realpath(root);
  if (!exact.startsWith('/private/tmp/cu-revalidation-')) throw new Error('Refuse cleanup outside test-owned directory.');
  await rm(exact, { recursive: true });
});
describe('CU-007b1: pure Swift exact fixture witness decision, not AX success', () => {
  it.each([
    ['exact', 'exact'], ['reordered', 'exact'], ['replaced', 'TARGET_CHANGED'], ['duplicate', 'TARGET_AMBIGUOUS'],
    ['same_identifier_twice', 'TARGET_AMBIGUOUS'], ['incomplete', 'CAPABILITY_UNAVAILABLE'], ['disabled', 'CAPABILITY_UNAVAILABLE'],
    ['secure', 'CAPABILITY_UNAVAILABLE'], ['missing_subrole', 'CAPABILITY_UNAVAILABLE'], ['role_changed', 'CAPABILITY_UNAVAILABLE'],
    ['missing_instance', 'TARGET_CHANGED'], ['wrong_operation', 'CAPABILITY_UNAVAILABLE'], ['wrong_identifier', 'TARGET_CHANGED'],
    ['child_error', 'CAPABILITY_UNAVAILABLE'], ['child_short_read', 'CAPABILITY_UNAVAILABLE'], ['detached_after_scan', 'TARGET_CHANGED'],
    ['replaced_after_scan', 'TARGET_CHANGED'], ['identifier_changed_after_scan', 'TARGET_CHANGED'],
    ['cycle', 'CAPABILITY_UNAVAILABLE'], ['depth', 'CAPABILITY_UNAVAILABLE'], ['node_limit', 'CAPABILITY_UNAVAILABLE'],
  ])('evaluates %s metadata as %s without reading field values', (fault, expected) => {
    const result = spawnSync(binary, [fault], { encoding: 'utf8', timeout: 2000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: expected, dispatchable: false });
  });
});
