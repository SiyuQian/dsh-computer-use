import { randomUUID } from 'node:crypto';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { fixtureActRequestSchema, parseFixtureActResponse, type FixtureActResponse } from '../../contracts/fixture-observation.js';
import { parseContract } from '../../contracts/shared.js';
import { runNativeRead } from './transport.js';

/**
 * Internal single fixture action. Callers must already hold host control authorization, approval, coordination and a
 * durable dispatch_pending record. Any failure after spawn is EXECUTION_UNKNOWN and must never be retried.
 */
export async function actFixtureElement(
  provider: Pick<SubprocessRuntime, 'spawn'>,
  repositoryRoot: string,
  target: unknown,
  element: unknown,
  value: unknown,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<FixtureActResponse> {
  const request = parseContract(fixtureActRequestSchema, {
    protocolVersion: 1, requestId: randomUUID(), launchId: randomUUID(), command: 'act_fixture', target, element,
    ...(value === undefined ? {} : { value }),
  });
  return runNativeRead(provider, repositoryRoot, request, parseFixtureActResponse, options);
}
