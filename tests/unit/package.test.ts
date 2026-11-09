import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CU-002: bundle entry and package smoke', () => {
  it('provides a package verifier instead of declaring a nonexistent script', async () => {
    const entry = resolve('scripts/check-package.mjs');
    const available = await access(entry, constants.R_OK).then(() => true, () => false);
    expect(available, 'A development bundle must provide its declared package verifier.').toBe(true);
  });

  it('loads the built entry and does not package node_modules, private inspection files, or source-only entry points', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/check-package.mjs')], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('diagnostic-only bundle verified');
  });

  it('uses an exact host engine baseline and remains non-publishable by default', async () => {
    const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    expect(manifest.private).toBe(true);
    expect(manifest.engines.dsh).toBe('0.2.2-rc.1');
    expect(manifest.main).toBe('lib/index.js');
  });
});
