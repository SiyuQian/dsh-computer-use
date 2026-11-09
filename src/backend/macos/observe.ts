import { randomUUID } from 'node:crypto';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { parseFixtureObserveRequest, parseFixtureObserveResponse, type FixtureObserveResponse } from '../../contracts/fixture-observation.js';
import { runNativeRead } from './transport.js';

/** Internal fixture-only backend seam; callers must hold an exact host read binding. Not a model tool. */
export async function observeFixtureSnapshot(
  provider: Pick<SubprocessRuntime, 'spawn'>,
  repositoryRoot: string,
  target: unknown,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<FixtureObserveResponse> {
  const request = parseFixtureObserveRequest({
    protocolVersion: 1, requestId: randomUUID(), launchId: randomUUID(), command: 'observe_fixture', target,
  });
  return runNativeRead(provider, repositoryRoot, request, parseFixtureObserveResponse, options);
}
