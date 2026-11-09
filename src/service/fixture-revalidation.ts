import { z } from 'zod';
import type { HostContext } from '../host-adapter/context.js';
import { snapshotHostScope, sameHostScope } from '../host-adapter/scope.js';
import { fixtureElementSchema, parseFixtureRevalidateResponse, type FixtureElement, type FixtureTarget } from '../contracts/fixture-observation.js';
import { opaqueId, parseContract } from '../contracts/shared.js';
import type { ObservationStore, FixtureTargetCandidate } from '../observation/store.js';
import type { FixtureReadAuthority } from '../policy/read-authority.js';

const requestSchema = z.strictObject({ observationId: opaqueId, handle: opaqueId, operation: fixtureElementSchema.shape.operation });
type RevalidationRequest = z.infer<typeof requestSchema>;
export interface ReadOnlyRevalidation extends RevalidationRequest {
  status: 'exact';
  dispatchable: false;
  requiresNativeRevalidation: true;
}
interface Dependencies {
  authority: FixtureReadAuthority;
  observations: ObservationStore;
  revalidate(target: FixtureTarget, element: FixtureElement, signal: AbortSignal): Promise<unknown>;
}
function unavailable(): Error {
  return new Error('NATIVE_READ_UNAVAILABLE: Native fixture revalidation was not published. No read was retried.');
}
function sameBinding(first: Pick<FixtureTargetCandidate, 'target' | 'element'>, second: Pick<FixtureTargetCandidate, 'target' | 'element'>): boolean {
  return first.target.pid === second.target.pid && first.target.processStart === second.target.processStart &&
    first.target.windowKey === second.target.windowKey && first.target.windowId === second.target.windowId &&
    first.target.windowInstance === second.target.windowInstance && first.element.identifier === second.element.identifier &&
    first.element.instance === second.element.instance && first.element.operation === second.element.operation;
}

/** Host-only read orchestration. Public handles resolve privately; even an exact result never authorizes native input. */
export class FixtureRevalidationService {
  constructor(private readonly dependencies: Dependencies) {}

  async revalidate(currentHostContext: () => HostContext, grantId: string, rawRequest: unknown): Promise<ReadOnlyRevalidation> {
    const request = parseContract(requestSchema, rawRequest);
    const context = currentHostContext();
    const scope = snapshotHostScope(context);
    const originalSignal = context.signal;
    const { authority, observations } = this.dependencies;
    const expected = observations.resolveFixtureFromHost(context, request.observationId, request.handle, request.operation);
    const permit = authority.requireRead(context, grantId, expected.target);
    const requireFresh = (): FixtureTargetCandidate => {
      const latest = currentHostContext();
      authority.requireRead(latest, grantId, expected.target);
      if (!sameHostScope(scope, snapshotHostScope(latest))) throw new Error('READ_DENIED: The host read scope changed.');
      if (originalSignal.aborted || permit.signal.aborted) throw new Error('CANCELLED: Native fixture revalidation was not published.');
      const candidate = observations.resolveFixtureFromHost(latest, request.observationId, request.handle, request.operation);
      if (!sameBinding(expected, candidate)) throw unavailable();
      authority.requireRead(latest, grantId, expected.target);
      const finalCandidate = observations.resolveFixtureFromHost(latest, request.observationId, request.handle, request.operation);
      if (originalSignal.aborted || permit.signal.aborted) throw new Error('CANCELLED: Native fixture revalidation was not published.');
      if (!sameBinding(expected, finalCandidate)) throw unavailable();
      return finalCandidate;
    };
    requireFresh();
    let raw: unknown;
    try { raw = await this.dependencies.revalidate(structuredClone(expected.target), structuredClone(expected.element), permit.signal); }
    catch { requireFresh(); throw unavailable(); }
    requireFresh();
    let response;
    try { response = parseFixtureRevalidateResponse(raw); }
    catch { requireFresh(); throw unavailable(); }
    const current = requireFresh();
    if (response.status === 'error') throw new Error(`${response.code}: Native fixture revalidation was not published.`);
    if (!sameBinding(current, response)) throw unavailable();
    return { status: 'exact', dispatchable: false, requiresNativeRevalidation: true, ...request };
  }
}
