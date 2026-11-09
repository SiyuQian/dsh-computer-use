import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fixtureElementSchema, parseFixtureSnapshot, parseFixtureTarget, type FixtureElement, type FixtureSnapshot, type FixtureTarget } from '../contracts/fixture-observation.js';
import { parseObservation, type Observation } from '../contracts/observation.js';
import { instant, opaqueId, parseContract } from '../contracts/shared.js';

const contextSchema = z.strictObject({
  generation: opaqueId,
  observationId: opaqueId,
  observedAt: instant,
  ttlMs: z.number().int().min(5000).max(60_000),
});
type ObservationContext = z.infer<typeof contextSchema>;
const roles = new Map<string, 'button' | 'text-field' | 'static-text' | 'group'>([
  ['AXButton', 'button'], ['AXTextField', 'text-field'], ['AXStaticText', 'static-text'], ['AXGroup', 'group'],
]);

export interface FixtureBinding { target: FixtureTarget; element: FixtureElement }

/** Project already-authorized fixture data without exposing backend lifecycle witnesses. */
export function projectFixtureObservation(raw: unknown, expected: unknown, context: ObservationContext): Observation {
  return projectFixtureObservationForHost(raw, expected, context).observation;
}

/** Internal atomic public projection and private handle binding. Neither output authorizes input. */
export function projectFixtureObservationForHost(raw: unknown, expected: unknown, context: ObservationContext): {
  observation: Observation; fixtureCandidates: Map<string, FixtureBinding>;
} {
  const snapshot = parseFixtureSnapshot(raw);
  const target = parseFixtureTarget(expected);
  const bound = parseContract(contextSchema, context);
  if (snapshot.pid !== target.pid || snapshot.processStart !== target.processStart || snapshot.windowKey !== target.windowKey ||
      snapshot.windowId !== target.windowId || snapshot.windowInstance !== target.windowInstance) {
    throw new Error('TARGET_CHANGED: Fixture process or window no longer matches the authorized target.');
  }
  const reasons = new Set(snapshot.reasons);
  const elements: Observation['elements'] = [];
  const fixtureCandidates = new Map<string, FixtureBinding>();
  for (const node of snapshot.nodes) {
    if (node.depth > 12) { reasons.add('depth_limit'); continue; }
    if (elements.length >= 64) { reasons.add('node_limit'); break; }
    const role: Observation['elements'][number]['role'] = roles.get(node.role) ?? 'other';
    const knownPublicText = node.role === 'AXTextField' && node.identifier === 'fixture.text' &&
      ['', 'AXStandardTextField'].includes(node.subrole);
    const secure = node.secure || node.subrole === 'AXSecureTextField' || node.identifier === 'fixture.secure' ||
      role === 'other' || (role === 'text-field' && !knownPublicText);
    if (node.label.length > 256 || (!secure && node.value && node.value.length > 1024)) reasons.add('text_limit');
    const common = {
      handle: `element_${randomUUID()}`,
      role,
      name: node.label.slice(0, 256),
      enabled: node.enabled,
      actions: secure ? [] : node.actions.filter((action) => (action === 'press' && role === 'button') || (action === 'set_value' && role === 'text-field')),
    };
    if (secure) elements.push({ ...common, secure: true });
    else elements.push({ ...common, secure: false, ...(node.value !== undefined ? { value: node.value.slice(0, 1024) } : {}) });
    if (!secure && node.enabled) {
      const operation = node.identifier === 'fixture.text' && node.role === 'AXTextField' && knownPublicText ? 'set_value' :
        node.role === 'AXButton' && node.subrole === '' && node.identifier !== 'fixture.text' ? 'press' : undefined;
      const binding = fixtureElementSchema.safeParse({ identifier: node.identifier, instance: node.elementInstance, operation });
      if (binding.success && common.actions.includes(binding.data.operation) && uniqueFixtureWitness(snapshot, node)) {
        fixtureCandidates.set(common.handle, { target: structuredClone(target), element: binding.data });
      }
    }
  }
  // Public handles rotate each observation; revisions depend on content, not those handles.
  const semantic = elements.map(({ handle: _handle, ...element }) => element);
  const structureRevision = createHash('sha256').update(JSON.stringify({ frame: snapshot.frame, semantic })).digest('hex');
  const observation = parseObservation({
    observationId: bound.observationId,
    generation: bound.generation,
    observedAt: bound.observedAt,
    expiresAt: new Date(Date.parse(bound.observedAt) + bound.ttlMs).toISOString(),
    app: { bundleId: snapshot.bundleId, pid: snapshot.pid, processStart: snapshot.processStart },
    window: { id: snapshot.windowId, instance: snapshot.windowInstance, frame: snapshot.frame },
    structureRevision,
    elements,
    coverage: { truncated: snapshot.truncated || reasons.size > 0, reasons: [...reasons] },
  });
  if (observation.coverage.truncated) fixtureCandidates.clear();
  return { observation, fixtureCandidates };
}

function uniqueFixtureWitness(snapshot: FixtureSnapshot, node: FixtureSnapshot['nodes'][number]): boolean {
  return snapshot.nodes.filter((other) => other.identifier === node.identifier).length === 1 &&
    snapshot.nodes.filter((other) => other.elementInstance === node.elementInstance).length === 1;
}
