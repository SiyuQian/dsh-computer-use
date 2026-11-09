export interface GateController {
  readonly signal: AbortSignal;
  readonly revoked: boolean;
  status(): 'idle' | 'active' | 'revoked' | 'closed';
  begin(): Promise<{ signal: AbortSignal; end(): Promise<void> }>;
  revokeFromHost(): void;
  close(): Promise<void>;
}
function stopped(): Error { return new Error('CONTROL_STOPPED: Computer use was stopped. Reload the plugin to re-enable it.'); }

/**
 * Host-side sticky stop. Stop is remembered here, so it holds even if no controller process ever started or the
 * revoked controller later dies. A controller that exits without being revoked may be restarted.
 */
export class ControlGate {
  #controller: Promise<GateController> | undefined;
  #stopped = false;
  constructor(private readonly start: () => Promise<GateController>) {}

  get stopped(): boolean { return this.#stopped; }

  async begin(): Promise<{ signal: AbortSignal; end(): Promise<void> }> {
    if (this.#stopped) throw stopped();
    const controller = await this.#current();
    if (this.#stopped) { controller.revokeFromHost(); throw stopped(); }
    return controller.begin();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const current = this.#controller ? await this.#controller.catch(() => undefined) : undefined;
    current?.revokeFromHost();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    const current = this.#controller ? await this.#controller.catch(() => undefined) : undefined;
    this.#controller = undefined;
    await current?.close().catch(() => {});
  }

  async #current(): Promise<GateController> {
    if (this.#controller) {
      const existing = await this.#controller.catch(() => undefined);
      if (existing && existing.status() !== 'closed') return existing;
      // A revoked controller that later died must not be replaced by a fresh, un-revoked one.
      if (existing?.revoked) { this.#stopped = true; throw stopped(); }
      this.#controller = undefined;
    }
    this.#controller = this.start().catch((error) => { this.#controller = undefined; throw error; });
    return this.#controller;
  }
}
