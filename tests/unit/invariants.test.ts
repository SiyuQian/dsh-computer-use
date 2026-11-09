import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'cu-boundary-'))) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(directory, { recursive: true });
  }
});
async function check(source: string, path = 'src/contracts/example.ts') {
  const directory = await mkdtemp(join(tmpdir(), 'cu-boundary-'));
  directories.push(directory);
  const target = join(directory, path);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, source);
  return spawnSync(process.execPath, [resolve('scripts/check-invariants.mjs'), directory], { encoding: 'utf8' });
}

describe('CU-002: module boundary sensor', () => {
  it('accepts pure contracts and local contract imports', async () => {
    expect((await check("import { z } from 'zod'; export const value = z.string();")).status).toBe(0);
    expect((await check("import { value } from './other.js'; export { value };")).status).toBe(0);
  });

  it.each([
    "import { spawn } from 'node:child_process';",
    "export { Context } from '@deepseek-ai/cordis';",
    "import '../host-adapter/context.js';",
    "import x from '/absolute/host.js';",
    "const data = await import('node:fs');",
    "const data = require('node:fs');",
    'const target = "node:fs"; const data = await import(target);',
  ])('rejects a contract dependency that reaches host or native capabilities: %s', async (source) => {
    const result = await check(source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BOUNDARY_VIOLATION');
  });
});
