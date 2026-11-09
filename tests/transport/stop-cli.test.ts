import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = ['native/ControlLock.swift', 'native/ControlNamespace.swift', 'native/StopChannel.swift', 'native/StopDiscovery.swift', 'native/StopCLI/main.swift'];
describe('CU-010b2b1: local stop-only CLI build and no-side-effect argument validation', () => {
  it('builds a source-matched stop-only development binary, not an executor', async () => {
    const manifest = JSON.parse(await readFile(resolve('dist/native/stop-manifest.json'), 'utf8'));
    expect(manifest.commands).toEqual(['stop']);
    expect(manifest.distribution).toBe('local-development-only');
    const hash = createHash('sha256');
    for (const source of sources) { hash.update(source); hash.update(await readFile(resolve(source))); }
    expect(manifest.sourceDigest).toBe(hash.digest('hex'));
    expect(manifest.binaryDigest).toBe(createHash('sha256').update(await readFile(resolve('dist/native/CUStop'))).digest('hex'));
  });

  it('prints help without selecting, creating or stopping any production controller', () => {
    const result = spawnSync(resolve('dist/native/CUStop'), ['--help'], { encoding: 'utf8', timeout: 2000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout).toContain('CUStop stop');
    expect(result.stdout).toContain('not a drain confirmation');
    expect(result.stderr).toBe('');
  });

  it.each([[], ['resume'], ['grant'], ['dispatch'], ['stop', '/tmp/other'], ['stop', '--capability', 'fixture_marker']].map((args) => ({ args })))('rejects unsupported arguments $args before contacting a controller', ({ args }) => {
    const result = spawnSync(resolve('dist/native/CUStop'), args, { encoding: 'utf8', timeout: 2000 });
    expect(result.status, result.stderr || result.error?.message).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('CONTROL_STOP_USAGE: Use CUStop stop.\n');
  });
});
