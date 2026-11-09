import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('UNSUPPORTED_PLATFORM: The native helper requires macOS.');
}
const root = process.cwd();
await mkdir(resolve(root, 'dist/native'), { recursive: true });
await mkdir(resolve(root, '.local/swift-module-cache'), { recursive: true });
const sources = ['native/ProcessIdentity.swift', 'native/Helper/FixtureTextPolicy.swift', 'native/Helper/FixtureElementPolicy.swift', 'native/Helper/FixtureElementScan.swift', 'native/Helper/FixtureObservation.swift', 'native/Helper/FixtureRevalidation.swift', 'native/Helper/FixtureAction.swift', 'native/Helper/main.swift'];
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const binary = resolve(root, 'dist/native/CUHelper');
async function sourceDigest() {
  const hash = createHash('sha256');
  for (const source of [...sources, 'scripts/build-helper.mjs']) { hash.update(source); hash.update(await readFile(resolve(root, source))); }
  return hash.digest('hex');
}
const beforeDigest = await sourceDigest();
const result = spawnSync('swiftc', [
  '-swift-version', '6', '-target', `${architecture}-apple-macosx14.0`,
  '-module-cache-path', resolve(root, '.local/swift-module-cache'),
  '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics', '-O', ...sources, '-o', binary,
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (await sourceDigest() !== beforeDigest) throw new Error('ARTIFACT_INVALID: Helper sources changed during compilation. Rebuild the helper.');
await writeFile(resolve(root, 'dist/native/helper-manifest.json'), `${JSON.stringify({
  protocolVersion: 1, commands: ['health', 'observe_fixture', 'revalidate_fixture', 'act_fixture'], architecture, deploymentTarget: '14.0',
  sourceDigest: beforeDigest,
  binaryDigest: createHash('sha256').update(await readFile(binary)).digest('hex'),
  distribution: 'local-development-only',
}, null, 2)}\n`);
console.log('Built fixture helper (read + fixture-only semantic actions). Build reads no UI and dispatches no input.');
