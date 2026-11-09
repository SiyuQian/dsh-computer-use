import assert from 'node:assert/strict';
const views = [];
const set = Uint8Array.prototype.set;
Uint8Array.prototype.set = function (...args) { views.push(this); return Reflect.apply(set, this, args); };
const { FixtureReadRuntime } = await import('../../lib/service/fixture-read-runtime.js');
Uint8Array.prototype.set = set;

// Public synthetic metadata only. No native backend, screenshot, file, secret, or Profile is used.
const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture' };
for (const phase of ['stage', 'publish', 'read']) {
  const session = { id: 'session_fixture' }; const agent = { id: session.id, session };
  const host = { agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 1, lastTurn: 1 }) },
    sessions: { get: () => session }, workingDirectory: { get: () => '/tmp/cu-runtime-artifact-probe' } };
  const runtime = new FixtureReadRuntime(host, {
    observe: async () => ({ protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'ok', snapshot: {
      ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 }, nodes: [], truncated: false, reasons: [],
    } }), revalidate: async () => { throw new Error('unused backend'); },
  }, { artifacts: { enabledFromHost: true, authorize(metadata) {
    if (metadata.operation === phase) return Promise.reject(new Error('PUBLIC_RUNTIME_ASYNC_REFUSAL'));
    return true;
  } } });
  try {
    const exec = { agent, callId: 'call_fixture', signal: new AbortController().signal };
    const grant = runtime.grantFromHost(exec, target, { ttlMs: 30_000 });
    const observation = await runtime.observe(exec, grant, target); const spec = { observationId: observation.observationId, maxBytes: 3 };
    if (phase === 'read') {
      const descriptor = runtime.stageArtifactFromHost(exec, grant, spec, new Uint8Array([1, 2, 3]));
      assert.throws(() => runtime.readArtifactFromHost(exec, grant, descriptor.artifactId), /ARTIFACT_DENIED/);
    } else assert.throws(() => runtime.stageArtifactFromHost(exec, grant, spec, new Uint8Array([1, 2, 3])), /ARTIFACT_DENIED/);
    await new Promise((resolve) => setImmediate(resolve));
  } finally { runtime.dispose(); }
}
for (const event of ['workspace', 'policy', 'dispose']) {
  const session = { id: 'session_cleanup_fixture' }; const agent = { id: session.id, session };
  const host = { agents: { get: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 1, lastTurn: 1 }) },
    sessions: { get: () => session }, workingDirectory: { get: () => '/tmp/cu-runtime-artifact-probe' } };
  const observed = () => ({ protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'ok', snapshot: {
    ...target, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 }, nodes: [], truncated: false, reasons: [],
  } });
  let hang = false; let finish; let pendingSignal;
  const runtime = new FixtureReadRuntime(host, {
    observe: async (_target, signal) => { if (hang) { pendingSignal = signal; return new Promise((resolve) => { finish = resolve; }); } return observed(); },
    revalidate: async () => { throw new Error('unused backend'); },
  }, { artifacts: { enabledFromHost: true, authorize: () => true } });
  try {
    const exec = { agent, callId: 'call_fixture', signal: new AbortController().signal };
    const grant = runtime.grantFromHost(exec, target, { ttlMs: 30_000 });
    const observation = await runtime.observe(exec, grant, target);
    const descriptor = runtime.stageArtifactFromHost(exec, grant, { observationId: observation.observationId, maxBytes: 3 }, new Uint8Array([7, 8, 9]));
    const owned = views.at(-1); assert.deepEqual(Array.from(owned), [7, 8, 9]);
    hang = true; const pending = runtime.observe(exec, grant, target); let notified = false;
    pendingSignal.addEventListener('abort', () => {
      assert.deepEqual(Array.from(owned), [0, 0, 0]);
      assert.throws(() => runtime.grantFromHost(exec, target, { ttlMs: 30_000 }), /HOST_CONTEXT_UNAVAILABLE/);
      assert.throws(() => runtime.readArtifactFromHost(exec, grant, descriptor.artifactId));
      notified = true;
    }, { once: true });
    if (event === 'workspace') runtime.workspaceChangedFromHost(session);
    if (event === 'policy') runtime.policyChangedFromHost();
    if (event === 'dispose') runtime.dispose();
    assert.equal(notified, true); finish(observed()); await assert.rejects(pending);
  } finally { runtime.dispose(); }
}
process.stdout.write('RUNTIME_ASYNC_POLICY_REJECTED_WITHOUT_UNHANDLED_REJECTION\nRUNTIME_OWNED_BYTES_CLEARED_BEFORE_ABORT_NOTIFICATION\n');
