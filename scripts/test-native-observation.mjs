import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { probeNativeHealth } from '../lib/backend/macos/health.js';
import { observeFixtureSnapshot } from '../lib/backend/macos/observe.js';
import { revalidateFixtureElement } from '../lib/backend/macos/revalidate.js';
import { FixtureReadAuthority } from '../lib/policy/read-authority.js';
import { ObservationStore } from '../lib/observation/store.js';
import { FixtureReadService } from '../lib/service/fixture-read.js';
import { FixtureRevalidationService } from '../lib/service/fixture-revalidation.js';

// Explicit native lane. Not part of the permission-free default suite; missing TCC exits nonzero, not skip/pass.
const ctx = new Context();
await ctx.plugin(LocalSubprocessRuntime).inertia;
let directory;
let fixture;
const authority = new FixtureReadAuthority();
const observations = new ObservationStore();
const readService = new FixtureReadService({ authority, observations, observe: (target, signal) => observeFixtureSnapshot(ctx.subprocess, process.cwd(), target, { signal }) });
const revalidationService = new FixtureRevalidationService({ authority, observations, revalidate: (target, element, signal) => revalidateFixtureElement(ctx.subprocess, process.cwd(), target, element, { signal }) });
try {
  const health = await probeNativeHealth(ctx.subprocess, process.cwd(), { signal: AbortSignal.timeout(5000) });
  if (!health.permissions.accessibility) {
    console.error('NOT_RUN: Accessibility permission is absent. No fixture was launched and no permission was requested.');
    process.exitCode = 3;
  } else {
    directory = await mkdtemp(join(tmpdir(), 'cu-native-observation-'));
    fixture = ctx.subprocess.spawn({
      argv: [resolve('dist/native/CUFixture.app/Contents/MacOS/CUFixture'), '--host-visible', '--state-dir', directory] /* hidden windows are not exposed via AXWindows */,
      cwd: process.cwd(), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 256 } },
      graceMs: 100, signal: AbortSignal.timeout(10_000),
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
    assert.equal(ready.shownWindows, 2);
    assert.equal(ready.injectedInput, false);
    for (const window of ready.windows) {
      const target = { pid: ready.pid, processStart: ready.processStart, ...window };
      const host = Object.freeze({ owner: Object.freeze({ agentId: 'native_fixture', sessionId: 'native_fixture', generation: 'native_fixture_generation' }),
        lifetime: Object.freeze({}), workspace: process.cwd(), callId: `call_${window.windowKey}`, turn: 1, signal: AbortSignal.timeout(5000) });
      // Explicit public-fixture test grant, not user consent or a production authorization source.
      const grant = authority.grantFromHost(host, target, { ttlMs: 30_000 });
      const observation = await readService.observe(() => host, grant, target);
      const text = observation.elements.find((element) => element.name === 'Fixture text');
      const secure = observation.elements.find((element) => element.name === 'Simulated password');
      assert.equal(text?.role, 'text-field');
      assert.equal(text?.secure, false, 'Public fixture field must be positively identified.');
      assert.ok(text?.actions.includes('set_value'));
      assert.equal(secure?.secure, true);
      assert.ok(!('value' in secure));
      assert.ok(!('elementInstance' in text), 'Public observation must not expose the native witness.');
      const request = { observationId: observation.observationId, handle: text.handle, operation: 'set_value' };
      const revalidated = await revalidationService.revalidate(() => host, grant, request);
      assert.equal(revalidated.status, 'exact', 'Native observation → private handle → authorized exact revalidation must succeed.');
      assert.equal(revalidated.dispatchable, false);
      assert.equal(revalidated.requiresNativeRevalidation, true);
      const candidate = observations.resolveFixtureFromHost(host, request.observationId, request.handle, request.operation);
      const replacedElement = await revalidateFixtureElement(ctx.subprocess, process.cwd(), target, { ...candidate.element, instance: 'element_replaced' }, { signal: host.signal });
      assert.equal(replacedElement.status, 'error');
      assert.equal(replacedElement.code, 'TARGET_CHANGED');
      const repeated = await observeFixtureSnapshot(ctx.subprocess, process.cwd(), target, { signal: AbortSignal.timeout(5000) });
      assert.equal(repeated.status, 'ok');
      assert.equal(repeated.snapshot.windowInstance, window.windowInstance);
      const replaced = await observeFixtureSnapshot(ctx.subprocess, process.cwd(), { ...target, windowInstance: 'window_replaced' }, { signal: AbortSignal.timeout(5000) });
      assert.equal(replaced.status, 'error');
      assert.equal(replaced.code, 'TARGET_CHANGED');
      authority.revokeFromHost(grant);
      await assert.rejects(revalidationService.revalidate(() => host, grant, request), /READ_DENIED/);
    }
    console.log('Native fixture-only AX observation and read-only exact revalidation passed. No input was dispatched.');
  }
} finally {
  authority.dispose(); observations.dispose();
  if (fixture) { fixture.terminate(); assert.equal(await fixture.waitForExit(AbortSignal.timeout(2000)), true); }
  await ctx.fiber.dispose();
  if (directory) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir(), 'cu-native-observation-'))) throw new Error('Refuse cleanup outside test-owned directory.');
    await rm(absolute, { recursive: true });
  }
}
