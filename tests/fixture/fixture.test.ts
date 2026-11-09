import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import { observeFixtureSnapshot } from '../../src/backend/macos/observe.js';
import { probeNativeHealth } from '../../src/backend/macos/health.js';
import { revalidateFixtureElement } from '../../src/backend/macos/revalidate.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'cu-fixture-'))) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(directory, { recursive: true });
  }
});

// AppKit cannot execute on another OS. Do not silently skip this required lane.
describe('CU-004: owned AppKit fixture', () => {
  it('builds an app with a stable identity before native tests run', async () => {
    expect(process.platform, 'AppKit fixture tests require macOS. Run another lane explicitly on other systems.').toBe('darwin');
    const exists = await access(resolve('dist/native/CUFixture.app/Contents/MacOS/CUFixture')).then(() => true, () => false);
    expect(exists, 'Build the fixture app before running this acceptance lane.').toBe(true);
  });

  it('self-tests real AppKit controls and writes independent public test state without TCC or input injection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cu-fixture-'));
    temporary.push(directory);
    const result = spawnSync(resolve('dist/native/CUFixture.app/Contents/MacOS/CUFixture'), ['--self-test', '--state-dir', directory], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      bundleId: 'dev.siyuqian.computer-use.fixture',
      shownWindows: 0,
      injectedInput: false,
      checks: ['controls', 'set_value', 'submit', 'secure_redaction', 'replace', 'reorder', 'save_copy', 'reset', 'window_isolation', 'delayed_cancel', 'delayed_complete', 'element_witness'],
    });
    const state = JSON.parse(await readFile(join(directory, 'fixture-state.json'), 'utf8'));
    expect(state).toEqual({ text: '', submitCount: 0, revision: 0, layout: 'normal', replacement: 0 });
    expect(await readFile(join(directory, 'saved-copy.txt'), 'utf8')).toBe('fixture-edited');
    expect(await readFile(join(directory, 'fixture-state.json'), 'utf8')).not.toContain('fixture-password');
  });

  it('exposes exact owned-fixture process identity in hidden mode and fails closed on AX permission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cu-fixture-'));
    temporary.push(directory);
    const ctx = new Context();
    await ctx.plugin(LocalSubprocessRuntime).inertia;
    const processHandle = ctx.subprocess.spawn({
      argv: [resolve('dist/native/CUFixture.app/Contents/MacOS/CUFixture'), '--observe-host', '--state-dir', directory],
      cwd: resolve('.'), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 256 } },
      graceMs: 100, signal: AbortSignal.timeout(5000),
    });
    try {
      const rawReady = await new Promise<string>((resolveReady, reject) => {
        let raw = '';
        processHandle.stdout?.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); if (raw.endsWith('\n')) resolveReady(raw); });
        processHandle.done.then(() => { if (!raw.endsWith('\n')) reject(new Error('Fixture exited before readiness.')); }, reject);
      });
      const ready = JSON.parse(rawReady);
      expect(ready).toMatchObject({ bundleId: 'dev.siyuqian.computer-use.fixture', shownWindows: 0, injectedInput: false });
      expect(ready.processStart).toMatch(/^process_[0-9]+_[0-9]+$/);
      const primaryWindow = ready.windows[0];
      expect(primaryWindow.windowId).toBeGreaterThan(0);
      expect(primaryWindow.windowInstance).toMatch(/^window_[A-Za-z0-9-]+$/);
      expect(ready.windows[1].windowId).not.toBe(primaryWindow.windowId);
      expect(ready.windows[1].windowInstance).not.toBe(primaryWindow.windowInstance);
      const health = await probeNativeHealth(ctx.subprocess, resolve('.'), { signal: new AbortController().signal });
      const denied = await observeFixtureSnapshot(ctx.subprocess, resolve('.'), {
        pid: ready.pid, processStart: ready.processStart, ...primaryWindow,
      }, { signal: new AbortController().signal });
      if (!health.permissions.accessibility) {
        expect(denied.status === 'error' && denied.code).toBe('READ_DENIED');
      } else {
        // Hidden windows may not be exposed in AX. Permission is not a successful observation assertion.
        expect(denied.status === 'error' ? ['TARGET_CHANGED', 'CAPABILITY_UNAVAILABLE'].includes(denied.code) : denied.snapshot.windowKey === 'primary').toBe(true);
      }
      const revalidation = await revalidateFixtureElement(ctx.subprocess, resolve('.'), {
        pid: ready.pid, processStart: ready.processStart, ...primaryWindow,
      }, { identifier: 'fixture.text', instance: 'element_fixture_unknown', operation: 'set_value' }, { signal: new AbortController().signal });
      expect(revalidation.dispatchable).toBe(false);
      if (!health.permissions.accessibility) expect(revalidation.status === 'error' && revalidation.code).toBe('READ_DENIED');
      else expect(revalidation.status === 'error' && ['TARGET_CHANGED', 'TARGET_AMBIGUOUS', 'CAPABILITY_UNAVAILABLE'].includes(revalidation.code)).toBe(true);
      const stale = await observeFixtureSnapshot(ctx.subprocess, resolve('.'), {
        pid: ready.pid, processStart: 'process_restarted', ...primaryWindow,
      }, { signal: new AbortController().signal });
      expect(stale.status === 'error' && stale.code).toBe('TARGET_CHANGED');
      const revalidationStale = await revalidateFixtureElement(ctx.subprocess, resolve('.'), {
        pid: ready.pid, processStart: 'process_restarted', ...primaryWindow,
      }, { identifier: 'fixture.text', instance: 'element_fixture_unknown', operation: 'set_value' }, { signal: new AbortController().signal });
      expect(revalidationStale.status === 'error' && revalidationStale.code).toBe('TARGET_CHANGED');
      processHandle.stdin?.end();
      const result = await processHandle.done;
      expect(result.exitCode, processHandle.collected.stderr?.readFrom(0).text).toBe(0);
      // The fixture has now exited. A formerly valid PID must not permit a later AX read.
      const changed = await observeFixtureSnapshot(ctx.subprocess, resolve('.'), {
        pid: ready.pid, processStart: ready.processStart, ...primaryWindow,
      }, { signal: new AbortController().signal });
      expect(changed.status === 'error' && changed.code).toBe('TARGET_CHANGED');
      expect(health.capabilities.mutation).toBe('fixture_semantic_only');
    } finally {
      processHandle.terminate();
      await processHandle.waitForExit(AbortSignal.timeout(2000));
      await ctx.fiber.dispose();
    }
  });

  it('rejects script or unknown startup arguments without starting the application', () => {
    const result = spawnSync(resolve('dist/native/CUFixture.app/Contents/MacOS/CUFixture'), ['--script', 'echo private'], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('INVALID_ARGUMENTS');
    expect(result.stderr).not.toContain('echo private');
  });
});
