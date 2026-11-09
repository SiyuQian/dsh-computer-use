import { randomUUID } from 'node:crypto';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { parseNativeHealth, parseNativeRequest, type NativeHealth } from '../../contracts/index.js';
import { runNativeRead } from './transport.js';

/** Check health without reading UI content or requesting permissions. */
export function probeNativeHealth(
  provider: Pick<SubprocessRuntime, 'spawn'>,
  repositoryRoot: string,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<NativeHealth> {
  const request = parseNativeRequest({ protocolVersion: 1, requestId: randomUUID(), launchId: randomUUID(), command: 'health' });
  return runNativeRead(provider, repositoryRoot, request, parseNativeHealth, options);
}
