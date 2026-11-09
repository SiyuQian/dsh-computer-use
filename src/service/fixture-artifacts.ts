import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { sameHostScope, snapshotHostScope } from '../host-adapter/scope.js';
import { opaqueId } from '../contracts/shared.js';
import { EphemeralArtifactStore, type ArtifactAuthorizer, type EphemeralArtifactDescriptor } from '../evidence/ephemeral-artifacts.js';
import type { FixtureReadAuthority } from '../policy/read-authority.js';
import type { ObservationStore } from '../observation/store.js';

const stageSchema = z.strictObject({ observationId: opaqueId, maxBytes: z.number().int().min(1).max(1_048_576) });
export interface FixtureArtifactOptions { enabledFromHost?: boolean; authorize?: ArtifactAuthorizer }
interface Dependencies { authority: FixtureReadAuthority; observations: ObservationStore }
function unavailable(code = 'ARTIFACT_UNAVAILABLE'): Error {
  return new Error(`${code}: A current authorized observation and independent host artifact policy are required.`);
}

/** Private synthetic-byte staging. Read grants do not replace independent artifact policy or authorize capture. */
export class FixtureArtifactService {
  readonly #store: EphemeralArtifactStore;
  readonly #authorize: ArtifactAuthorizer | undefined;
  constructor(private readonly dependencies: Dependencies, options: FixtureArtifactOptions = {}) {
    this.#store = new EphemeralArtifactStore({ enabledFromHost: options.enabledFromHost === true });
    this.#authorize = options.authorize;
  }

  stage(current: () => HostContext, grantId: string, rawSpec: unknown, bytes: unknown): EphemeralArtifactDescriptor {
    let spec: z.infer<typeof stageSchema>;
    try { spec = stageSchema.parse(rawSpec); } catch { throw unavailable('INVALID_REQUEST'); }
    const context = current();
    const authorize = this.#authorizer(current, context, grantId);
    const ticket = this.#store.beginFromHost(context, { ...spec, mediaType: 'image/png' }, authorize);
    try { return this.#store.commitFromHost(context, ticket, bytes, authorize); }
    finally { this.#store.discardFromHost(context, ticket); }
  }

  read(current: () => HostContext, grantId: string, artifactId: string) {
    const context = current();
    return this.#store.readFromHost(context, artifactId, this.#authorizer(current, context, grantId));
  }

  invalidate(context: HostContext): void { this.#store.invalidateFromHost(context); }
  dispose(): void { this.#store.dispose(); }

  #authorizer(current: () => HostContext, original: HostContext, grantId: string): ArtifactAuthorizer {
    const scope = snapshotHostScope(original);
    const requireFresh = (observationId: string) => {
      const latest = current();
      if (!sameHostScope(scope, snapshotHostScope(latest)) || original.signal.aborted) throw unavailable();
      const target = this.dependencies.observations.fixtureTargetFromHost(latest, observationId);
      const permit = this.dependencies.authority.requireRead(latest, grantId, target);
      if (permit.signal.aborted || original.signal.aborted) throw unavailable();
    };
    return (metadata) => {
      requireFresh(metadata.observationId);
      const outcome = this.#authorize?.(metadata);
      // Preserve rejected native promises for the store's synchronous-denial/rejection handler; never assimilate thenables.
      if (outcome !== true) return outcome;
      requireFresh(metadata.observationId);
      return true;
    };
  }
}
