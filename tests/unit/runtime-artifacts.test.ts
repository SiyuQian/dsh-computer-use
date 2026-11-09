import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureReadRuntime, type FixtureReadRuntimeOptions } from '../../src/service/fixture-read-runtime.js';

const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
const payload = () => new Uint8Array([97, 98, 99]);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(artifacts?: FixtureReadRuntimeOptions['artifacts']) {
  const agents = new Map<string, Agent>(); const sessions = new Map<string, Session>(); const directories = new Map<Session, string>();
  let open = true; let calls = 0;
  const host = { agents: { get: (id: string) => agents.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: open ? SessionSeq(1) : null, lastTurn: 1 }) },
    sessions: { get: (id: string) => sessions.get(id) }, workingDirectory: { get: (session: Session) => directories.get(session)! } } as unknown as Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
  const runtime = new FixtureReadRuntime(host, {
    observe: async (received) => { calls += 1; return { protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', status: 'ok', snapshot: {
      ...received, bundleId: 'dev.siyuqian.computer-use.fixture', frame: { x: 0, y: 0, width: 520, height: 440 }, nodes: [], truncated: false, reasons: [],
    } }; }, revalidate: async () => { throw new Error('unused backend'); },
  }, artifacts ? { artifacts } : {});
  cleanups.push(() => runtime.dispose());
  function caller(id = 'session_fixture') {
    const session = Session.create(SessionId(id)); const agent = { id: session.id, session } as Agent;
    agents.set(id, agent); sessions.set(id, session); directories.set(session, '/tmp/cu-runtime-artifacts');
    const abort = new AbortController();
    const exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'> = { agent, callId: ToolCallId('call_fixture'), signal: abort.signal };
    return { agent, session, abort, exec };
  }
  const first = caller();
  async function observed(exec = first.exec) {
    const grant = runtime.grantFromHost(exec, target, { ttlMs: 30_000 }); const observation = await runtime.observe(exec, grant, target);
    return { grant, observation, spec: { observationId: observation.observationId, maxBytes: 3 } };
  }
  return { runtime, ...first, host, caller, observed, calls: () => calls,
    closeTurn() { open = false; }, directory(value: string) { directories.set(first.session, value); },
    stage(grant: string, spec: unknown, exec = first.exec) { return runtime.stageArtifactFromHost(exec, grant, spec, payload()); },
  };
}

