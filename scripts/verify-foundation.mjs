import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { release, version } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { classifyNative, classifyStep, foundationSteps, foundationVerdict, parseOptions } from './verification/report.mjs';
import { sourceSnapshot } from './verification/source-snapshot.mjs';

const maxBuffer = 16 * 1024 * 1024;
function unavailable() { return new Error('VERIFICATION_UNAVAILABLE: The fixed developer baseline could not be verified.'); }
function command(root, executable, argv) {
  return spawnSync(executable, argv, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer, killSignal: 'SIGKILL',
    env: { ...process.env, NAPI_RS_WASI_FLAVOR: 'wasm32-wasi' }, shell: false });
}
function git(root, argv) {
  const result = command(root, 'git', argv);
  if (result.status !== 0 || result.error || result.signal) throw unavailable();
  return result.stdout.trim();
}
async function snapshot(root) {
  const source = await sourceSnapshot(root); const head = git(root, ['rev-parse', 'HEAD']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw unavailable();
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=normal']).length > 0;
  return { ...source, head, dirty };
}
async function environment(root) {
  const versions = {};
  for (const [name, expected] of [['typescript', '6.0.3'], ['vitest', '4.1.10'], ['@deepseek-ai/dsh-tools', '0.2.2-rc.1']]) {
    const manifest = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (manifest.version !== expected) throw unavailable();
    versions[name] = manifest.version;
  }
  return { node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), osVersion: version(),
    dshSdk: versions['@deepseek-ai/dsh-tools'], typescript: versions.typescript, vitest: versions.vitest };
}
async function helperArtifact(root) {
  const digest = async (path) => {
    const contents = await readFile(resolve(root, path));
    if (contents.length > maxBuffer) throw unavailable();
    return createHash('sha256').update(contents).digest('hex');
  };
  return { binaryDigest: await digest('dist/native/CUHelper'), manifestDigest: await digest('dist/native/helper-manifest.json'), protocolVersion: 1 };
}

async function verify(options) {
  // The entry location, never caller cwd or a CLI path, selects the developer checkout.
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const startedAt = new Date().toISOString(); const runId = randomUUID(); const env = await environment(root); const before = await snapshot(root);
  const records = []; let prerequisiteFailed = false;
  for (const step of foundationSteps) {
    if (prerequisiteFailed) { records.push({ id: step.id, exitCode: null, durationMs: 0, status: 'not_run', reason: 'PREREQUISITE_FAILED' }); continue; }
    const start = performance.now(); const result = command(root, process.execPath, [...step.argv]);
    const record = classifyStep(step.id, result, performance.now() - start); records.push(record); prerequisiteFailed = record.status !== 'passed';
    console.error(`foundation ${step.id}: ${record.status}`);
  }
  const beforeNative = await snapshot(root);
  const stable = before.digest === beforeNative.digest && before.head === beforeNative.head;
  let nativeObservation = { status: 'not_requested' };
  if (options.nativeObservation) {
    if (prerequisiteFailed || !stable) nativeObservation = { status: 'not_run', reason: 'PREREQUISITE_FAILED' };
    else {
      const start = performance.now(); const result = command(root, process.execPath, ['scripts/test-native-observation.mjs']);
      nativeObservation = classifyNative(result, performance.now() - start); console.error(`foundation native-observation: ${nativeObservation.status}`);
    }
  }
  const after = await snapshot(root); const verdict = foundationVerdict(before, after, records, nativeObservation);
  // A mutation found before the optional native lane must remain a failure even if somebody restores the source afterwards.
  if (!stable) { verdict.sourceStable = false; verdict.deterministic = 'failed'; verdict.exitCode = 1; }
  const helper = records.find((record) => record.id === 'build:helper')?.status === 'passed' ? await helperArtifact(root) : undefined;
  return { schemaVersion: 1, kind: 'foundation_verification', runId, startedAt, finishedAt: new Date().toISOString(), environment: env,
    before, after, records, ...(helper ? { helper } : {}), ...verdict };
}

let report;
try {
  const options = parseOptions(process.argv.slice(2));
  try { report = await verify(options); }
  catch { report = { schemaVersion: 1, kind: 'foundation_verification', releaseDecision: 'NO_GO', nativeControl: false, privateData: false, error: 'VERIFICATION_UNAVAILABLE', exitCode: 1 }; }
} catch { report = { schemaVersion: 1, kind: 'foundation_verification', releaseDecision: 'NO_GO', nativeControl: false, privateData: false, error: 'INVALID_REQUEST', exitCode: 1 }; }
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.exitCode;
