import { spawn, spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, realpath, rm, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NativeController } from '../../src/backend/macos/controller.js';

let root: string;
beforeAll(async () => { root = await realpath(await mkdtemp('/tmp/cu-controller-')); });
afterAll(async () => {
  if (!root) return; const exact = await realpath(root);
  if (!exact.startsWith('/private/tmp/cu-controller-')) throw new Error('Refuse cleanup outside test-owned parent.');
  await rm(exact, { recursive: true });
});
async function parent(name: string) { const path = join(root, name); await mkdir(path, { mode: 0o700 }); return path; }
function stopClient(path: string) {
  return new Promise<number | null>((done) => {
    const child = spawn(resolve('dist/native/CUController'), ['--stop', '--test-parent', path], { stdio: 'ignore' });
    child.once('close', done);
  });
}

describe('CU-010b2b2: per-user native controller gate and independent stop', () => {
  it('grants one dispatch slot at a time and refuses a second controller for the same namespace', async () => {
    const path = await parent('unique');
    const first = await NativeController.start(resolve('.'), { testParent: path });
    try {
      await expect(NativeController.start(resolve('.'), { testParent: path })).rejects.toThrow('CONTROL_BUSY');
      const slot = await first.begin();
      await expect(first.begin()).rejects.toThrow('CONTROL_BUSY');
      await slot.end();
      const again = await first.begin(); await again.end();
    } finally { await first.close(); }
    const next = await NativeController.start(resolve('.'), { testParent: path }); await next.close();
  });

  it('lets an independent process revoke; revocation is sticky and aborts the live signal', async () => {
    const path = await parent('stop');
    const controller = await NativeController.start(resolve('.'), { testParent: path });
    try {
      const slot = await controller.begin();
      expect(await stopClient(path)).toBe(0);
      await expect.poll(() => controller.signal.aborted, { timeout: 2000 }).toBe(true);
      expect(slot.signal.aborted).toBe(true);
      await slot.end();
      await expect(controller.begin()).rejects.toThrow('CONTROL_STOPPED');
      expect(controller.status()).toBe('revoked');
    } finally { await controller.close(); }
  });

  it('reports stop unavailable when no controller is running and never creates the namespace from the stop client', async () => {
    const path = await parent('none');
    expect(await stopClient(path)).toBe(2);
  });

  it('closes cleanly and releases the lock even while revoked', async () => {
    const path = await parent('close');
    const controller = await NativeController.start(resolve('.'), { testParent: path });
    controller.revokeFromHost();
    await expect(controller.begin()).rejects.toThrow('CONTROL_STOPPED');
    await controller.close();
    const next = await NativeController.start(resolve('.'), { testParent: path }); await next.close();
  });

  it('rejects arbitrary argv on the controller binary', () => {
    const result = spawnSync(resolve('dist/native/CUController'), ['--script', 'x'], { encoding: 'utf8', timeout: 2000 });
    expect(result.status).toBe(2); expect(result.stdout).toBe('');
  });

  it('refuses to start a controller whose binary does not match its build manifest', async () => {
    const copy = join(root, 'repo'); await mkdir(join(copy, 'dist/native'), { recursive: true });
    for (const file of ['CUController', 'controller-manifest.json']) await copyFile(resolve('dist/native', file), join(copy, 'dist/native', file));
    await cp(resolve('native'), join(copy, 'native'), { recursive: true }); await mkdir(join(copy, 'scripts'));
    await copyFile(resolve('scripts/build-controller.mjs'), join(copy, 'scripts/build-controller.mjs'));
    const path = await parent('artifact');
    const ok = await NativeController.start(copy, { testParent: path }); await ok.close();
    await appendFile(join(copy, 'dist/native/CUController'), 'tampered');
    await expect(NativeController.start(copy, { testParent: path })).rejects.toThrow('ARTIFACT_INVALID');
  });

  it('measures independent stop latency: the host signal aborts within 500 ms of the stop client returning', async () => {
    const path = await parent('latency');
    const controller = await NativeController.start(resolve('.'), { testParent: path });
    try {
      const slot = await controller.begin();
      expect(await stopClient(path)).toBe(0);
      const returned = performance.now();
      await new Promise<void>((done) => { if (slot.signal.aborted) done(); else slot.signal.addEventListener('abort', () => done(), { once: true }); });
      expect(performance.now() - returned).toBeLessThan(500);
    } finally { await controller.close(); }
  });
});
