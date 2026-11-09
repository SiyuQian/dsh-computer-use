import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

const controllerSources = ['native/ControlLock.swift', 'native/ControlNamespace.swift', 'native/StopChannel.swift', 'native/StopDiscovery.swift', 'native/Controller/main.swift'];
/** Local development consistency gate (same rule as the helper): source + binary must match the build manifest. Not signing. */
async function verifyController(root: string): Promise<string> {
  const invalid = () => new Error('ARTIFACT_INVALID: Rebuild the local controller (pnpm run build:stop). No controller was started.');
  try {
    const binary = join(root, 'dist/native/CUController');
    const manifest = JSON.parse(await readFile(join(root, 'dist/native/controller-manifest.json'), 'utf8')) as Record<string, unknown>;
    const info = await lstat(binary);
    if (!info.isFile() || info.uid !== process.geteuid?.() || (info.mode & 0o022) !== 0 || info.nlink !== 1) throw invalid();
    const sources = createHash('sha256');
    for (const source of controllerSources) { sources.update(source); sources.update(await readFile(join(root, source))); }
    if (manifest.distribution !== 'local-development-only' || manifest.sourceDigest !== sources.digest('hex') ||
        manifest.binaryDigest !== createHash('sha256').update(await readFile(binary)).digest('hex')) throw invalid();
    return binary;
  } catch { throw invalid(); }
}

type Status = 'ready' | 'idle' | 'active' | 'revoked' | 'busy' | 'granted' | 'drained';
function failure(code: string): Error { return new Error(`${code}: The per-user native controller did not grant control. No action was dispatched.`); }

/** One granted dispatch slot. The slot signal aborts on independent stop; aborting never claims the action did not run. */
export interface ControllerSlot { readonly signal: AbortSignal; end(): Promise<void> }

/**
 * Host client for the per-OS-user native controller (single control lock + stop-only listener).
 * It does not dispatch input. A test parent selects an owned temporary namespace; production uses the fixed per-user path.
 */
export class NativeController {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: Interface;
  readonly #abort = new AbortController();
  readonly #waiters: Array<(status: Status) => void> = [];
  #slot: AbortController | undefined;
  #closed = false;
  #revoked = false;

  private constructor(child: ChildProcessWithoutNullStreams, lines: Interface) {
    this.#child = child; this.#lines = lines;
    lines.on('line', (line) => this.#receive(line));
    // A write racing controller death fails with EPIPE. Contain it as a revocation instead of an uncaught host error.
    child.stdin.on('error', () => this.#abortLive());
    child.once('exit', () => { this.#closed = true; this.#abortLive(); for (const waiter of this.#waiters.splice(0)) waiter('drained'); });
  }

  static async start(repositoryRoot: string, options: { testParent?: string } = {}): Promise<NativeController> {
    if (process.platform !== 'darwin' || !isAbsolute(repositoryRoot)) throw failure('UNSUPPORTED_PLATFORM');
    if (options.testParent !== undefined && !isAbsolute(options.testParent)) throw failure('INVALID_REQUEST');
    const argv = options.testParent === undefined ? ['--serve'] : ['--serve', '--test-parent', options.testParent];
    const child = spawn(await verifyController(repositoryRoot), argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    const first = await new Promise<string>((done, reject) => {
      const timer = setTimeout(() => reject(failure('CONTROL_UNAVAILABLE')), 3000);
      lines.once('line', (line) => { clearTimeout(timer); done(line); });
      child.once('exit', (code) => { clearTimeout(timer); reject(failure(code === 3 ? 'CONTROL_BUSY' : 'CONTROL_UNAVAILABLE')); });
      child.once('error', () => { clearTimeout(timer); reject(failure('CONTROL_UNAVAILABLE')); });
    }).catch((error) => { child.kill('SIGKILL'); throw error; });
    let ready: { status?: string };
    try { ready = JSON.parse(first); } catch { child.kill('SIGKILL'); throw failure('CONTROL_UNAVAILABLE'); }
    if (ready.status !== 'ready') { child.kill('SIGKILL'); throw failure(ready.status === 'busy' ? 'CONTROL_BUSY' : 'CONTROL_UNAVAILABLE'); }
    return new NativeController(child, lines);
  }

  /** Aborts once the controller is revoked (independent stop, host revoke, or controller exit). */
  get signal(): AbortSignal { return this.#abort.signal; }
  /** True only for an explicit stop (independent or host), not for a plain process exit. */
  get revoked(): boolean { return this.#revoked; }
  status(): 'idle' | 'active' | 'revoked' | 'closed' {
    if (this.#closed) return 'closed';
    if (this.#abort.signal.aborted) return 'revoked';
    return this.#slot ? 'active' : 'idle';
  }

  async begin(): Promise<ControllerSlot> {
    if (this.#closed || this.#abort.signal.aborted) throw failure('CONTROL_STOPPED');
    if (this.#slot) throw failure('CONTROL_BUSY');
    const reply = await this.#request('begin');
    if (reply === 'busy') throw failure('CONTROL_BUSY');
    if (reply !== 'granted' || this.#abort.signal.aborted) throw failure('CONTROL_STOPPED');
    const slot = new AbortController(); this.#slot = slot;
    let ended = false;
    return Object.freeze({
      signal: AbortSignal.any([slot.signal, this.#abort.signal]),
      end: async () => {
        if (ended) return; ended = true;
        if (this.#slot === slot) this.#slot = undefined;
        if (!this.#closed) await this.#request('end');
      },
    });
  }

  /** Host-side sticky revoke (for example user stop in the GUI). Never resumes. */
  revokeFromHost(): void {
    this.#revoke();
    if (!this.#closed) this.#child.stdin.write('revoke\n');
  }

  async close(): Promise<void> {
    this.#abortLive();
    if (this.#closed) return;
    const exited = new Promise<void>((done) => this.#child.once('exit', () => done()));
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer); this.#lines.close();
  }

  /** Bounded: a wedged controller is treated as revoked rather than hanging the tool call. */
  #request(command: 'begin' | 'end'): Promise<Status> {
    return new Promise<Status>((done) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(settle); if (index !== -1) this.#waiters.splice(index, 1);
        this.revokeFromHost(); done('revoked');
      }, 2000);
      const settle = (status: Status) => { clearTimeout(timer); done(status); };
      this.#waiters.push(settle); this.#child.stdin.write(`${command}\n`);
    });
  }

  #receive(line: string): void {
    let message: { status?: Status };
    try { message = JSON.parse(line); } catch { this.#revoke(); return; }
    const status = message.status;
    if (status === 'revoked') this.#revoke();
    // A revoked notice may answer a pending request early; callers treat any non-granted reply as refusal.
    if (status && this.#waiters.length > 0) this.#waiters.shift()!(status);
  }

  #revoke(): void { this.#revoked = true; this.#abortLive(); }
  #abortLive(): void {
    if (!this.#abort.signal.aborted) this.#abort.abort();
    this.#slot?.abort();
  }
}
