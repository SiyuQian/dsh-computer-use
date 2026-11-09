const steps = [
  ['build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']],
  ['build:fixture', ['scripts/build-fixture.mjs']], ['build:helper', ['scripts/build-helper.mjs']], ['build:stop', ['scripts/build-stop.mjs']],
  ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['test', ['node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/verification/vitest.config.mjs', '--reporter=json']],
  ['check:invariants', ['scripts/check-invariants.mjs']], ['check:package', ['scripts/check-package.mjs']],
];
export const foundationSteps = Object.freeze(steps.map(([id, argv]) => Object.freeze({ id, argv: Object.freeze(argv) })));
const unmetGates = Object.freeze(['NATIVE_CONTROL_NOT_IMPLEMENTED', 'PRODUCTION_STOP_NOT_INTEGRATED', 'LIVE_CONSENT_NOT_INTEGRATED',
  'TRUSTED_EFFECT_VERIFIER_NOT_IMPLEMENTED', 'PRIVATE_DATA_NO_GO', 'MODEL_NOT_RUN', 'REAL_APP_NOT_RUN', 'DISTRIBUTION_NOT_VERIFIED']);
const missingPermission = 'NOT_RUN: Accessibility permission is absent. No fixture was launched and no permission was requested.';
function invalid() { return new Error('VERIFICATION_EVIDENCE_INVALID: Fixed foundation evidence is incomplete or inconsistent.'); }
function count(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw invalid(); return value; }

export function parseOptions(args) {
  if (args.length === 0) return { nativeObservation: false };
  if (args.length === 1 && args[0] === '--native-observation') return { nativeObservation: true };
  throw new Error('INVALID_REQUEST: Only the optional --native-observation flag is supported.');
}

/** Vitest 4.1.10 only. Whitelist counters; never retain names, paths, messages, errors or raw reporter objects. */
export function parseVitestSummary(raw) {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16 * 1024 * 1024) throw invalid();
    const data = JSON.parse(raw);
    const total = count(data.numTotalTests); const passed = count(data.numPassedTests); const failed = count(data.numFailedTests);
    const pending = count(data.numPendingTests); const todo = count(data.numTodoTests);
    const suites = count(data.numTotalTestSuites); const passedSuites = count(data.numPassedTestSuites);
    const failedSuites = count(data.numFailedTestSuites); const pendingSuites = count(data.numPendingTestSuites);
    if (!total || passed + failed + pending + todo !== total || !suites || passedSuites + failedSuites + pendingSuites !== suites ||
      typeof data.success !== 'boolean' || typeof data.snapshot?.failure !== 'boolean' || !Array.isArray(data.testResults) || !data.testResults.length) throw invalid();
    const actual = { passed: 0, failed: 0, pending: 0, todo: 0 }; let failedFiles = 0;
    for (const file of data.testResults) {
      if (!['passed', 'failed'].includes(file.status) || !Array.isArray(file.assertionResults)) throw invalid();
      if (file.status === 'failed') failedFiles += 1;
      for (const assertion of file.assertionResults) {
        if (!['passed', 'failed', 'pending', 'skipped', 'todo'].includes(assertion.status)) throw invalid();
        actual[assertion.status === 'skipped' ? 'pending' : assertion.status] += 1;
      }
    }
    if (actual.passed !== passed || actual.failed !== failed || actual.pending !== pending || actual.todo !== todo) throw invalid();
    return { files: data.testResults.length, total, passed, failed, pending, todo,
      success: data.success && !data.snapshot.failure && failed === 0 && pending === 0 && todo === 0 && failedSuites === 0 && pendingSuites === 0 && failedFiles === 0 };
  } catch { throw invalid(); }
}

function outcome(result, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw invalid();
  return { exitCode: Number.isInteger(result.status) ? result.status : null, durationMs: Math.round(elapsedMs),
    ok: result.status === 0 && !result.signal && !result.error };
}
export function classifyStep(id, result, elapsedMs) {
  if (!foundationSteps.some((step) => step.id === id)) throw new Error('INVALID_REQUEST: A fixed foundation step is required.');
  const { ok, ...facts } = outcome(result, elapsedMs); const record = { id, ...facts, status: ok ? 'passed' : 'failed' };
  if (id === 'test') {
    try { record.tests = parseVitestSummary(result.stdout); if (!record.tests.success) record.status = 'failed'; }
    catch { record.status = 'failed'; record.reason = 'TEST_REPORT_INVALID'; }
  }
  return record;
}
export function classifyNative(result, elapsedMs) {
  const { ok, ...facts } = outcome(result, elapsedMs);
  if (!result.signal && !result.error && result.status === 3 && result.stderr?.trim() === missingPermission) {
    return { ...facts, status: 'not_run', reason: 'ACCESSIBILITY_PERMISSION_ABSENT' };
  }
  return { ...facts, status: ok ? 'passed' : 'failed', reason: ok ? 'FIXTURE_READ_ONLY_OBSERVATION' : 'NATIVE_OBSERVATION_FAILED' };
}
export function foundationVerdict(before, after, records, nativeObservation = { status: 'not_requested' }) {
  if (records.length !== foundationSteps.length || records.some((record, index) => record.id !== foundationSteps[index].id)) throw invalid();
  if (!['not_requested', 'not_run', 'passed', 'failed'].includes(nativeObservation.status)) throw invalid();
  const sourceStable = before.digest === after.digest && before.head === after.head;
  const passed = sourceStable && records.every((record) => record.status === 'passed');
  const exitCode = !passed || nativeObservation.status === 'failed' ? 1 : nativeObservation.status === 'not_run' ? 3 : 0;
  return { deterministic: passed ? 'passed' : 'failed', sourceStable, nativeObservation, releaseDecision: 'NO_GO', nativeControl: false, privateData: false,
    unmetGates: [...unmetGates], exitCode };
}
