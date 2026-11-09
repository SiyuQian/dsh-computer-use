import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { verifyLocalHelper } from './helper-artifact.js';
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { nativeReadRequestSchema, type NativeReadRequest } from '../../contracts/fixture-observation.js';
import { parseContract } from '../../contracts/shared.js';

type Failure = 'CANCELLED' | 'NATIVE_TIMEOUT' | 'NATIVE_PROTOCOL_ERROR' | 'NATIVE_TRANSPORT_ERROR' | 'NATIVE_CLEANUP_FAILED' | 'ARTIFACT_INVALID';
class NativeTransportError extends Error {
  constructor(code: Failure) {
    super(`${code}: Native read probe did not complete. No action was retried.`);
  }
}
function failure(code: Failure): NativeTransportError {
  return new NativeTransportError(code);
}

/** Run one closed read request against the fixed app-owned helper. Not a model tool. */
export async function runNativeRead<T extends { requestId: string; launchId: string }>(
  provider: Pick<SubprocessRuntime, 'spawn'>,
  repositoryRoot: string,
  request: NativeReadRequest,
  parseResponse: (raw: unknown) => T,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<T> {
  if (options.signal.aborted) throw failure('CANCELLED');
  if (process.platform !== 'darwin') throw new Error('UNSUPPORTED_PLATFORM: Native health requires macOS.');
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!isAbsolute(repositoryRoot) || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) {
    throw new Error('INVALID_REQUEST: Native health requires a fixed root and a bounded timeout.');
  }
  request = parseContract(nativeReadRequestSchema, request);
  const maxFrameBytes = request.command === 'health' ? 8192 : 262_144;
  const lifecycle = new AbortController();
  let resolveHalted: (value: undefined) => void = () => {};
  const halted = new Promise<undefined>((resolve) => { resolveHalted = resolve; });
  let stopped: Failure | undefined;
  const stop = (code: Failure) => {
    stopped ??= code;
    lifecycle.abort();
    resolveHalted(undefined);
  };
  const cancel = () => stop('CANCELLED');
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  const deadline = performance.now() + timeoutMs;
  const requireCurrent = () => {
    if (options.signal.aborted) stop('CANCELLED');
    if (performance.now() >= deadline) stop('NATIVE_TIMEOUT');
    if (stopped) throw failure(stopped);
  };
  const timer = setTimeout(() => stop('NATIVE_TIMEOUT'), timeoutMs);
  let handle: SubprocessHandle | undefined;
  let bytes = 0;
  const chunks: Buffer[] = [];
  const data = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxFrameBytes) stop('NATIVE_PROTOCOL_ERROR');
    else chunks.push(buffer);
  };
  const streamError = () => stop('NATIVE_TRANSPORT_ERROR');
  try {
    let executable: string;
    try { executable = await verifyLocalHelper(repositoryRoot, requireCurrent); }
    catch (error) { if (error instanceof NativeTransportError) throw error; throw failure('ARTIFACT_INVALID'); }
    requireCurrent();
    handle = provider.spawn({
      argv: [executable, '--managed-stdio'],
      cwd: repositoryRoot,
      stdio: { stdin: { data: `${JSON.stringify(request, request.command === 'revalidate_fixture' ? (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)) : value : undefined)}\n` }, stdout: 'pipe', stderr: { maxBytes: 256 }, control: 'pipe' },
      graceMs: 100,
      signal: lifecycle.signal,
    });
    if (!handle.stdout || !handle.control) {
      stop('NATIVE_TRANSPORT_ERROR');
    } else {
      handle.stdout.on('data', data);
      handle.stdout.on('error', streamError);
      handle.control.on('error', streamError);
      handle.control.end(`${request.launchId}\n`);
    }
    let outcome;
    try { outcome = await Promise.race([handle.done, halted]); }
    catch { stop('NATIVE_TRANSPORT_ERROR'); }
    requireCurrent();
    if (!outcome || outcome.exitCode !== 0 || outcome.signal !== null) throw failure('NATIVE_TRANSPORT_ERROR');
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.endsWith('\n') || raw.indexOf('\n') !== raw.length - 1) throw failure('NATIVE_PROTOCOL_ERROR');
    let response: T;
    try { response = parseResponse(JSON.parse(raw.slice(0, -1))); }
    catch { throw failure('NATIVE_PROTOCOL_ERROR'); }
    if (response.requestId !== request.requestId || response.launchId !== request.launchId) throw failure('NATIVE_PROTOCOL_ERROR');
    requireCurrent();
    return response;
  } catch (error) {
    if (stopped) throw failure(stopped);
    if (error instanceof NativeTransportError) throw error;
    throw failure('NATIVE_TRANSPORT_ERROR');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', cancel);
    if (handle) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let exited = false;
      try {
        handle.terminate();
        exited = await Promise.race([
          handle.waitForExit(AbortSignal.timeout(2000)).catch(() => false),
          new Promise<false>((resolve) => { cleanupTimer = setTimeout(() => resolve(false), 2000); }),
        ]);
      } catch { exited = false; }
      finally {
        clearTimeout(cleanupTimer);
        handle.stdout?.off('data', data);
        handle.stdout?.off('error', streamError);
        handle.control?.off('error', streamError);
      }
      if (!exited) throw failure('NATIVE_CLEANUP_FAILED');
    }
  }
}
