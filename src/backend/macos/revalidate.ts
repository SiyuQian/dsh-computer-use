import { randomUUID } from 'node:crypto';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { fixtureRevalidateRequestSchema, parseFixtureRevalidateResponse, type FixtureRevalidateResponse } from '../../contracts/fixture-observation.js';
import { parseContract } from '../../contracts/shared.js';
import { runNativeRead } from './transport.js';

/** Internal read-only lifecycle witness probe. Requires host read authorization; an exact response never authorizes dispatch. */
export async function revalidateFixtureElement(
  provider: Pick<SubprocessRuntime, 'spawn'>,
  repositoryRoot: string,
  target: unknown,
  element: unknown,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<FixtureRevalidateResponse> {
  const request = parseContract(fixtureRevalidateRequestSchema, {
    protocolVersion: 1, requestId: randomUUID(), launchId: randomUUID(), command: 'revalidate_fixture', target, element,
  });
  const response = await runNativeRead(provider, repositoryRoot, request, parseFixtureRevalidateResponse, options);
  if (response.status === 'exact') {
    const sameTarget = (Object.keys(request.target) as Array<keyof typeof request.target>).every((key) => response.target[key] === request.target[key]);
    const sameElement = (Object.keys(request.element) as Array<keyof typeof request.element>).every((key) => response.element[key] === request.element[key]);
    if (!sameTarget || !sameElement) throw new Error('NATIVE_PROTOCOL_ERROR: Fixture revalidation did not match its request. No action was dispatched.');
  }
  return response;
}
