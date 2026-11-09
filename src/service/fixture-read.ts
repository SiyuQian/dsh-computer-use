import type { HostContext } from '../host-adapter/context.js';
import { parseFixtureObserveResponse, type FixtureTarget } from '../contracts/fixture-observation.js';
import type { Observation } from '../contracts/observation.js';
import type { FixtureReadAuthority } from '../policy/read-authority.js';
import type { ObservationStore } from '../observation/store.js';

interface Dependencies {
  authority: FixtureReadAuthority;
  observations: ObservationStore;
  observe(target: FixtureTarget, signal: AbortSignal): Promise<unknown>;
}
function unavailable(): Error {
  return new Error('NATIVE_READ_UNAVAILABLE: Native fixture data was not published. No read was retried.');
}

/** Internal read-only orchestration. No model tool, consent UI, input, or approval bypass is registered here. */
export class FixtureReadService {
  constructor(private readonly dependencies: Dependencies) {}

  async observe(currentHostContext: () => HostContext, grantId: string, requestedTarget: unknown): Promise<Observation> {
    const context = currentHostContext();
    const { authority, observations } = this.dependencies;
    const permit = authority.requireRead(context, grantId, requestedTarget);
    const ticket = observations.begin(context);
    try {
      let raw: unknown;
      try { raw = await this.dependencies.observe(permit.target, permit.signal); }
      catch {
        // Revocation/cancellation take priority over an untrusted backend exception; no source text escapes.
        authority.requireRead(currentHostContext(), grantId, requestedTarget);
        if (permit.signal.aborted) throw new Error('CANCELLED: Native fixture data was not published.');
        throw unavailable();
      }
      const latest = currentHostContext();
      authority.requireRead(latest, grantId, requestedTarget);
      if (permit.signal.aborted) throw new Error('CANCELLED: Native fixture data was not published.');
      let response;
      try { response = parseFixtureObserveResponse(raw); }
      catch { throw unavailable(); }
      if (response.status === 'error') {
        throw new Error(`${response.code}: Native fixture data was not published.`);
      }
      return observations.commit(latest, ticket, response.snapshot, requestedTarget, () => {
        authority.requireRead(currentHostContext(), grantId, requestedTarget);
        if (permit.signal.aborted) throw new Error('CANCELLED: Native fixture data was not published.');
      });
    } finally {
      observations.discard(context, ticket);
    }
  }
}
