import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { probeNativeHealth } from '../lib/backend/macos/health.js';
import { observeFixtureSnapshot } from '../lib/backend/macos/observe.js';
import { actFixtureElement } from '../lib/backend/macos/act.js';

// Explicit native action lane (CU-012a). Owned fixture only, public test values only. Missing TCC exits 3 / NOT_RUN.
// The fixture's own state file is the independent effect witness; helper readback is not trusted on its own.
const ctx = new Context();
await ctx.plugin(LocalSubprocessRuntime).inertia;
let directory;
let fixture;
const state = async () => JSON.parse(await readFile(join(directory, 'fixture-state.json'), 'utf8'));
try {
  const health = await probeNativeHealth(ctx.subprocess, process.cwd(), { signal: AbortSignal.timeout(5000) });
  if (!health.permissions.accessibility) {
    console.error('NOT_RUN: Accessibility permission is absent. No fixture was launched and no permission was requested.');
    process.exitCode = 3;
  } else {
    directory = await mkdtemp(join(tmpdir(), 'cu-native-action-'));
    fixture = ctx.subprocess.spawn({
      argv: [resolve('dist/native/CUFixture.app/Contents/MacOS/CUFixture'), '--observe-host', '--state-dir', directory],
      cwd: process.cwd(), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 256 } },
      graceMs: 100, signal: AbortSignal.timeout(20_000),
    });
    const ready = await new Promise((done, reject) => {
      let raw = '';
      fixture.stdout.on('data', (chunk) => {
        raw += chunk.toString('utf8');
        if (raw.length > 2048) reject(new Error('Fixture readiness exceeded its bound.'));
        else if (raw.endsWith('\n')) { try { done(JSON.parse(raw)); } catch { reject(new Error('Fixture readiness was not valid JSON.')); } }
      });
      fixture.done.then(() => reject(new Error('Fixture exited before readiness.')), reject);
    });
    const primary = ready.windows.find((window) => window.windowKey === 'primary');
    const target = { pid: ready.pid, processStart: ready.processStart, ...primary };
    const observed = await observeFixtureSnapshot(ctx.subprocess, process.cwd(), target, { signal: AbortSignal.timeout(5000) });
    assert.equal(observed.status, 'ok');
    const node = (identifier) => observed.snapshot.nodes.find((candidate) => candidate.identifier === identifier);
    const text = node('fixture.text'); const submit = node('fixture.submit');
    assert.ok(text?.elementInstance && submit?.elementInstance);
    assert.equal((await state()).submitCount, 0);

    const set = await actFixtureElement(ctx.subprocess, process.cwd(), target,
      { identifier: 'fixture.text', instance: text.elementInstance, operation: 'set_value' }, 'PUBLIC_NATIVE_TEST', { signal: AbortSignal.timeout(5000) });
    assert.deepEqual({ status: set.status, execution: set.execution, readback: set.readback }, { status: 'dispatched', execution: 'completed', readback: 'match' });
    assert.ok(!JSON.stringify(set).includes('PUBLIC_NATIVE_TEST'));

    const pressed = await actFixtureElement(ctx.subprocess, process.cwd(), target,
      { identifier: 'fixture.submit', instance: submit.elementInstance, operation: 'press' }, undefined, { signal: AbortSignal.timeout(5000) });
    assert.equal(pressed.status, 'dispatched'); assert.equal(pressed.execution, 'completed');
    const after = await state();
    assert.equal(after.submitCount, 1, 'Fixture state must independently show exactly one submit.');
    assert.equal(after.text, 'PUBLIC_NATIVE_TEST', 'Fixture state must independently show the written public value.');

    // Negative: stale element instance must not dispatch and fixture state must not change.
    const stale = await actFixtureElement(ctx.subprocess, process.cwd(), target,
      { identifier: 'fixture.submit', instance: 'element_replaced', operation: 'press' }, undefined, { signal: AbortSignal.timeout(5000) });
    assert.equal(stale.status, 'error'); assert.equal(stale.code, 'TARGET_CHANGED');
    // Negative: replaced window instance.
    const wrongWindow = await actFixtureElement(ctx.subprocess, process.cwd(), { ...target, windowInstance: 'window_replaced' },
      { identifier: 'fixture.submit', instance: submit.elementInstance, operation: 'press' }, undefined, { signal: AbortSignal.timeout(5000) });
    assert.equal(wrongWindow.status, 'error'); assert.equal(wrongWindow.code, 'TARGET_CHANGED');
    assert.equal((await state()).submitCount, 1, 'Rejected actions must leave fixture state unchanged.');
    console.log('Native fixture-only semantic actions passed: set_value + press each dispatched once, independently verified; stale targets refused.');
  }
} finally {
  if (fixture) { fixture.terminate(); assert.equal(await fixture.waitForExit(AbortSignal.timeout(2000)), true); }
  await ctx.fiber.dispose();
  if (directory) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir(), 'cu-native-action-'))) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(absolute, { recursive: true });
  }
}
