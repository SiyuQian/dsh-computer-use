import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('UNSUPPORTED_PLATFORM: The AppKit fixture requires an Apple Silicon or Intel Mac.');
}
const root = process.cwd();
const output = resolve(root, 'dist/native/CUFixture.app/Contents');
await mkdir(resolve(output, 'MacOS'), { recursive: true });
await mkdir(resolve(root, '.local/swift-module-cache'), { recursive: true });
const sources = ['native/ProcessIdentity.swift', 'native/Fixture/FixtureState.swift', 'native/Fixture/FixtureWindow.swift', 'native/Fixture/main.swift'];
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const target = `${architecture}-apple-macosx14.0`;
const binary = resolve(output, 'MacOS/CUFixture');
const result = spawnSync('swiftc', [
  '-swift-version', '6', '-target', target, '-module-cache-path', resolve(root, '.local/swift-module-cache'),
  '-framework', 'AppKit', '-O', ...sources, '-o', binary,
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.siyuqian.computer-use.fixture</string>
<key>CFBundleName</key><string>Computer Use Fixture</string>
<key>CFBundleExecutable</key><string>CUFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
await writeFile(resolve(output, 'Info.plist'), plist);
const sourceHash = createHash('sha256');
for (const path of sources) { sourceHash.update(path); sourceHash.update(await readFile(resolve(root, path))); }
await writeFile(resolve(root, 'dist/native/fixture-manifest.json'), `${JSON.stringify({
  bundleId: 'dev.siyuqian.computer-use.fixture',
  deploymentTarget: '14.0', architecture,
  sourceDigest: sourceHash.digest('hex'),
  binaryDigest: createHash('sha256').update(await readFile(binary)).digest('hex'),
  distribution: 'local-development-only',
}, null, 2)}\n`);
console.log(`Built owned AppKit fixture (${target}). No app was launched.`);
