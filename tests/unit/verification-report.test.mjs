import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function api() {
  const url = new URL('../../scripts/verification/report.mjs', import.meta.url);
  expect(await access(url).then(() => true, () => false), 'A foundation report needs a real implementation, not a green stub.').toBe(true);
  return import(url.href);
}
function json(overrides = {}) {
  return JSON.stringify({ numTotalTestSuites: 2, numPassedTestSuites: 2, numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
    snapshot: { failure: false }, testResults: [{ name: 'PRIVATE_PATH', status: 'passed', message: 'PRIVATE_MESSAGE', assertionResults: [
      { status: 'passed', fullName: 'PRIVATE_NAME', failureMessages: ['PRIVATE_CONTENT'] }, { status: 'passed' },
    ] }], ...overrides });
}
function completed(module) { return module.foundationSteps.map(({ id }) => module.classifyStep(id, { status: 0, signal: null, stdout: id === 'test' ? json() : '', stderr: '' }, 1)); }
function snapshot(digest = 'a'.repeat(64)) { return { digest, files: 9, bytes: 100, head: 'b'.repeat(40), dirty: true }; }

describe('CU-002c: deterministic evidence must not imply native capability or release acceptance', () => {
  it('records real test files rather than confusing nested Vitest suites with files, and strips all raw labels and diagnostics', async () => {
    const module = await api(); const result = module.parseVitestSummary(json());
    expect(result).toEqual({ files: 1, total: 2, passed: 2, failed: 0, pending: 0, todo: 0, success: true });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it.each([
    ['invalid JSON', '{PRIVATE_RAW'], ['no tests', json({ numTotalTests: 0, numPassedTests: 0, testResults: [] })],
    ['inconsistent total', json({ numTotalTests: 3 })], ['counterfeit assertions', json({ numPassedTests: 1, numFailedTests: 1 })],
    ['noninteger counts', json({ numTotalTests: 2.5 })], ['missing file result', json({ testResults: [] })],
  ])('does not treat %s as a passed test report', async (_name, value) => {
    const module = await api(); expect(() => module.parseVitestSummary(value)).toThrow('VERIFICATION_EVIDENCE_INVALID');
  });

  it('does not count skipped assertions as passed even with exit zero and success true', async () => {
    const module = await api(); const output = json({ numPassedTests: 1, numPendingTests: 1, testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'pending' }] }] });
    const result = module.classifyStep('test', { status: 0, signal: null, stdout: output, stderr: '' }, 2);
    expect(result.status).toBe('failed'); expect(result.tests).toMatchObject({ total: 2, passed: 1, pending: 1 });
  });

  it.each([{ status: 7, signal: null }, { status: null, signal: 'SIGTERM' }, { status: 0, signal: null, error: new Error('PRIVATE_SPAWN_FAILURE') }])('does not lose a command failure, signal, or startup failure behind a passing JSON body', async (failure) => {
    const module = await api(); const result = module.classifyStep('test', { ...failure, stdout: json(), stderr: 'PRIVATE_STDERR' }, 3);
    expect(result.status).toBe('failed'); expect(result.exitCode).toBe(failure.status); expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('keeps full passing deterministic evidence NO_GO and native observation not requested by default', async () => {
    const module = await api(); const report = module.foundationVerdict(snapshot(), snapshot(), completed(module));
    expect(report).toMatchObject({ deterministic: 'passed', sourceStable: true, releaseDecision: 'NO_GO', nativeControl: false, privateData: false, exitCode: 0,
      nativeObservation: { status: 'not_requested' } });
    expect(report.unmetGates).toContain('NATIVE_CONTROL_NOT_IMPLEMENTED'); expect(report.unmetGates).toContain('PRODUCTION_STOP_NOT_INTEGRATED');
  });

  it.each(['digest', 'head'])('rejects mixed snapshots after a changed %s even if all child commands pass', async (field) => {
    const module = await api(); const after = { ...snapshot(), [field]: field === 'head' ? 'c'.repeat(40) : 'c'.repeat(64) };
    const report = module.foundationVerdict(snapshot(), after, completed(module)); expect(report).toMatchObject({ sourceStable: false, deterministic: 'failed', exitCode: 1, releaseDecision: 'NO_GO' });
  });

  it('requires each fixed step exactly once and in order rather than trusting an empty or cherry-picked list', async () => {
    const module = await api(); const steps = completed(module);
    for (const records of [[], steps.slice(1), [...steps].reverse(), [...steps, steps[0]]]) expect(() => module.foundationVerdict(snapshot(), snapshot(), records)).toThrow('VERIFICATION_EVIDENCE_INVALID');
  });

  it('records native exit3 only for the fixed missing-permission result and never labels it passed', async () => {
    const module = await api(); const native = module.classifyNative({ status: 3, signal: null, stdout: '', stderr: 'NOT_RUN: Accessibility permission is absent. No fixture was launched and no permission was requested.\n' }, 5);
    expect(native).toMatchObject({ status: 'not_run', exitCode: 3, reason: 'ACCESSIBILITY_PERMISSION_ABSENT' });
    expect(module.foundationVerdict(snapshot(), snapshot(), completed(module), native)).toMatchObject({ deterministic: 'passed', releaseDecision: 'NO_GO', exitCode: 3 });
    expect(module.classifyNative({ status: 3, signal: null, stdout: '', stderr: 'PRIVATE_UNEXPECTED_FAILURE' }, 5).status).toBe('failed');
  });

  it('does not turn a setup or snapshot failure with no failed assertions into success', async () => {
    const module = await api();
    for (const stdout of [json({ numFailedTestSuites: 1, numPassedTestSuites: 1 }), json({ snapshot: { failure: true } }), json({ success: false }),
      json({ testResults: [{ status: 'failed', assertionResults: [{ status: 'passed' }, { status: 'passed' }] }] })]) {
      expect(module.classifyStep('test', { status: 0, signal: null, stdout, stderr: '' }, 1).status).toBe('failed');
    }
  });

  it('prioritizes a deterministic failure over missing native permission', async () => {
    const module = await api(); const steps = completed(module); steps[0] = module.classifyStep('build', { status: 1, signal: null }, 1);
    const native = module.classifyNative({ status: 3, signal: null, stderr: 'NOT_RUN: Accessibility permission is absent. No fixture was launched and no permission was requested.\n' }, 1);
    expect(module.foundationVerdict(snapshot(), snapshot(), steps, native).exitCode).toBe(1);
  });

  it.each(['skipped', 'todo'])('retains the %s denominator without treating exit0 as complete acceptance', async (status) => {
    const module = await api(); const stdout = json({ numPassedTests: 1, numPendingTests: status === 'skipped' ? 1 : 0, numTodoTests: status === 'todo' ? 1 : 0,
      testResults: [{ status: 'passed', assertionResults: [{ status: 'passed' }, { status }] }] });
    expect(module.classifyStep('test', { status: 0, signal: null, stdout }, 1)).toMatchObject({ status: 'failed', tests: { total: 2, passed: 1, pending: status === 'skipped' ? 1 : 0, todo: status === 'todo' ? 1 : 0 } });
  });

  it.each([
    json({ testResults: [{ status: 'passed', assertionResults: [{ status: 'made_up' }, { status: 'passed' }] }] }),
    json({ numTotalTestSuites: 4 }), json({ snapshot: {} }), json({ numPassedTests: -1 }),
  ])('rejects unknown states or partial/counterfeit accounting instead of inventing a passing denominator', async (stdout) => {
    const module = await api(); expect(module.classifyStep('test', { status: 0, signal: null, stdout }, 1)).toMatchObject({ status: 'failed', reason: 'TEST_REPORT_INVALID' });
  });

  it('does not let a passed explicit read-only native observation authorize native control or release', async () => {
    const module = await api(); const native = module.classifyNative({ status: 0, signal: null, stdout: 'public fixture only', stderr: '' }, 1);
    expect(module.foundationVerdict(snapshot(), snapshot(), completed(module), native)).toMatchObject({ exitCode: 0, releaseDecision: 'NO_GO', nativeControl: false, nativeObservation: { status: 'passed' } });
  });

  it('does not accept arbitrary command IDs or CLI switches, duplicate native flags, output paths, or permission overrides', async () => {
    const module = await api(); expect(module.parseOptions([])).toEqual({ nativeObservation: false }); expect(module.parseOptions(['--native-observation'])).toEqual({ nativeObservation: true });
    for (const args of [['--cmd', 'sh'], ['--output', '/tmp/private'], ['--native-observation', '--native-observation'], ['--request-permission']]) expect(() => module.parseOptions(args)).toThrow('INVALID_REQUEST');
    expect(() => module.classifyStep('arbitrary command', { status: 0 }, 1)).toThrow('INVALID_REQUEST');
    expect(Object.isFrozen(module.foundationSteps)).toBe(true); for (const step of module.foundationSteps) { expect(Object.isFrozen(step)).toBe(true); expect(Object.isFrozen(step.argv)).toBe(true); }
  });
});