describe('CU-014a2: private memory artifacts composed with live read runtime and separate policy', () => {
  it('preserves the async-denial rejection handler through the live runtime policy wrapper', () => {
    const child = spawnSync(process.execPath, [resolve('tests/support/runtime-artifact-probe.mjs')], { encoding: 'utf8', timeout: 5_000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    expect(child.stdout).toBe('RUNTIME_ASYNC_POLICY_REJECTED_WITHOUT_UNHANDLED_REJECTION\nRUNTIME_OWNED_BYTES_CLEARED_BEFORE_ABORT_NOTIFICATION\n');
    expect(child.stderr).not.toContain('PUBLIC_RUNTIME_ASYNC_REFUSAL');
  });

  it('stays disabled by default even with a valid read grant and observation', async () => {
    const f = fixture(); const { grant, spec } = await f.observed();
    expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function');
    expect(() => f.stage(grant, spec)).toThrow('ARTIFACT_DENIED');
    expect(() => f.runtime.readArtifactFromHost(f.exec, grant, 'artifact_model')).toThrow('ARTIFACT_DENIED');
  });

  it('does not infer artifact disclosure permission from host enablement or a read grant alone', async () => {
    const f = fixture({ enabledFromHost: true }); const { grant, spec } = await f.observed();
    expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function'); expect(() => f.stage(grant, spec)).toThrow('ARTIFACT_DENIED');
  });

  it('binds metadata to a real current observation and independently calls policy at stage, publish and every read', async () => {
    const decisions: unknown[] = [];
    const f = fixture({ enabledFromHost: true, authorize: (metadata) => { expect(Object.isFrozen(metadata)).toBe(true); decisions.push(metadata); return true; } });
    const { grant, spec } = await f.observed(); expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function');
    const descriptor = f.stage(grant, spec); expect(descriptor.observationId).toBe(spec.observationId);
    expect(f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId).bytes).toEqual(payload());
    expect(f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId).bytes).toEqual(payload());
    expect(decisions).toEqual(['stage', 'publish', 'read', 'read'].map((operation) => ({ operation, observationId: spec.observationId, mediaType: 'image/png' })));
    expect(descriptor).not.toHaveProperty('coherent'); expect(descriptor).not.toHaveProperty('target'); expect(f.runtime).not.toHaveProperty('artifacts');
    expect(f.calls()).toBe(1);
  });

  it.each(['target', 'owner', 'approved', 'path', 'mediaType'] as const)('rejects caller-provided %s instead of accepting artifact authority metadata', async (field) => {
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const { grant, spec } = await f.observed();
    expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function'); expect(() => f.stage(grant, { ...spec, [field]: 'public-test-input' })).toThrow('INVALID_REQUEST');
  });

  it('rejects unknown observation and a read grant for another exact fixture window', async () => {
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const { grant, spec } = await f.observed();
    expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function');
    expect(() => f.stage(grant, { ...spec, observationId: 'observation_model' })).toThrow();
    const other = f.runtime.grantFromHost(f.exec, { ...target, windowKey: 'secondary', windowId: 8 }, { ttlMs: 30_000 });
    expect(() => f.stage(other, spec)).toThrow();
    const descriptor = f.stage(grant, spec); expect(() => f.runtime.readArtifactFromHost(f.exec, other, descriptor.artifactId)).toThrow();
  });

  it.each(['agent', 'session', 'directory', 'policy', 'dispose'] as const)('invalidates stored bytes and old observations on %s before new grants can expose them', async (event) => {
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const { grant, spec } = await f.observed();
    expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function'); const descriptor = f.stage(grant, spec);
    if (event === 'agent') f.runtime.agentDisposedFromHost(f.agent);
    if (event === 'session') f.runtime.sessionDisposedFromHost(f.session);
    if (event === 'directory') f.runtime.workspaceChangedFromHost(f.session);
    if (event === 'policy') f.runtime.policyChangedFromHost();
    if (event === 'dispose') f.runtime.dispose();
    expect(() => f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId)).toThrow();
    if (event === 'directory' || event === 'policy') {
      const fresh = await f.observed();
      expect(() => f.runtime.readArtifactFromHost(f.exec, fresh.grant, descriptor.artifactId)).toThrow();
      expect(() => f.stage(fresh.grant, spec)).toThrow();
      expect(f.stage(fresh.grant, fresh.spec).observationId).toBe(fresh.spec.observationId);
    }
  });

  it('does not let another Session use a copied descriptor or destroy a surviving Session artifact', async () => {
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const first = await f.observed(); expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function');
    const descriptor = f.stage(first.grant, first.spec); const other = f.caller('session_other'); const second = await f.observed(other.exec);
    expect(() => f.runtime.readArtifactFromHost(other.exec, second.grant, descriptor.artifactId)).toThrow();
    f.runtime.sessionDisposedFromHost(other.session);
    expect(f.runtime.readArtifactFromHost(f.exec, first.grant, descriptor.artifactId).bytes).toEqual(payload());
  });

  it.each(['stage', 'publish', 'read'] as const)('refuses lifecycle changes inside independent %s policy with no surviving old artifact', async (phase) => {
    let armed = false; let f!: ReturnType<typeof fixture>;
    f = fixture({ enabledFromHost: true, authorize: (metadata) => { if (armed && metadata.operation === phase) { armed = false; f.runtime.policyChangedFromHost(); } return true; } });
    const { grant, spec } = await f.observed(); expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function');
    let artifact: string | undefined;
    if (phase === 'read') artifact = f.stage(grant, spec).artifactId;
    armed = true;
    expect(() => phase === 'read' ? f.runtime.readArtifactFromHost(f.exec, grant, artifact!) : f.stage(grant, spec)).toThrow();
    const fresh = await f.observed(); expect(f.stage(fresh.grant, fresh.spec).observationId).toBe(fresh.spec.observationId);
    if (artifact) expect(() => f.runtime.readArtifactFromHost(f.exec, fresh.grant, artifact!)).toThrow();
  });

  it('does not leak entry capacity when scope cleanup removes a full store of committed artifacts', async () => {
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const first = await f.observed();
    for (let i = 0; i < 16; i += 1) f.stage(first.grant, first.spec);
    expect(() => f.stage(first.grant, first.spec)).toThrow('ARTIFACT_CAPACITY');
    f.runtime.workspaceChangedFromHost(f.session); const fresh = await f.observed();
    for (let i = 0; i < 16; i += 1) expect(f.stage(fresh.grant, fresh.spec).observationId).toBe(fresh.spec.observationId);
    expect(() => f.stage(fresh.grant, fresh.spec)).toThrow('ARTIFACT_CAPACITY');
  });

  it('rejects a same-ID replacement without disposal notification and never transfers old artifact state', async () => {
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const { grant, spec } = await f.observed(); expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function');
    const descriptor = f.stage(grant, spec); const next = f.caller(); const fresh = await f.observed(next.exec);
    expect(() => f.runtime.readArtifactFromHost(next.exec, fresh.grant, descriptor.artifactId)).toThrow();
    expect(() => f.stage(fresh.grant, spec, next.exec)).toThrow();
    expect(f.stage(fresh.grant, fresh.spec, next.exec).observationId).toBe(fresh.spec.observationId);
  });

  it('requires live observation membership even while a longer-lived artifact remains within its own TTL', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const { grant, spec } = await f.observed(); expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function');
    const descriptor = f.stage(grant, spec); now += 15_000;
    expect(() => f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId)).toThrow();
  });

  it.each(['directory', 'closed_turn', 'registry', 'disposed'] as const)('does not disclose bytes if %s changes inside read policy even when it returns true', async (event) => {
    let armed = false; let f!: ReturnType<typeof fixture>;
    f = fixture({ enabledFromHost: true, authorize: () => {
      if (armed) {
        armed = false;
        if (event === 'directory') f.directory('/tmp/other-artifact-scope');
        if (event === 'closed_turn') f.closeTurn();
        if (event === 'registry') f.caller();
        if (event === 'disposed') f.runtime.dispose();
      }
      return true;
    } });
    const { grant, spec } = await f.observed(); const descriptor = f.stage(grant, spec); armed = true;
    expect(() => f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId)).toThrow();
  });

  it.each(['stage', 'read'] as const)('redacts original execution snapshot getter errors during %s', async (operation) => {
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const { grant, spec } = await f.observed(); const descriptor = f.stage(grant, spec);
    const exec = { ...f.exec, get signal(): AbortSignal { throw new Error('public-exec-getter-sentinel'); } };
    let failure: unknown;
    try { if (operation === 'stage') f.stage(grant, spec, exec); else f.runtime.readArtifactFromHost(exec, grant, descriptor.artifactId); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain('public-exec-getter-sentinel');
  });

  it.each(['stage', 'read'] as const)('redacts actual Agent session getter errors during %s', async (operation) => {
    const f = fixture({ enabledFromHost: true, authorize: () => true }); const { grant, spec } = await f.observed(); const descriptor = f.stage(grant, spec);
    Object.defineProperty(f.agent, 'session', { configurable: true, get() { throw new Error('public-session-getter-sentinel'); } });
    let failure: unknown;
    try { if (operation === 'stage') f.stage(grant, spec); else f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain('public-session-getter-sentinel');
  });

  it('does not admit recursive artifact staging from within independent policy', async () => {
    let armed = false; let spec: unknown; let grant = ''; let f!: ReturnType<typeof fixture>;
    f = fixture({ enabledFromHost: true, authorize: () => { if (armed) expect(() => f.stage(grant, spec)).toThrow('ARTIFACT_DENIED'); return true; } });
    const fresh = await f.observed(); spec = fresh.spec; grant = fresh.grant; armed = true;
    expect(f.stage(grant, spec).observationId).toBe(fresh.spec.observationId);
  });

  it('sanitizes independent policy exceptions without retaining a public artifact', async () => {
    const f = fixture({ enabledFromHost: true, authorize: () => { throw new Error('public-policy-error-sentinel'); } });
    const { grant, spec } = await f.observed();
    let error: unknown; try { f.stage(grant, spec); } catch (failure) { error = failure; }
    expect(String(error)).toContain('ARTIFACT_DENIED'); expect(String(error)).not.toContain('public-policy-error-sentinel');
  });

  it('preserves original caller cancellation and rechecks live host state after independent authorization', async () => {
    let armed = false; let f!: ReturnType<typeof fixture>;
    f = fixture({ enabledFromHost: true, authorize: () => { if (armed) f.abort.abort(); return true; } });
    const { grant, spec } = await f.observed(); expect(f.runtime.stageArtifactFromHost).toBeTypeOf('function');
    const descriptor = f.stage(grant, spec); armed = true;
    expect(() => f.runtime.readArtifactFromHost(f.exec, grant, descriptor.artifactId)).toThrow();
  });
});
