import { beforeAll, describe, expect, it } from 'vitest';

type Module = typeof import('../../src/observation/project.js');
let projector: Module;
beforeAll(async () => {
  const path = '../../src/observation/project.js';
  projector = await import(path);
});

const target = { pid: 41, processStart: 'process_fixture', windowKey: 'primary' as const, windowId: 7, windowInstance: 'window_fixture' };
const snapshot = {
  pid: 41, processStart: 'process_fixture', bundleId: 'dev.siyuqian.computer-use.fixture',
  windowKey: 'primary', windowId: 7, windowInstance: 'window_fixture',
  frame: { x: -200, y: 20, width: 520, height: 440 },
  nodes: [
    { nativeId: 'node_0', role: 'AXTextField', subrole: '', identifier: 'fixture.text', label: 'Fixture text', enabled: true, secure: false, value: 'public fixture text', actions: ['set_value'], depth: 1 },
    { nativeId: 'node_1', role: 'AXTextField', subrole: 'AXSecureTextField', identifier: 'fixture.secure', label: 'Password', enabled: true, secure: true, actions: [], depth: 1 },
  ],
  truncated: false, reasons: [],
};
const context = {
  generation: 'generation_fixture', observationId: 'obs_fixture',
  observedAt: '2026-11-08T08:00:00.000Z', ttlMs: 15_000,
};

describe('CU-006: target-bound public observation', () => {
  it('projects only the exact fixture process/window into a bounded public observation', () => {
    const result = projector.projectFixtureObservation(snapshot, target, context);
    expect(result.app).toEqual({ bundleId: 'dev.siyuqian.computer-use.fixture', pid: 41, processStart: 'process_fixture' });
    expect(result.window).toEqual({ id: 7, instance: 'window_fixture', frame: snapshot.frame });
    expect(result.expiresAt).toBe('2026-11-08T08:00:15.000Z');
    expect(result.elements[0]).toMatchObject({ role: 'text-field', name: 'Fixture text', enabled: true, secure: false, value: 'public fixture text', actions: ['set_value'] });
    expect(result.elements[0]?.handle).not.toBe('node_0');
    expect(result.elements[1]).toMatchObject({ secure: true, actions: [] });
    expect(result.elements[1]).not.toHaveProperty('value');
    expect(JSON.stringify(result)).not.toContain('nativeId');
    expect(result.screenshot).toBeUndefined();
  });

  it.each([
    { ...target, pid: 42 },
    { ...target, processStart: 'restarted_process' },
    { ...target, windowKey: 'secondary' as const },
    { ...target, windowId: 8 },
    { ...target, windowInstance: 'window_replaced' },
  ])('rejects a mismatched target %# before constructing handles', (changed) => {
    expect(() => projector.projectFixtureObservation(snapshot, changed, context)).toThrow('TARGET_CHANGED');
  });

  it('does not expose a backend lifecycle witness as a public handle or native execution permission', () => {
    const result = projector.projectFixtureObservation({ ...snapshot, nodes: [{ ...snapshot.nodes[0], elementInstance: 'element_native_lifetime_fixture' }] }, target, context);
    expect(JSON.stringify(result).includes('element_native_lifetime_fixture')).toBe(false);
    expect(result.elements[0]?.handle).not.toBe('element_native_lifetime_fixture');
    expect(result.elements[0]?.actions).toEqual(['set_value']);
  });

  it('rejects an app with the fixture bundle label but no exact fixture schema identity', () => {
    expect(() => projector.projectFixtureObservation({ ...snapshot, bundleId: 'private.app' }, target, context)).toThrow('INVALID_REQUEST');
    expect(() => projector.projectFixtureObservation({ ...snapshot, nodes: [{ ...snapshot.nodes[0], arbitrary: 'private-fixture-value' }] }, target, context)).toThrow('INVALID_REQUEST');
  });

  it('omits secure values even if a backend incorrectly includes one, without leaking validator input', () => {
    const secure = { ...snapshot.nodes[1], value: 'private-fixture-value', actions: ['set_value'] };
    const result = projector.projectFixtureObservation({ ...snapshot, nodes: [secure] }, target, context);
    expect(result.elements[0]).not.toHaveProperty('value');
    expect(result.elements[0]?.actions).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-fixture-value');
  });

  it('treats unknown or conflicting secure metadata as secure instead of inferring an editable field', () => {
    for (const node of [
      { ...snapshot.nodes[0], secure: true },
      { ...snapshot.nodes[0], subrole: 'AXSecureTextField' },
      { ...snapshot.nodes[0], identifier: 'fixture.secure' },
      { ...snapshot.nodes[0], role: 'AXUnknownWidget' },
      { ...snapshot.nodes[0], identifier: '' },
      { ...snapshot.nodes[0], identifier: 'unknown-field' },
      { ...snapshot.nodes[0], subrole: 'AXUnknownSubrole' },
    ]) {
      const result = projector.projectFixtureObservation({ ...snapshot, nodes: [node] }, target, context);
      expect(result.elements[0]?.secure).toBe(true);
      expect(result.elements[0]).not.toHaveProperty('value');
      expect(result.elements[0]?.actions).toEqual([]);
    }
  });

  it('bounds nodes, depth and text, and makes truncation explicit', () => {
    const nodes = Array.from({ length: 70 }, (_, index) => ({ ...snapshot.nodes[0], nativeId: `node_${index}` }));
    const bounded = projector.projectFixtureObservation({ ...snapshot, nodes }, target, context);
    expect(bounded.elements).toHaveLength(64);
    expect(bounded.coverage).toEqual({ truncated: true, reasons: ['node_limit'] });
    const deep = projector.projectFixtureObservation({ ...snapshot, nodes: [{ ...snapshot.nodes[0], depth: 13 }] }, target, context);
    expect(deep.elements).toEqual([]);
    expect(deep.coverage.reasons).toContain('depth_limit');
    const text = projector.projectFixtureObservation({ ...snapshot, nodes: [{ ...snapshot.nodes[0], value: 'x'.repeat(1025) }] }, target, context);
    expect(text.elements[0]?.secure === false ? text.elements[0].value?.length : 0).toBe(1024);
    expect(text.coverage.reasons).toContain('text_limit');
  });

  it('never reuses a public handle across different observation identities', () => {
    const first = projector.projectFixtureObservation(snapshot, target, context);
    const second = projector.projectFixtureObservation(snapshot, target, { ...context, observationId: 'obs_next' });
    expect(first.elements[0]?.handle).not.toBe(second.elements[0]?.handle);
    expect(first.structureRevision).toBe(second.structureRevision);
  });

  it('rejects duplicate native identities, invalid clocks, or invalid TTL without echoing content', () => {
    expect(() => projector.projectFixtureObservation({ ...snapshot, nodes: [snapshot.nodes[0], snapshot.nodes[0]] }, target, context)).toThrow('INVALID_REQUEST');
    expect(() => projector.projectFixtureObservation(snapshot, target, { ...context, observedAt: 'private-fixture-value' })).toThrow('INVALID_REQUEST');
    expect(() => projector.projectFixtureObservation(snapshot, target, { ...context, ttlMs: 0 })).toThrow('INVALID_REQUEST');
  });
});
