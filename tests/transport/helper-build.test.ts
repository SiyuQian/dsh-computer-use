import { spawnSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const exact = await realpath(root);
    if (!exact.startsWith('/private/tmp/cu-helper-build-')) throw new Error('Refuse cleanup outside test-owned build checkout.');
    await rm(exact, { recursive: true });
  }
});
it.each(['source', 'recipe'])('does not publish a manifest when %s changes while the compiler runs', async (fault) => {
  const root = await realpath(await mkdtemp('/tmp/cu-helper-build-')); roots.push(root);
  const sources = ['native/ProcessIdentity.swift', 'native/Helper/FixtureTextPolicy.swift', 'native/Helper/FixtureElementPolicy.swift',
    'native/Helper/FixtureElementScan.swift', 'native/Helper/FixtureObservation.swift', 'native/Helper/FixtureRevalidation.swift', 'native/Helper/FixtureAction.swift', 'native/Helper/main.swift', 'scripts/build-helper.mjs'];
  for (const source of sources) { await mkdir(dirname(join(root, source)), { recursive: true }); await copyFile(resolve(source), join(root, source)); }
  const tools = join(root, 'test-bin'); await mkdir(tools);
  const compiler = join(tools, 'swiftc');
  // Test-only compiler boundary: mutate the copied checkout after compilation starts. Never executes native/UI code.
  await writeFile(compiler, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
const target = ${JSON.stringify(fault === 'source' ? 'native/ProcessIdentity.swift' : 'scripts/build-helper.mjs')};
fs.appendFileSync(path.resolve(target), '\\n// changed during test compile\\n');
fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], 'public test binary output');\n`);
  await chmod(compiler, 0o755);
  const result = spawnSync(process.execPath, [join(root, 'scripts/build-helper.mjs')], { cwd: root, env: { ...process.env, PATH: `${tools}:${process.env.PATH}` }, encoding: 'utf8', timeout: 5000 });
  expect(result.status, result.stderr || result.error?.message).not.toBe(0);
  expect(await access(join(root, 'dist/native/helper-manifest.json')).then(() => true, () => false)).toBe(false);
  expect(result.stdout).not.toContain('Built read-only');
  // The stub genuinely ran, so the rejection must not be caused by a missing compiler.
  expect(await readFile(join(root, 'dist/native/CUHelper'), 'utf8')).toBe('public test binary output');
});
