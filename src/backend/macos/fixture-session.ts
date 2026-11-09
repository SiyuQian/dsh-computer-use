import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { parseFixtureTarget, type FixtureTarget } from '../../contracts/fixture-observation.js';

interface Ready { pid: number; processStart: string; windows: Array<{ windowKey: 'primary' | 'secondary'; windowId: number; windowInstance: string }> }

/**
 * Owns one launched copy of the plugin's own AppKit fixture (public test data only). Visible windows are optional;
 * the fixture never activates itself. Its state directory is a fresh 0700 temp dir removed on close.
 */
export class FixtureSession {
  #handle: SubprocessHandle | undefined;
  #ready: Ready | undefined;
  #directory: string | undefined;
  #starting: Promise<Ready> | undefined;

  constructor(private readonly provider: Pick<SubprocessRuntime, 'spawn'>, private readonly repositoryRoot: string,
    private readonly options: { visible: boolean }) {}

  async target(windowKey: 'primary' | 'secondary', signal: AbortSignal): Promise<FixtureTarget> {
    const ready = await this.#ensure(signal);
    const window = ready.windows.find((candidate) => candidate.windowKey === windowKey);
    if (!window) throw new Error('TARGET_CHANGED: The fixture window is unavailable.');
    return parseFixtureTarget({ pid: ready.pid, processStart: ready.processStart, ...window });
  }

  get stateDirectory(): string | undefined { return this.#directory; }

  async close(): Promise<void> {
    const handle = this.#handle; const directory = this.#directory;
    this.#handle = undefined; this.#ready = undefined; this.#starting = undefined; this.#directory = undefined;
    if (handle) { handle.terminate(); await handle.waitForExit(AbortSignal.timeout(2000)).catch(() => false); }
    if (directory && resolve(directory).startsWith(resolve(tmpdir(), 'cu-fixture-session-'))) await rm(directory, { recursive: true }).catch(() => {});
  }

  #ensure(signal: AbortSignal): Promise<Ready> {
    if (this.#ready) return Promise.resolve(this.#ready);
    this.#starting ??= this.#launch(signal).catch(async (error) => { await this.close(); throw error; });
    return this.#starting;
  }

  async #launch(signal: AbortSignal): Promise<Ready> {
    this.#directory = await mkdtemp(join(tmpdir(), 'cu-fixture-session-'));
    const argv = [join(this.repositoryRoot, 'dist/native/CUFixture.app/Contents/MacOS/CUFixture'), this.options.visible ? '--host-visible' : '--observe-host',
      '--state-dir', this.#directory];
    const handle = this.provider.spawn({ argv, cwd: this.repositoryRoot, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 256 } }, graceMs: 100 });
    this.#handle = handle;
    const ready = await new Promise<Ready>((done, reject) => {
      let raw = '';
      const timer = setTimeout(() => reject(new Error('CAPABILITY_UNAVAILABLE: The fixture did not start.')), 10_000);
      const abort = () => { clearTimeout(timer); reject(new Error('CANCELLED: Fixture start was cancelled.')); };
      signal.addEventListener('abort', abort, { once: true });
      handle.stdout?.on('data', (chunk: Buffer | string) => {
        raw += chunk.toString();
        if (raw.length > 2048) { clearTimeout(timer); reject(new Error('CAPABILITY_UNAVAILABLE: Fixture readiness exceeded its bound.')); }
        else if (raw.endsWith('\n')) {
          clearTimeout(timer); signal.removeEventListener('abort', abort);
          try { done(JSON.parse(raw) as Ready); } catch { reject(new Error('CAPABILITY_UNAVAILABLE: Fixture readiness was invalid.')); }
        }
      });
      handle.done.then(() => { clearTimeout(timer); reject(new Error('CAPABILITY_UNAVAILABLE: The fixture exited.')); }, () => {});
    });
    handle.done.then(() => { if (this.#handle === handle) { this.#handle = undefined; this.#ready = undefined; this.#starting = undefined; } }, () => {});
    this.#ready = ready;
    return ready;
  }
}
