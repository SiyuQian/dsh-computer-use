import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('UNSUPPORTED_PLATFORM: The native controller requires macOS.');
}
const root = process.cwd();
await mkdir(resolve(root, 'dist/native'), { recursive: true });
await mkdir(resolve(root, '.local/swift-module-cache'), { recursive: true });
const sources = ['native/ControlLock.swift', 'native/ControlNamespace.swift', 'native/StopChannel.swift', 'native/StopDiscovery.swift', 'native/Controller/main.swift'];
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const binary = resolve(root, 'dist/native/CUController');
const result = spawnSync('swiftc', [
  '-swift-version', '6', '-target', `${architecture}-apple-macosx14.0`,
  '-module-cache-path', resolve(root, '.local/swift-module-cache'), '-O', ...sources, '-o', binary,
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const sourceHash = createHash('sha256');
for (const source of sources) { sourceHash.update(source); sourceHash.update(await readFile(resolve(root, source))); }
await writeFile(resolve(root, 'dist/native/controller-manifest.json'), `${JSON.stringify({
  protocolVersion: 1, commands: ['serve', 'stop'], architecture, deploymentTarget: '14.0',
  sourceDigest: sourceHash.digest('hex'), binaryDigest: createHash('sha256').update(await readFile(binary)).digest('hex'),
  distribution: 'local-development-only',
}, null, 2)}\n`);
console.log('Built per-user controller (lock + stop listener only). Nothing was started or installed.');
