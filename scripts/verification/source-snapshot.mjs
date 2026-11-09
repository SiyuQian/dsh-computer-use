import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const directories = ['src', 'native', 'scripts', 'tests'];
const rootFiles = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json', 'cordis.patch.yml', '.gitignore'];
function invalid() { return new Error('VERIFICATION_SOURCE_UNAVAILABLE: The fixed source scope could not be fingerprinted.'); }
function same(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

/** Fixed-scope developer consistency evidence, not a full dependency closure, atomic snapshot, signing or same-UID isolation. */
export async function sourceSnapshot(root) {
  try {
    const paths = [...rootFiles]; const identities = new Map();
    async function visit(relative) {
      const before = await lstat(join(root, relative), { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw invalid();
      identities.set(relative, before);
      for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && !entry.isSymbolicLink()) paths.push(path);
        else throw invalid();
        if (paths.length > 4096) throw invalid();
      }
    }
    for (const directory of directories) await visit(directory);
    const hash = createHash('sha256'); let bytes = 0;
    for (const relative of paths.sort()) {
      const path = join(root, relative); const before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4n * 1024n * 1024n) throw invalid();
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!same(before, await file.stat({ bigint: true }))) throw invalid();
        const contents = await file.readFile(); bytes += contents.length;
        if (bytes > 32 * 1024 * 1024 || BigInt(contents.length) !== before.size || !same(before, await file.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true }))) throw invalid();
        hash.update(JSON.stringify([relative, contents.length])); hash.update(contents);
        identities.set(relative, before);
      } finally { await file.close(); }
    }
    for (const [relative, before] of identities) if (!same(before, await lstat(join(root, relative), { bigint: true }))) throw invalid();
    return { digest: hash.digest('hex'), files: paths.length, bytes };
  } catch { throw invalid(); }
}
