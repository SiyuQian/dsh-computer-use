import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const owned = [];
afterEach(async () => { for (const root of owned.splice(0)) { const absolute = await realpath(root); if (!absolute.startsWith('/private/tmp/cu-source-snapshot-')) throw new Error('Refuse cleanup outside exact test fixture.'); await rm(absolute, { recursive: true }); } });
async function api() {
  const url = new URL('../../scripts/verification/source-snapshot.mjs', import.meta.url); expect(await access(url).then(() => true, () => false), 'A snapshot requires a real source enumerator.').toBe(true); return import(url.href);
}
async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/cu-source-snapshot-')); owned.push(root);
  for (const dir of ['src', 'native', 'tests', 'scripts', 'docs', '.local', 'node_modules', 'lib', 'dist']) await mkdir(join(root, dir));
  for (const name of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json', 'cordis.patch.yml', '.gitignore']) await writeFile(join(root, name), 'public-fixture');
  await writeFile(join(root, 'src', 'main.ts'), 'public-code'); return root;
}
describe('CU-002c: fixed-scope source fingerprint, not publisher signing or an execution sandbox', () => {
  it('is deterministic and excludes generated output, local data, docs, dependencies and unrelated user files', async () => {
    const module = await api(); const root = await fixture(); const before = await module.sourceSnapshot(root);
    for (const name of ['.local/private', 'node_modules/dependency', 'lib/generated', 'dist/generated', 'docs/progress.md', 'private-unrelated']) await writeFile(join(root, name), 'PRIVATE_NOT_SOURCE');
    expect(await module.sourceSnapshot(root)).toEqual(before); expect(before).toMatchObject({ files: 7 }); expect(before.digest).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(before)).not.toContain('PRIVATE');
  });
  it.each(['src/main.ts', 'scripts/new.mjs', 'native/main.swift', 'tests/new.test.mjs', 'tsconfig.json', 'pnpm-lock.yaml'])('changes for implementation input %s even while untracked', async (path) => {
    const module = await api(); const root = await fixture(); const before = await module.sourceSnapshot(root); await writeFile(join(root, path), 'changed-public-code');
    expect((await module.sourceSnapshot(root)).digest).not.toBe(before.digest);
  });
  it.each(['file', 'directory'])('rejects a symlink %s without following it to unrelated or private data', async (kind) => {
    const module = await api(); const root = await fixture(); await writeFile(join(root, '.local', 'private'), 'PRIVATE_CONTENT');
    await symlink(join(root, kind === 'file' ? '.local/private' : '.local'), join(root, 'src', 'linked'));
    await expect(module.sourceSnapshot(root)).rejects.toThrow('VERIFICATION_SOURCE_UNAVAILABLE');
  });
  it('binds path names and file lengths, not just a concatenation of content bytes', async () => {
    const module = await api(); const root = await fixture(); await writeFile(join(root, 'src/a'), 'ab'); await writeFile(join(root, 'src/b'), 'c');
    const first = await module.sourceSnapshot(root); await writeFile(join(root, 'src/a'), 'a'); await writeFile(join(root, 'src/b'), 'bc');
    expect((await module.sourceSnapshot(root)).digest).not.toBe(first.digest);
  });
  it('rejects missing mandatory roots rather than silently fingerprinting an incomplete source set', async () => {
    const module = await api(); const root = await fixture(); const exact = join(root, 'tsconfig.json'); expect(exact).toBe(`${root}/tsconfig.json`); await rm(exact);
    await expect(module.sourceSnapshot(root)).rejects.toThrow('VERIFICATION_SOURCE_UNAVAILABLE');
  });
});
