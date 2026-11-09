import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';

const root = process.cwd();
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.private, true, 'Development packages must not be publishable.');
assert.equal(manifest.engines.dsh, '0.2.2-rc.1');
for (const path of [manifest.main, manifest.types, 'lib/contracts/index.js', 'lib/contracts/index.d.ts', manifest.dsh.bundle.patch]) {
  const target = resolve(root, path);
  assert.ok(target.startsWith(`${root}${sep}`), 'Package entries must stay within the checkout.');
  await access(target);
}
assert.deepEqual(manifest.files, ['lib/', 'cordis.patch.yml', 'README.md']);
const entry = await import(pathToFileURL(resolve(root, manifest.main)).href);
const ctx = new Context();
try {
  await ctx.plugin(SystemPrompt).inertia;
  await ctx.plugin(ToolsService).inertia;
  const plugin = ctx.plugin(entry);
  await plugin.inertia;
  assert.deepEqual(ctx.tools.definitions().map((tool) => tool.name), ['cu_status']);
  await plugin.dispose();
  assert.equal(ctx.tools.get('cu_status'), undefined);
} finally {
  await ctx.fiber.dispose();
}
console.log('Built bundle verified: default registers cu_status only; fixture tools require explicit fixtureControl config.');
