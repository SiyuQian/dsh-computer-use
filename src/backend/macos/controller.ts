import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { isAbsolute, join } from 'node:path';

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

  private constructor(child: ChildProcessWithoutNullStreams, lines: Interface) {
    this.#child = child; this.#lines = lines;
    lines.on('line', (line) => this.#receive(line));
    child.once('exit', () => { this.#closed = true; this.#revoke(); for (const waiter of this.#waiters.splice(0)) waiter('drained'); });
  }

  static async start(repositoryRoot: string, options: { testParent?: string } = {}): Promise<NativeController> {
    if (process.platform !== 'darwin' || !isAbsolute(repositoryRoot)) throw failure('UNSUPPORTED_PLATFORM');
    if (options.testParent !== undefined && !isAbsolute(options.testParent)) throw failure('INVALID_REQUEST');
    const argv = options.testParent === undefined ? ['--serve'] : ['--serve', '--test-parent', options.testParent];
    const child = spawn(join(repositoryRoot, 'dist/native/CUController'), argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
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
    this.#revoke();
    if (this.#closed) return;
    const exited = new Promise<void>((done) => this.#child.once('exit', () => done()));
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer); this.#lines.close();
  }

  #request(command: 'begin' | 'end'): Promise<Status> {
    return new Promise<Status>((done) => { this.#waiters.push(done); this.#child.stdin.write(`${command}\n`); });
  }

  #receive(line: string): void {
    let message: { status?: Status };
    try { message = JSON.parse(line); } catch { this.#revoke(); return; }
    const status = message.status;
    if (status === 'revoked') this.#revoke();
    // A revoked notice may answer a pending request early; callers treat any non-granted reply as refusal.
    if (status && this.#waiters.length > 0) this.#waiters.shift()!(status);
  }

  #revoke(): void {
    if (!this.#abort.signal.aborted) this.#abort.abort();
    this.#slot?.abort();
  }
}
