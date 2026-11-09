import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeNativeHealth } from '../../src/backend/macos/health.js';

const roots: string[] = [];
const sources = ['native/ProcessIdentity.swift', 'native/Helper/FixtureTextPolicy.swift', 'native/Helper/FixtureElementPolicy.swift', 'native/Helper/FixtureElementScan.swift', 'native/Helper/FixtureObservation.swift', 'native/Helper/FixtureRevalidation.swift', 'native/Helper/main.swift', 'scripts/build-helper.mjs'];
const manifestPath = 'dist/native/helper-manifest.json'; const binaryPath = 'dist/native/CUHelper';
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const exact = await realpath(root);
    if (!exact.startsWith('/private/tmp/cu-helper-artifact-')) throw new Error('Refuse cleanup outside test-owned checkout.');
    await rm(exact, { recursive: true });
  }
});
async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/cu-helper-artifact-')); roots.push(root);
  for (const path of [...sources, manifestPath, binaryPath]) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await copyFile(resolve(path), join(root, path));
  }
  await chmod(join(root, binaryPath), 0o755);
  return { root, manifest: join(root, manifestPath), binary: join(root, binaryPath) };
}
async function updateManifest(root: string, change: (manifest: Record<string, unknown>) => void) {
  const path = join(root, manifestPath); const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  change(manifest); await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
async function denied(root: string, code = 'ARTIFACT_INVALID') {
  let spawns = 0;
  const result = await probeNativeHealth({ spawn() { spawns += 1; throw new Error('private-fixture-value: must not spawn'); } }, root, { signal: new AbortController().signal }).catch((error: unknown) => error);
  expect(String(result)).toContain(code); expect(String(result)).not.toContain('private-fixture-value'); expect(spawns).toBe(0);
}

describe('CU-024a: fixed local helper integrity admission, not code-signing authentication', () => {
  it('refuses a stale source checkout before a subprocess provider can execute anything', async () => {
    const f = await fixture(); await appendFile(join(f.root, sources[0]!), '\n// public test source change\n'); await denied(f.root);
  });

  it('admits the actual freshly built helper and reports read-only health through the real managed provider', async () => {
    const ctx = new Context(); await ctx.plugin(LocalSubprocessRuntime).inertia;
    try {
      const result = await probeNativeHealth(ctx.subprocess, resolve('.'), { signal: AbortSignal.timeout(5000) });
      expect(result.status).toBe('ok'); expect(result.capabilities).toEqual({ axObservation: false, mutation: false, keyboard: false, pointer: false });
    } finally { await ctx.fiber.dispose(); }
  });

  it.each(['binary_changed', 'binary_missing', 'manifest_missing', 'source_missing', 'recipe_changed'])(
    'refuses %s rather than executing an unchecked development artifact', async (fault) => {
      const f = await fixture();
      if (fault === 'binary_changed') await appendFile(f.binary, 'public-test-replacement');
      if (fault === 'binary_missing') await rm(f.binary);
      if (fault === 'manifest_missing') await rm(f.manifest);
      if (fault === 'source_missing') await rm(join(f.root, sources[0]!));
      if (fault === 'recipe_changed') await appendFile(join(f.root, 'scripts/build-helper.mjs'), '\n// changed compile recipe\n');
      await denied(f.root);
    });

  it.each(['version', 'command', 'architecture', 'deployment', 'distribution', 'extra', 'hash', 'invalid_json', 'duplicate'])(
    'rejects %s manifest metadata before spawning without echoing it', async (fault) => {
      const f = await fixture();
      if (fault === 'invalid_json') await writeFile(f.manifest, 'private-fixture-value');
      else if (fault === 'duplicate') {
        const raw = await readFile(f.manifest, 'utf8'); await writeFile(f.manifest, raw.replace('"protocolVersion": 1', '"protocolVersion": 1, "protocolVersion": 1'));
      } else await updateManifest(f.root, (manifest) => {
        if (fault === 'version') manifest.protocolVersion = 2;
        if (fault === 'command') manifest.commands = ['health', 'script'];
        if (fault === 'architecture') manifest.architecture = process.arch === 'arm64' ? 'x86_64' : 'arm64';
        if (fault === 'deployment') manifest.deploymentTarget = '13.0';
        if (fault === 'distribution') manifest.distribution = 'signed-and-notarized';
        if (fault === 'extra') manifest.path = '../private-fixture-value';
        if (fault === 'hash') manifest.sourceDigest = '0'.repeat(64);
      });
      await denied(f.root);
    });

  it.each(['manifest', 'binary', 'source', 'directory', 'root'])(
    'refuses a symlinked %s path instead of treating alias content as an artifact', async (fault) => {
      const f = await fixture();
      if (fault === 'root') {
        const alias = join(f.root, 'alias'); await symlink(f.root, alias); await denied(alias); return;
      }
      if (fault === 'directory') {
        const original = join(f.root, 'native'); const saved = join(f.root, 'native-saved');
        if (await realpath(original) !== original || !original.startsWith(`${f.root}/`)) throw new Error('Refuse moving a non-test directory.');
        await rename(original, saved); await symlink(saved, original); await denied(f.root); return;
      }
      const path = fault === 'manifest' ? f.manifest : fault === 'binary' ? f.binary : join(f.root, sources[0]!);
      const saved = `${path}.test-original`; await copyFile(path, saved); await rm(path); await symlink(saved, path); await denied(f.root);
    });

  it.each(['manifest', 'binary', 'source'])('refuses a hardlinked %s file', async (fault) => {
    const f = await fixture(); const path = fault === 'manifest' ? f.manifest : fault === 'binary' ? f.binary : join(f.root, sources[0]!);
    await link(path, `${path}.test-link`); await denied(f.root);
  });

  it.each(['manifest_write', 'binary_write', 'source_write', 'binary_not_executable', 'setuid'])(
    'refuses unsafe %s modes without silently repairing them', async (fault) => {
      const f = await fixture(); const path = fault.startsWith('manifest') ? f.manifest : fault.startsWith('source') ? join(f.root, sources[0]!) : f.binary;
      await chmod(path, fault === 'binary_not_executable' ? 0o644 : fault === 'setuid' ? 0o4755 : 0o666); await denied(f.root);
    });

  it.each(['manifest', 'source', 'binary'])('rejects an oversized %s before unbounded reads', async (fault) => {
    const f = await fixture(); const path = fault === 'manifest' ? f.manifest : fault === 'binary' ? f.binary : join(f.root, sources[0]!);
    await truncate(path, fault === 'manifest' ? 4097 : fault === 'source' ? 262_145 : 16 * 1024 * 1024 + 1); await denied(f.root);
  });

  it('rejects text substituted for the binary even if its manifest digest is updated', async () => {
    const f = await fixture(); const bytes = Buffer.from('not an executable Mach-O'); await writeFile(f.binary, bytes); await chmod(f.binary, 0o755);
    await updateManifest(f.root, (manifest) => { manifest.binaryDigest = createHash('sha256').update(bytes).digest('hex'); }); await denied(f.root);
  });

  it.each(['magic', 'cpu', 'filetype', 'command_size', 'platform', 'min_os'])(
    'rejects a %s Mach-O mismatch even with a matching binary digest', async (fault) => {
      const f = await fixture(); const bytes = await readFile(f.binary);
      if (fault === 'magic') bytes.writeUInt32LE(0, 0);
      if (fault === 'cpu') bytes.writeUInt32LE(process.arch === 'arm64' ? 0x01000007 : 0x0100000c, 4);
      if (fault === 'filetype') bytes.writeUInt32LE(6, 12);
      if (fault === 'command_size') bytes.writeUInt32LE(0, 36);
      if (fault === 'platform' || fault === 'min_os') {
        let offset = 32; let found = false;
        for (let index = 0; index < bytes.readUInt32LE(16); index += 1) {
          if (bytes.readUInt32LE(offset) === 0x32) { bytes.writeUInt32LE(fault === 'platform' ? 2 : 0x000d0000, offset + (fault === 'platform' ? 8 : 12)); found = true; break; }
          offset += bytes.readUInt32LE(offset + 4);
        }
        expect(found).toBe(true);
      }
      await writeFile(f.binary, bytes); await updateManifest(f.root, (manifest) => { manifest.binaryDigest = createHash('sha256').update(bytes).digest('hex'); }); await denied(f.root);
    });

  it.each(['read_error', 'zero_read', 'short_read', 'close_error', 'deadline', 'cancel'])(
    'handles real file I/O %s without leaking open descriptors or starting an unchecked helper', async (fault) => {
      const f = await fixture();
      const result = spawnSync(process.execPath, [resolve('tests/support/helper-artifact-probe.mjs'), f.root, fault], { encoding: 'utf8', timeout: 5000 });
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      const outcome = JSON.parse(result.stdout);
      expect(outcome.rejected).toBe(true); expect(outcome.spawns).toBe(fault === 'short_read' ? 1 : 0);
      expect(outcome.opened).toBeGreaterThan(0); expect(outcome.closed).toBe(outcome.opened);
      if (fault === 'short_read') expect(outcome.readCalls).toBeGreaterThan(50);
    });

  it.each(['deadline_after_done', 'deadline_after_parse', 'cancel_after_parse'])(
    'refuses %s before publishing a late native response even when the event-loop timer has not fired', async (fault) => {
      const f = await fixture();
      const result = spawnSync(process.execPath, [resolve('tests/support/helper-artifact-probe.mjs'), f.root, fault], { encoding: 'utf8', timeout: 5000 });
      expect(result.status, result.stderr || result.error?.message).toBe(0);
      const outcome = JSON.parse(result.stdout);
      expect(outcome.rejected, outcome.error).toBe(true); expect(outcome.spawns).toBe(1); expect(outcome.closed).toBe(outcome.opened);
    });

  it('does not cache successful integrity admission across subsequent native read requests', async () => {
    const f = await fixture(); let spawns = 0;
    const provider = { spawn(_spec: SubprocessSpawnSpec): never { spawns += 1; throw new Error('controlled provider refusal'); } };
    await expect(probeNativeHealth(provider, f.root, { signal: new AbortController().signal })).rejects.toThrow('NATIVE_TRANSPORT_ERROR'); expect(spawns).toBe(1);
    await appendFile(f.binary, 'public-test-change');
    await expect(probeNativeHealth(provider, f.root, { signal: new AbortController().signal })).rejects.toThrow('ARTIFACT_INVALID'); expect(spawns).toBe(1);
  });
});
