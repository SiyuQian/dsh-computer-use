import { Context } from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import { SessionStore, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { mkdtemp, readFile, rm, realpath, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { probeNativeHealth } from '../lib/backend/macos/health.js';
import { observeFixtureSnapshot } from '../lib/backend/macos/observe.js';
import { actFixtureElement } from '../lib/backend/macos/act.js';
import { NativeController } from '../lib/backend/macos/controller.js';
import { FixtureSession } from '../lib/backend/macos/fixture-session.js';
import { FixtureComputerUse } from '../lib/service/fixture-computer-use.js';

// CU-015 explicit native lane: real helper + real per-user controller (owned temp namespace) + real fixture + host composition.
// Owned fixture and public test values only. Missing AX permission exits 3 / NOT_RUN without prompting.
const ctx = new Context();
await ctx.plugin(LocalSubprocessRuntime).inertia;
await ctx.plugin(SessionStore).inertia;
const root = process.cwd();
const scratch = await realpath(await mkdtemp('/tmp/cu-native-e2e-'));
let fixture; let controller; let service;
try {
  const health = await probeNativeHealth(ctx.subprocess, root, { signal: AbortSignal.timeout(5000) });
  if (!health.permissions.accessibility) {
    console.error('NOT_RUN: Accessibility permission is absent. No fixture was launched and no permission was requested.');
    process.exitCode = 3;
  } else {
    const ledger = join(scratch, 'ledger'); await mkdir(ledger, { mode: 0o700 }); await chmod(ledger, 0o700);
    const namespaceParent = join(scratch, 'ns'); await mkdir(namespaceParent, { mode: 0o700 });
    controller = await NativeController.start(root, { testParent: namespaceParent });
    fixture = new FixtureSession(ctx.subprocess, root, { visible: false });
    const session = ctx.sessions.prepare(SessionId('session_native_e2e')); ctx.sessions.enter(session); ctx.sessions.announce(session);
    const agent = { id: session.id, session, ctx };
    const host = { agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: SessionSeq(1), lastTurn: 1 }) }, sessions: ctx.sessions,
      workingDirectory: { get: () => root } };
    let approvals = 0;
    service = new FixtureComputerUse(host, {
      fixtureTarget: (key, signal) => fixture.target(key, signal),
      observe: (target, signal) => observeFixtureSnapshot(ctx.subprocess, root, target, { signal }),
      act: (target, element, value, signal) => actFixtureElement(ctx.subprocess, root, target, element, value, { signal }),
      beginControl: () => controller.begin(),
      requestApproval: async () => { approvals += 1; return 'unavailable'; },
    }, { ledgerDirectory: ledger });
    const exec = { agent, callId: 'call_native_e2e', signal: new AbortController().signal };
    const state = async () => JSON.parse(await readFile(join(fixture.stateDirectory, 'fixture-state.json'), 'utf8'));
    const byName = (observation, name) => observation.elements.find((element) => element.name === name);

    const first = await service.observe(exec, {});
    assert.equal(byName(first, 'Simulated password')?.secure, true);
    const set = await service.act(exec, { observationId: first.observationId, action: { kind: 'set_value', targetHandle: byName(first, 'Fixture text').handle, value: 'PUBLIC_E2E' } });
    assert.equal(set.receipt.execution, 'completed'); assert.equal(set.readback, 'match');
    const press = await service.act(exec, { observationId: first.observationId, action: { kind: 'press', targetHandle: byName(first, 'Submit test value').handle } });
    assert.equal(press.receipt.execution, 'completed');
    let current = await state();
    assert.equal(current.text, 'PUBLIC_E2E'); assert.equal(current.submitCount, 1);
    // Approval-required action with unavailable approval: no effect.
    const save = await service.act(exec, { observationId: first.observationId, action: { kind: 'press', targetHandle: byName(first, 'Save test copy').handle } });
    assert.equal(save.receipt.execution, 'not_executed'); assert.equal(approvals, 1);
    // Replace the text target, then use the stale handle: helper must refuse before input.
    const replace = await service.act(exec, { observationId: first.observationId, action: { kind: 'press', targetHandle: byName(first, 'Replace text target').handle } });
    assert.equal(replace.receipt.execution, 'completed');
    const stale = await service.act(exec, { observationId: first.observationId, action: { kind: 'set_value', targetHandle: byName(first, 'Fixture text').handle, value: 'PUBLIC_STALE' } });
    assert.equal(stale.receipt.execution, 'not_executed'); assert.equal(stale.receipt.error.code, 'TARGET_CHANGED');
    assert.equal((await state()).text, 'PUBLIC_E2E');
    // Independent stop from a separate process: next action must not run.
    const stop = spawnSync(resolve('dist/native/CUController'), ['--stop', '--test-parent', namespaceParent], { encoding: 'utf8', timeout: 3000 });
    assert.equal(stop.status, 0);
    await new Promise((done) => setTimeout(done, 100));
    const second = await service.observe(exec, {});
    const afterStop = await service.act(exec, { observationId: second.observationId, action: { kind: 'press', targetHandle: byName(second, 'Submit test value').handle } });
    assert.equal(afterStop.receipt.execution, 'not_executed'); assert.equal(afterStop.receipt.error.phase, 'lock');
    current = await state(); assert.equal(current.submitCount, 1);
    console.log('Native fixture e2e passed: observe → set_value/press dispatched once each (fixture state verified), approval-required refused, stale target refused, independent stop blocked further input.');
  }
} finally {
  service?.dispose();
  await controller?.close().catch(() => {});
  await fixture?.close();
  await ctx.fiber.dispose();
  if (scratch.startsWith('/private/tmp/cu-native-e2e-')) await rm(scratch, { recursive: true });
}
