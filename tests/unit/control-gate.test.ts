import { describe, expect, it } from 'vitest';
import { ControlGate } from '../../src/host-adapter/control-gate.js';

function fakeController() {
  const abort = new AbortController(); let closed = false; let begins = 0;
  return {
    begins: () => begins,
    kill: () => { closed = true; },
    controller: {
      get signal() { return abort.signal; },
      get revoked() { return abort.signal.aborted; },
      status: () => (closed ? 'closed' as const : abort.signal.aborted ? 'revoked' as const : 'idle' as const),
      begin: async () => { begins += 1; if (abort.signal.aborted || closed) throw new Error('CONTROL_STOPPED'); return { signal: abort.signal, end: async () => {} }; },
      revokeFromHost: () => abort.abort(),
      close: async () => { closed = true; },
    },
  };
}

describe('review P1: host-side sticky stop independent of controller process lifetime', () => {
  it('blocks dispatch after stop even when no controller was ever started', async () => {
    let starts = 0;
    const gate = new ControlGate(async () => { starts += 1; return fakeController().controller; });
    await gate.stop();
    await expect(gate.begin()).rejects.toThrow('CONTROL_STOPPED');
    expect(starts).toBe(0);
  });

  it('does not start a fresh un-revoked controller after the stopped one dies', async () => {
    const first = fakeController(); let starts = 0;
    const gate = new ControlGate(async () => { starts += 1; return first.controller; });
    (await gate.begin()); first.controller.revokeFromHost();
    first.kill();
    await expect(gate.begin()).rejects.toThrow('CONTROL_STOPPED');
    await expect(gate.begin()).rejects.toThrow('CONTROL_STOPPED');
    expect(starts).toBe(1);
  });

  it('restarts a controller that crashed without being revoked', async () => {
    const first = fakeController(); const second = fakeController(); const queue = [first, second];
    const gate = new ControlGate(async () => queue.shift()!.controller);
    await gate.begin(); first.kill();
    await expect(gate.begin()).resolves.toBeDefined();
    expect(second.begins()).toBe(1);
  });
});
