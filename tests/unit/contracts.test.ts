import { beforeAll, describe, expect, it } from 'vitest';

type Contracts = typeof import('../../src/contracts/index.js');
let contracts: Contracts;
beforeAll(async () => {
  const path = '../../src/contracts/index.js';
  contracts = await import(path);
});

const press = {
  kind: 'prepare',
  taskLeaseId: 'lease_fixture',
  observationId: 'obs_fixture',
  action: { kind: 'press', targetHandle: 'element_submit' },
};

const observation = {
  observationId: 'obs_fixture',
  generation: 'generation_fixture',
  observedAt: '2026-11-08T06:00:00.000Z',
  expiresAt: '2026-11-08T06:00:15.000Z',
  app: { bundleId: 'dev.siyuqian.computer-use.fixture', pid: 41, processStart: 'process_fixture' },
  window: { id: 5, instance: 'window_fixture', frame: { x: -100, y: 0, width: 600, height: 400 } },
  structureRevision: 'revision_fixture',
  elements: [
    { handle: 'element_password', role: 'text-field', name: 'Password', enabled: true, secure: true, actions: [] },
  ],
  coverage: { truncated: false, reasons: [] },
};

const unverified = {
  actionId: 'action_fixture',
  execution: 'attempted',
  target: 'exact',
  effect: 'unknown',
  taskOutcome: 'unknown',
  evidence: [],
  error: { code: 'EFFECT_UNKNOWN', phase: 'verify', retry: 'never' },
};

