import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import { HostScopeRegistry, snapshotHostCall, hostContextUnavailable, type HostCall, type HostServices } from '../host-adapter/scope-registry.js';
import type { FixtureElement, FixtureTarget } from '../contracts/fixture-observation.js';
import { FixtureReadAuthority } from '../policy/read-authority.js';
import { ObservationStore } from '../observation/store.js';
import { FixtureReadService } from './fixture-read.js';
import { FixtureRevalidationService } from './fixture-revalidation.js';
import { FixtureArtifactService, type FixtureArtifactOptions } from './fixture-artifacts.js';
import { FixtureActionIntentService, type ActionIntentTicket } from './fixture-action-intents.js';
import type { HostContext } from '../host-adapter/context.js';

export interface FixtureReadBackends {
  observe(target: FixtureTarget, signal: AbortSignal): Promise<unknown>;
  revalidate(target: FixtureTarget, element: FixtureElement, signal: AbortSignal): Promise<unknown>;
}
export interface FixtureReadRuntimeOptions { maxScopes?: number; artifacts?: FixtureArtifactOptions }

/** Internal opt-in read composition. No tools, consent, native input, or production controller are installed. */
export class FixtureReadRuntime {
  readonly #authority = new FixtureReadAuthority();
  readonly #observations = new ObservationStore();
  readonly #reads: FixtureReadService;
  readonly #revalidation: FixtureRevalidationService;
  readonly #scopes: HostScopeRegistry;
  readonly #intents = new FixtureActionIntentService({ authority: this.#authority, observations: this.#observations });
  readonly #artifactOptions: FixtureArtifactOptions;
  #artifacts: FixtureArtifactService;

  constructor(host: HostServices, backends: FixtureReadBackends, options: FixtureReadRuntimeOptions = {}) {
    const dependencies = { authority: this.#authority, observations: this.#observations };
    this.#reads = new FixtureReadService({ ...dependencies, observe: (target, signal) => backends.observe(target, signal) });
    this.#revalidation = new FixtureRevalidationService({ ...dependencies, revalidate: (target, element, signal) => backends.revalidate(target, element, signal) });
    this.#artifactOptions = Object.freeze({ enabledFromHost: options.artifacts?.enabledFromHost === true,
      ...(options.artifacts?.authorize ? { authorize: options.artifacts.authorize } : {}) });
    this.#artifacts = new FixtureArtifactService(dependencies, this.#artifactOptions);
    this.#scopes = new HostScopeRegistry(host, {
      invalidate: (contexts) => {
        for (const context of contexts) this.#intents.invalidate(context);
        for (const context of contexts) this.#observations.invalidate(context);
        for (const context of contexts) this.#artifacts.invalidate(context);
        for (const context of contexts) this.#authority.revokeScopeFromHost(context);
      },
      policyChanged: (contexts) => {
        this.#intents.invalidateAll();
        for (const context of contexts) this.#observations.invalidate(context);
        this.#artifacts.dispose();
        this.#artifacts = new FixtureArtifactService(dependencies, this.#artifactOptions);
        this.#authority.policyChangedFromHost();
      },
      dispose: () => { this.#intents.dispose(); this.#observations.dispose(); this.#artifacts.dispose(); this.#authority.dispose(); },
    }, 'READ', options);
  }

  /** Trusted host configuration only. This does not obtain user consent or OS permission. */
  grantFromHost(exec: HostCall, target: unknown, options: { ttlMs: number }): string {
    const call = snapshotHostCall(exec); const context = this.#scopes.bind(call); const epoch = this.#scopes.epoch;
    const grant = this.#authority.grantFromHost(context, target, options);
    try { this.#scopes.requireCurrent(call, context, epoch); return grant; }
    catch { this.#authority.revokeFromHost(grant); throw hostContextUnavailable(); }
  }

  async observe(exec: HostCall, grantId: string, target: unknown) {
    const call = snapshotHostCall(exec);
    return this.#reads.observe(() => this.#scopes.bind(call), grantId, target);
  }

  async revalidate(exec: HostCall, grantId: string, request: unknown) {
    const call = snapshotHostCall(exec);
    return this.#revalidation.revalidate(() => this.#scopes.bind(call), grantId, request);
  }

  /** Explicit host synthetic-byte staging, not a screenshot request or model tool. */
  stageArtifactFromHost(exec: HostCall, grantId: string, spec: unknown, bytes: unknown) {
    const call = snapshotHostCall(exec);
    return this.#artifacts.stage(() => this.#scopes.bind(call), grantId, spec, bytes);
  }

  readArtifactFromHost(exec: HostCall, grantId: string, artifactId: string) {
    const call = snapshotHostCall(exec);
    return this.#artifacts.read(() => this.#scopes.bind(call), grantId, artifactId);
  }

  /** Host-only observation membership binding. Neither ticket nor consumed candidate grants control. */
  stageActionIntentFromHost(exec: HostCall, grantId: string, request: unknown) {
    return this.#intents.stage(this.#intentCurrent(exec), grantId, request);
  }

  consumeActionIntentFromHost(exec: HostCall, grantId: string, ticket: ActionIntentTicket, request: unknown) {
    return this.#intents.consume(this.#intentCurrent(exec), grantId, ticket, request);
  }

  #intentCurrent(exec: HostCall) {
    const call = snapshotHostCall(exec); const original = this.#scopes.bind(call); const epoch = this.#scopes.epoch;
    return (validate?: (context: HostContext) => void) => {
      const latest = this.#scopes.requireCurrent(call, original, epoch, validate);
      if (latest.turn !== original.turn) throw hostContextUnavailable(); return latest;
    };
  }

  agentDisposedFromHost(agent: Agent): void { this.#scopes.agentDisposedFromHost(agent); }
  sessionDisposedFromHost(session: Session): void { this.#scopes.sessionDisposedFromHost(session); }
  workspaceChangedFromHost(session: Session): void { this.#scopes.workspaceChangedFromHost(session); }
  policyChangedFromHost(): void { this.#scopes.policyChangedFromHost(); }
  /** Synchronous admission closure and cancellation only. It does not assert native drain or await backends. */
  dispose(): void { this.#scopes.dispose(); }
}
