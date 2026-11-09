import assert from 'node:assert/strict';

// Isolated test-only API boundary interposition. Product classes receive no byte-inspection hooks.
const original = Uint8Array.prototype.set;
const copied = [];
Uint8Array.prototype.set = function (source, offset) {
  copied.push(this);
  return original.call(this, source, offset);
};
try {
  const { EphemeralArtifactStore } = await import('../../lib/evidence/ephemeral-artifacts.js');
  const store = new EphemeralArtifactStore({ enabledFromHost: true });
  const context = { owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
    lifetime: Object.freeze({}), workspace: '/tmp/cu-artifact-probe', callId: 'call_fixture', turn: 1, signal: new AbortController().signal };
  const spec = { observationId: 'observation_fixture', mediaType: 'image/png', maxBytes: 3 };
  const input = new Uint8Array([1, 2, 3]); const allow = () => true;
  try {
    if (process.argv[2] === 'async-authorizer') {
      const denied = async () => { throw new Error('PUBLIC_ASYNC_AUTH_REFUSAL'); };
      assert.throws(() => store.beginFromHost(context, spec, denied), /ARTIFACT_DENIED/);
      const ticket = store.beginFromHost(context, spec, allow);
      assert.throws(() => store.commitFromHost(context, ticket, input, denied), /ARTIFACT_DENIED/);
      const descriptor = store.commitFromHost(context, store.beginFromHost(context, spec, allow), input, allow);
      assert.throws(() => store.readFromHost(context, descriptor.artifactId, denied), /ARTIFACT_DENIED/);
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write('ASYNC_AUTH_DENIED_WITHOUT_UNHANDLED_REJECTION\n');
    } else {
    // Reset unrelated dependency initialization copies; the next view is owned by this exact store commit.
    copied.length = 0;
    const descriptor = store.commitFromHost(context, store.beginFromHost(context, spec, allow), input, allow);
    assert.equal(copied.length, 1); const owned = copied[0]; assert.deepEqual([...owned], [1, 2, 3]);
    const returned = store.readFromHost(context, descriptor.artifactId, allow).bytes;
    assert.equal(copied.length, 2); assert.notEqual(owned, returned);
    store.invalidateFromHost(context);
    assert.deepEqual([...owned], [0, 0, 0]); assert.deepEqual([...returned], [1, 2, 3]); assert.deepEqual([...input], [1, 2, 3]);
    const ticket = store.beginFromHost(context, spec, allow);
    assert.throws(() => store.commitFromHost(context, ticket, input, () => false), /ARTIFACT_DENIED/);
    assert.equal(copied.length, 3); assert.deepEqual([...copied[2]], [0, 0, 0]);
    store.commitFromHost(context, store.beginFromHost(context, spec, allow), input, allow);
    assert.equal(copied.length, 4); store.dispose(); assert.deepEqual([...copied[3]], [0, 0, 0]);
    process.stdout.write('OWNED_VIEWS_OVERWRITTEN; RETURNED_COPY_NOT_ERASED\n');
    }
  } finally { store.dispose(); }
} finally { Uint8Array.prototype.set = original; }
