import { spawnSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const owned = [];
afterEach(async () => { for (const root of owned.splice(0)) { const exact = await realpath(root); if (!exact.startsWith('/private/tmp/cu-foundation-runner-')) throw new Error('Refuse cleanup outside owned runner checkout.'); await rm(exact, { recursive: true }); } });
const summary = { numTotalTestSuites: 2, numPassedTestSuites: 2, numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 1, numPassedTests: 1,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true, snapshot: { failure: false }, testResults: [{ status: 'passed', name: 'PRIVATE_TEST_PATH', assertionResults: [{ status: 'passed', fullName: 'PRIVATE_LABEL' }] }] };
async function fixture(fault = '') {
  expect(await access(resolve('scripts/verify-foundation.mjs')).then(() => true, () => false), 'The verifier needs a real runnable entry.').toBe(true);
  const root = await realpath(await mkdtemp('/tmp/cu-foundation-runner-')); owned.push(root);
  const files = ['scripts/verify-foundation.mjs', 'scripts/verification/report.mjs', 'scripts/verification/source-snapshot.mjs', 'scripts/verification/vitest.config.mjs'];
  for (const path of files) { await mkdir(dirname(join(root, path)), { recursive: true }); await copyFile(resolve(path), join(root, path)); }
  for (const dir of ['src', 'native', 'tests', 'node_modules/typescript/bin', 'node_modules/vitest', 'node_modules/@deepseek-ai/dsh-tools', 'test-bin']) await mkdir(join(root, dir), { recursive: true });
  for (const name of ['pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json', 'cordis.patch.yml', '.gitignore']) await writeFile(join(root, name), 'public fixture');
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, engines: { dsh: '0.2.2-rc.1' }, scripts: { build: 'touch MANIFEST_SCRIPT_MUST_NOT_RUN' } }));
  for (const [name, version] of [['typescript', '6.0.3'], ['vitest', '4.1.10'], ['@deepseek-ai/dsh-tools', '0.2.2-rc.1']]) await writeFile(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version, type: 'module' }));
  const prefix = `import fs from 'node:fs'; fs.appendFileSync('.runner-calls', JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() })+'\\n');`;
  const sources = [
    ['node_modules/typescript/bin/tsc', `${prefix} ${fault === 'build_fail' ? "if(process.argv.includes('-p')) {console.error('PRIVATE_BUILD_ERROR');process.exit(9);}" : ''}`],
    ['node_modules/vitest/vitest.mjs', `${prefix} console.log(${JSON.stringify(JSON.stringify(summary))}); ${fault === 'source_change' ? "fs.writeFileSync('src/changed.ts','public change');" : ''}`],
    ...['fixture', 'helper', 'stop'].map((name) => [`scripts/build-${name}.mjs`, `${prefix} fs.mkdirSync('dist/native',{recursive:true});fs.writeFileSync('dist/native/CUHelper','public-binary');fs.writeFileSync('dist/native/helper-manifest.json',JSON.stringify({protocolVersion:1}));`]),
    ['scripts/check-invariants.mjs', prefix], ['scripts/check-package.mjs', prefix],
    ['scripts/test-native-observation.mjs', `${prefix} console.error('NOT_RUN: Accessibility permission is absent. No fixture was launched and no permission was requested.');process.exitCode=3;`],
  ];
  for (const [path, source] of sources) await writeFile(join(root, path), source);
  // Git boundary only; subprocess commands and source enumeration remain real in the copied checkout.
  const git = join(root, 'test-bin/git'); await writeFile(git, `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync('.git-calls','called\\n'); if(process.argv.includes('rev-parse'))console.log('${'b'.repeat(40)}');else console.log('?? src/');\n`); await chmod(git, 0o755);
  return { root, run(args = [], cwd = '/tmp') { return spawnSync(process.execPath, [join(root, 'scripts/verify-foundation.mjs'), ...args], {
    cwd, env: { ...process.env, PATH: `${join(root, 'test-bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
  }); } };
}

describe('CU-002c: real fixed-command runner with copied public test executables, not native success', () => {
  it('runs only fixed entries in its own repository, ignores manifest scripts, and emits a fresh NO_GO baseline', async () => {
    const f = await fixture(); const result = f.run(); expect(result.status, result.stderr).toBe(0); const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ kind: 'foundation_verification', releaseDecision: 'NO_GO', deterministic: 'passed', nativeControl: false, privateData: false,
      sourceStable: true, nativeObservation: { status: 'not_requested' }, before: { dirty: true }, environment: { node: process.version, dshSdk: '0.2.2-rc.1' } });
    expect(report.records).toHaveLength(8); expect(report.records.find((record) => record.id === 'test').tests).toEqual({ files: 1, total: 1, passed: 1, failed: 0, pending: 0, todo: 0, success: true });
    const calls = (await readFile(join(f.root, '.runner-calls'), 'utf8')).trim().split('\n').map(JSON.parse); expect(calls).toHaveLength(8);
    for (const call of calls) expect(call.cwd).toBe(f.root); expect(calls.map((call) => call.argv[0])).not.toContain('scripts/test-native-observation.mjs');
    expect(await access(join(f.root, 'MANIFEST_SCRIPT_MUST_NOT_RUN')).then(() => true, () => false)).toBe(false); for (const raw of ['PRIVATE_TEST_PATH', 'PRIVATE_LABEL']) expect(JSON.stringify(report)).not.toContain(raw);
  });
  it('marks explicit missing native permission NOT_RUN with exit3 and still NO_GO', async () => {
    const f = await fixture(); const result = f.run(['--native-observation']); expect(result.status, result.stderr).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ deterministic: 'passed', releaseDecision: 'NO_GO', nativeObservation: { status: 'not_run', exitCode: 3 } });
  });
  it('stops after the first fixed prerequisite failure and does not run tests or native observation against stale artifacts', async () => {
    const f = await fixture('build_fail'); const result = f.run(['--native-observation']); expect(result.status).toBe(1); const report = JSON.parse(result.stdout);
    expect(report.records[0]).toMatchObject({ id: 'build', status: 'failed', exitCode: 9 }); expect(report.records.slice(1).every((record) => record.status === 'not_run')).toBe(true);
    expect(report.nativeObservation).toMatchObject({ status: 'not_run', reason: 'PREREQUISITE_FAILED' }); expect(report.deterministic).toBe('failed');
    expect((await readFile(join(f.root, '.runner-calls'), 'utf8')).trim().split('\n')).toHaveLength(1); expect(result.stdout).not.toContain('PRIVATE_BUILD_ERROR');
  });
  it('fails mixed-source evidence even if every subprocess returns zero', async () => {
    const f = await fixture('source_change'); const result = f.run(); expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ sourceStable: false, deterministic: 'failed', releaseDecision: 'NO_GO' });
  });
  it('rejects unknown command/output/permission flags before even metadata or build subprocesses begin', async () => {
    const f = await fixture(); const result = f.run(['--output', 'PRIVATE_DEST']); expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ releaseDecision: 'NO_GO', error: 'INVALID_REQUEST' });
    expect(await access(join(f.root, '.runner-calls')).then(() => true, () => false)).toBe(false); expect(await access(join(f.root, '.git-calls')).then(() => true, () => false)).toBe(false);
    expect(result.stdout).not.toContain('PRIVATE_DEST');
  });
});
