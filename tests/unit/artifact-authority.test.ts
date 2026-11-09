import { describe, expect, it } from 'vitest';
import type { HostContext } from '../../src/host-adapter/context.js';
import { EphemeralArtifactStore, type ArtifactAuthorizer } from '../../src/evidence/ephemeral-artifacts.js';
import { FixtureReadAuthority } from '../../src/policy/read-authority.js';

const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
const spec = { observationId: 'observation_fixture', mediaType: 'image/png', maxBytes: 3 };
const context: HostContext = { owner: { agentId: 'session_fixture', sessionId: 'session_fixture', generation: 'generation_fixture' },
  lifetime: Object.freeze({}), workspace: '/tmp/cu-artifact-authority', callId: 'call_fixture', turn: 1, signal: new AbortController().signal };

function fixture() {
  const authority = new FixtureReadAuthority(); const store = new EphemeralArtifactStore({ enabledFromHost: true });
  let grant = 'model_grant'; let current = context; let checked: string[] = [];
  const authorize: ArtifactAuthorizer = (metadata) => {
    checked.push(metadata.operation);
    // An existing read grant is only the test seam. Production capture/disclosure still needs a separately approved policy.
    const permit = authority.requireRead(current, grant, target);
    return !permit.signal.aborted;
  };
  return { authority, store, authorize, get grant() { return grant; },
    issue() { grant = authority.grantFromHost(context, target, { ttlMs: 30_000 }); return grant; },
    checked() { return checked; }, scope(next: HostContext) { current = next; },
    cleanup() { store.dispose(); authority.dispose(); },
  };
}

describe('CU-014a: real read authority with explicit host artifact admission; no capture permission inference', () => {
  it('denies without a live grant and consults the host authorizer independently on stage, publication and every access', () => {
    const f = fixture();
    try {
      expect(() => f.store.beginFromHost(context, spec, f.authorize)).toThrow('ARTIFACT_DENIED');
      f.issue(); const ticket = f.store.beginFromHost(context, spec, f.authorize);
      const descriptor = f.store.commitFromHost(context, ticket, new Uint8Array([1, 2, 3]), f.authorize);
      expect(f.store.readFromHost(context, descriptor.artifactId, f.authorize).bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(f.store.readFromHost(context, descriptor.artifactId, f.authorize).bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(f.checked()).toEqual(['stage', 'stage', 'publish', 'read', 'read']);
      f.authority.revokeFromHost(f.grant);
      expect(() => f.store.readFromHost(context, descriptor.artifactId, f.authorize)).toThrow('ARTIFACT_DENIED');
    } finally { f.cleanup(); }
  });

  it('does not publish a reserved artifact after its real grant was revoked', () => {
    const f = fixture();
    try {
      f.issue(); const ticket = f.store.beginFromHost(context, spec, f.authorize); f.authority.revokeFromHost(f.grant);
      expect(() => f.store.commitFromHost(context, ticket, new Uint8Array([1, 2, 3]), f.authorize)).toThrow('ARTIFACT_DENIED');
      f.issue(); expect(() => f.store.commitFromHost(context, ticket, new Uint8Array([1, 2, 3]), f.authorize)).toThrow('ARTIFACT_UNAVAILABLE');
    } finally { f.cleanup(); }
  });

  it('rejects a stale scope at access and explicit lifecycle invalidation permanently discards its bytes', () => {
    const f = fixture();
    try {
      f.issue(); const descriptor = f.store.commitFromHost(context, f.store.beginFromHost(context, spec, f.authorize), new Uint8Array([1, 2, 3]), f.authorize);
      f.scope({ ...context, workspace: '/tmp/another-workspace' });
      expect(() => f.store.readFromHost(context, descriptor.artifactId, f.authorize)).toThrow('ARTIFACT_DENIED');
      f.store.invalidateFromHost(context); f.scope(context);
      expect(() => f.store.readFromHost(context, descriptor.artifactId, f.authorize)).toThrow('ARTIFACT_UNAVAILABLE');
    } finally { f.cleanup(); }
  });
});