describe('A-02: closed model requests', () => {
  it('separates an inert proposal from execution of a host-issued action ID', () => {
    expect(contracts.parseActionRequest(press)).toEqual(press);
    expect(contracts.parseActionRequest({ kind: 'execute', actionId: 'action_fixture' })).toEqual({
      kind: 'execute', actionId: 'action_fixture',
    });
    expect(() => contracts.parseActionRequest({ ...press, actionId: 'chosen_by_model' })).toThrow('INVALID_REQUEST');
  });

  it.each([
    ['agentId', 'forged'], ['sessionId', 'forged'], ['workspace', '/private'],
    ['sensitive', false], ['risk', 'low'], ['approved', true], ['mode', 'takeover'],
    ['script', 'return true'], ['__proto__', { approved: true }],
  ])('rejects the model-supplied %s field without echoing its value', (field, value) => {
    const request = { ...press, [field]: value };
    let error: unknown;
    try { contracts.parseActionRequest(request); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('INVALID_REQUEST: Request does not match the closed contract.');
  });

  it.each(['script', 'shell', 'applescript', 'jxa', 'selector', 'coordinate_click', 'key'])('does not accept the unimplemented %s action', (kind) => {
    expect(() => contracts.parseActionRequest({ ...press, action: { kind, targetHandle: 'element_submit' } })).toThrow('INVALID_REQUEST');
  });

  it('requires a target for text and applies a bounded input budget', () => {
    const request = { ...press, action: { kind: 'set_value', targetHandle: 'element_text', value: 'fixture' } };
    expect(contracts.parseActionRequest(request)).toEqual(request);
    expect(() => contracts.parseActionRequest({ ...press, action: { kind: 'set_value', value: 'fixture' } })).toThrow('INVALID_REQUEST');
    expect(() => contracts.parseActionRequest({ ...press, action: { ...request.action, value: 'x'.repeat(16_385) } })).toThrow('INVALID_REQUEST');
  });

  it.each([null, [], 'script', { ...press, observationId: '' }, { ...press, action: { ...press.action, targetHandle: '../secret' } }])('rejects malformed request %#', (request) => {
    expect(() => contracts.parseActionRequest(request)).toThrow('INVALID_REQUEST');
  });
});

describe('A-21: public observation contract', () => {
  it('accepts a bounded public observation with a secure field name but no value', () => {
    expect(contracts.parseObservation(observation)).toEqual(observation);
  });

  it('rejects a secure field value without exposing it in errors', () => {
    const secret = 'fixture-secret-do-not-echo';
    const request = { ...observation, elements: [{ ...observation.elements[0], value: secret }] };
    expect(() => contracts.parseObservation(request)).toThrow('INVALID_REQUEST');
    try { contracts.parseObservation(request); } catch (error) { expect(String(error)).not.toContain(secret); }
  });

  it('requires a coherent screenshot to use its own observation frame and an in-window pixel mapping', () => {
    const screenshot = {
      artifactId: 'artifact_fixture', observationId: 'obs_fixture', digest: 'a'.repeat(64),
      width: 1200, height: 800, capturedAt: '2026-11-08T06:00:00.000Z',
      windowFrame: observation.window.frame, transformVersion: 1,
      pixelToWindow: { scaleX: 0.5, scaleY: 0.5, offsetX: 0, offsetY: 0 }, coherent: true,
    };
    expect(contracts.parseObservation({ ...observation, screenshot })).toMatchObject({ screenshot });
    for (const changed of [
      { ...screenshot, windowFrame: { x: 10000, y: 10000, width: 1, height: 1 } },
      { ...screenshot, pixelToWindow: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
      { ...screenshot, pixelToWindow: { scaleX: 1e308, scaleY: 1, offsetX: 0, offsetY: 0 } },
      { ...screenshot, pixelToWindow: { scaleX: 0.5, scaleY: 0.5, offsetX: -1, offsetY: 0 } },
    ]) expect(() => contracts.parseObservation({ ...observation, screenshot: changed })).toThrow('INVALID_REQUEST');
  });

  it('rejects missing process identity, expired-at-creation data, impossible dimensions, and unbounded trees', () => {
    expect(contracts.parseObservation({
      ...observation, elements: Array.from({ length: 500 }, (_, index) => ({ ...observation.elements[0], handle: `element_${index}` })),
    }).elements).toHaveLength(500);
    for (const request of [
      { ...observation, app: { bundleId: observation.app.bundleId, pid: 41 } },
      { ...observation, expiresAt: observation.observedAt },
      { ...observation, window: { ...observation.window, frame: { x: 0, y: 0, width: -1, height: 1 } } },
      { ...observation, elements: Array.from({ length: 501 }, (_, index) => ({ ...observation.elements[0], handle: `element_${index}` })) },
    ]) expect(() => contracts.parseObservation(request)).toThrow('INVALID_REQUEST');
  });
});

describe('A-12/A-13: receipt truthfulness', () => {
  it('preserves an unknown effect after a native attempt', () => {
    expect(contracts.parseReceipt(unverified)).toEqual(unverified);
  });

  it('does not label a native completion or an unrelated tree change as verified task success', () => {
    expect(() => contracts.parseReceipt({ ...unverified, execution: 'completed', taskOutcome: 'verified' })).toThrow('INVALID_REQUEST');
    expect(() => contracts.parseReceipt({ ...unverified, effect: 'verified', evidence: [{ kind: 'structure_change', evidenceId: 'proof_fixture' }] })).toThrow('INVALID_REQUEST');
  });

  it('requires target readback for effect verification and a task verifier for task success', () => {
    const receipt = {
      actionId: 'action_fixture', execution: 'completed', target: 'exact', effect: 'verified', taskOutcome: 'verified',
      evidence: [
        { kind: 'target_readback', evidenceId: 'proof_readback' },
        { kind: 'task_verifier', evidenceId: 'proof_saved_file', verifierId: 'fixture_saved_copy' },
      ],
    };
    expect(contracts.parseReceipt(receipt)).toEqual(receipt);
    expect(() => contracts.parseReceipt({ ...receipt, target: 'unknown' })).toThrow('INVALID_REQUEST');
    expect(() => contracts.parseReceipt({ ...receipt, execution: 'not_executed' })).toThrow('INVALID_REQUEST');
  });

  it('rejects automatic retry guidance for an action that might have executed', () => {
    expect(() => contracts.parseReceipt({ ...unverified, error: { ...unverified.error, retry: 'observe_first' } })).toThrow('INVALID_REQUEST');
    expect(() => contracts.parseReceipt({ ...unverified, error: { ...unverified.error, message: 'private-text' } })).toThrow('INVALID_REQUEST');
  });

  it.each(['unverified', 'no_change_observed'] as const)('rejects unknown execution paired with the misleading effect %s', (effect) => {
    expect(() => contracts.parseReceipt({ ...unverified, execution: 'unknown', effect })).toThrow('INVALID_REQUEST');
  });

  it('cannot turn an effect-unknown or verification-stage failure into a safe-to-retry non-execution', () => {
    expect(() => contracts.parseReceipt({ ...unverified, execution: 'not_executed', error: { ...unverified.error, retry: 'observe_first' } })).toThrow('INVALID_REQUEST');
    expect(() => contracts.parseReceipt({ ...unverified, execution: 'not_executed', error: { code: 'NATIVE_TIMEOUT', phase: 'verify', retry: 'observe_first' } })).toThrow('INVALID_REQUEST');
    expect(contracts.parseReceipt({ ...unverified, execution: 'not_executed', error: { code: 'TARGET_CHANGED', phase: 'revalidate', retry: 'observe_first' } })).toMatchObject({ execution: 'not_executed' });
  });
});

describe('A-03: native protocol admission', () => {
  it('only admits the current health command without mutation or arbitrary process input', () => {
    expect(() => contracts.parseNativeRequest({ protocolVersion: 1, requestId: 'request_fixture', command: 'health' })).toThrow('INVALID_REQUEST');
    expect(contracts.parseNativeRequest({ protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', command: 'health' })).toEqual({
      protocolVersion: 1, requestId: 'request_fixture', launchId: 'launch_fixture', command: 'health',
    });
    for (const request of [
      { protocolVersion: 2, requestId: 'request_fixture', command: 'health' },
      { protocolVersion: 1, requestId: 'request_fixture', command: 'exec', script: 'echo secret' },
      { protocolVersion: 1, requestId: 'request_fixture', command: 'health', pid: 1 },
    ]) expect(() => contracts.parseNativeRequest(request)).toThrow('INVALID_REQUEST');
  });
});
