import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';

const sourcePaths = [
  'native/ProcessIdentity.swift', 'native/Helper/FixtureTextPolicy.swift', 'native/Helper/FixtureElementPolicy.swift',
  'native/Helper/FixtureElementScan.swift', 'native/Helper/FixtureObservation.swift', 'native/Helper/FixtureRevalidation.swift',
  'native/Helper/FixtureAction.swift', 'native/Helper/main.swift', 'scripts/build-helper.mjs',
];
const manifestSchema = z.strictObject({
  protocolVersion: z.literal(1), commands: z.tuple([z.literal('health'), z.literal('observe_fixture'), z.literal('revalidate_fixture'), z.literal('act_fixture')]),
  architecture: z.enum(['arm64', 'x86_64']), deploymentTarget: z.literal('14.0'),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), binaryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  distribution: z.literal('local-development-only'),
});
const invalid = () => new Error('ARTIFACT_INVALID: Rebuild the local read-only helper from this checkout. No native process was started.');
function safeOwner(info: BigIntStats): boolean {
  return info.uid === BigInt(process.geteuid!()) && (info.mode & 0o6022n) === 0n;
}
function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode && first.uid === second.uid &&
    first.nlink === second.nlink && first.size === second.size && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

async function requireDirectory(path: string, checkCurrent: () => void): Promise<void> {
  checkCurrent();
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || !safeOwner(info) || await realpath(path) !== path) throw invalid();
  checkCurrent();
}

/** Local development consistency check, not publisher authentication or an atomic path-to-exec guarantee. */
export async function verifyLocalHelper(repositoryRoot: string, checkCurrent: () => void): Promise<string> {
  try {
    if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) || !isAbsolute(repositoryRoot) ||
        normalize(repositoryRoot) !== repositoryRoot || repositoryRoot.endsWith(sep)) throw invalid();
    await requireDirectory(repositoryRoot, checkCurrent);
    const witnesses: Array<{ path: string; info: BigIntStats }> = [];
    const checkedDirectories = new Set<string>();
    const read = async (relative: string, limit: number, executable = false): Promise<Buffer> => {
      let directory = repositoryRoot;
      for (const part of relative.split('/').slice(0, -1)) {
        directory = join(directory, part);
        if (!checkedDirectories.has(directory)) { await requireDirectory(directory, checkCurrent); checkedDirectories.add(directory); }
      }
      const path = join(repositoryRoot, relative);
      checkCurrent();
      const before = await lstat(path, { bigint: true });
      if (!before.isFile() || !safeOwner(before) || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(limit) ||
          (executable && (before.mode & 0o100n) === 0n)) throw invalid();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!sameFile(before, opened)) throw invalid();
        const bytes = Buffer.alloc(Number(opened.size));
        let offset = 0;
        while (offset < bytes.length) {
          checkCurrent();
          const { bytesRead } = await handle.read(bytes, offset, Math.min(65_536, bytes.length - offset), offset);
          if (bytesRead < 1) throw invalid();
          offset += bytesRead;
        }
        checkCurrent();
        const after = await handle.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (!sameFile(opened, after) || !sameFile(opened, named) || await realpath(path) !== path) throw invalid();
        witnesses.push({ path, info: opened });
        return bytes;
      } finally { await handle.close(); }
    };
    const manifestBytes = await read('dist/native/helper-manifest.json', 4096);
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    // The builder emits this exact closed representation. Re-encoding also rejects duplicate keys.
    if (manifestBytes.toString('utf8') !== `${JSON.stringify(manifest, null, 2)}\n` ||
        manifest.architecture !== (process.arch === 'arm64' ? 'arm64' : 'x86_64')) throw invalid();
    const sourceHash = createHash('sha256');
    for (const path of sourcePaths) { sourceHash.update(path); sourceHash.update(await read(path, 262_144)); }
    if (sourceHash.digest('hex') !== manifest.sourceDigest) throw invalid();
    const binary = await read('dist/native/CUHelper', 16 * 1024 * 1024, true);
    checkCurrent();
    if (createHash('sha256').update(binary).digest('hex') !== manifest.binaryDigest) throw invalid();
    requireMachO(binary);
    for (const directory of checkedDirectories) await requireDirectory(directory, checkCurrent);
    await requireDirectory(repositoryRoot, checkCurrent);
    for (const witness of witnesses) {
      checkCurrent();
      if (!sameFile(witness.info, await lstat(witness.path, { bigint: true }))) throw invalid();
    }
    checkCurrent();
    return join(repositoryRoot, 'dist/native/CUHelper');
  } catch { checkCurrent(); throw invalid(); }
}

function requireMachO(bytes: Buffer): void {
  const cpu = process.arch === 'arm64' ? 0x0100000c : 0x01000007;
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu || bytes.readUInt32LE(12) !== 2) throw invalid();
  const commands = bytes.readUInt32LE(16); const commandBytes = bytes.readUInt32LE(20);
  if (commands < 1 || commands > 128 || commandBytes > bytes.length - 32) throw invalid();
  let offset = 32; let versions = 0;
  for (let index = 0; index < commands; index += 1) {
    if (offset + 8 > 32 + commandBytes) throw invalid();
    const kind = bytes.readUInt32LE(offset); const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 !== 0 || offset + size > 32 + commandBytes) throw invalid();
    if (kind === 0x32) {
      if (size < 24 || bytes.readUInt32LE(offset + 8) !== 1 || bytes.readUInt32LE(offset + 12) !== 0x000e0000) throw invalid();
      versions += 1;
    }
    offset += size;
  }
  if (offset !== 32 + commandBytes || versions !== 1) throw invalid();
}
