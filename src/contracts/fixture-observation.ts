import { z } from 'zod';
import { opaqueId, parseContract, rectSchema } from './shared.js';
import { nativeHealthRequestSchema } from './health.js';

export const fixtureTargetSchema = z.strictObject({
  pid: z.number().int().positive().max(2_147_483_647),
  processStart: opaqueId,
  windowKey: z.enum(['primary', 'secondary']),
  windowId: z.number().int().positive().max(2_147_483_647),
  windowInstance: opaqueId,
});
export const fixtureSnapshotSchema = z.strictObject({
  ...fixtureTargetSchema.shape,
  bundleId: z.literal('dev.siyuqian.computer-use.fixture'),
  windowId: z.number().int().positive(),
  windowInstance: opaqueId,
  frame: rectSchema,
  nodes: z.array(z.strictObject({
    nativeId: opaqueId,
    elementInstance: opaqueId.optional(),
    role: z.string().max(128),
    subrole: z.string().max(128),
    identifier: z.string().max(128),
    label: z.string().max(1024),
    enabled: z.boolean(),
    secure: z.boolean(),
    value: z.string().max(16_384).optional(),
    actions: z.array(z.enum(['press', 'set_value'])).max(2),
    depth: z.number().int().nonnegative().max(256),
  })).max(1024),
  truncated: z.boolean(),
  reasons: z.array(z.enum(['node_limit', 'depth_limit', 'text_limit', 'unavailable'])).max(4),
}).refine((value) => new Set(value.nodes.map((node) => node.nativeId)).size === value.nodes.length);

export type FixtureTarget = z.infer<typeof fixtureTargetSchema>;
export type FixtureSnapshot = z.infer<typeof fixtureSnapshotSchema>;
export function parseFixtureTarget(value: unknown): FixtureTarget {
  return parseContract(fixtureTargetSchema, value);
}
export function parseFixtureSnapshot(value: unknown): FixtureSnapshot {
  return parseContract(fixtureSnapshotSchema, value);
}

export const fixtureObserveRequestSchema = z.strictObject({
  protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId,
  command: z.literal('observe_fixture'), target: fixtureTargetSchema,
});
export const fixtureElementSchema = z.strictObject({
  identifier: z.enum(['fixture.text', 'fixture.submit', 'fixture.replace', 'fixture.reorder', 'fixture.delayed', 'fixture.save', 'fixture.reset']),
  instance: opaqueId.refine((value) => value.startsWith('element_') && value.length > 8),
  operation: z.enum(['press', 'set_value']),
});
export const fixtureRevalidateRequestSchema = z.strictObject({
  protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId,
  command: z.literal('revalidate_fixture'), target: fixtureTargetSchema, element: fixtureElementSchema,
});
export const fixtureRevalidateResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId, status: z.literal('exact'),
    dispatchable: z.literal(false), target: fixtureTargetSchema, element: fixtureElementSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId, status: z.literal('error'),
    dispatchable: z.literal(false), code: z.enum(['READ_DENIED', 'TARGET_CHANGED', 'TARGET_AMBIGUOUS', 'CAPABILITY_UNAVAILABLE']),
  }),
]);
export type FixtureElement = z.infer<typeof fixtureElementSchema>;
export type FixtureRevalidateResponse = z.infer<typeof fixtureRevalidateResponseSchema>;
export function parseFixtureRevalidateResponse(value: unknown): FixtureRevalidateResponse {
  return parseContract(fixtureRevalidateResponseSchema, value);
}
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Single owned-fixture semantic action. Value is public test data, bounded, and never echoed back. */
export const fixtureActRequestSchema = z.strictObject({
  protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId,
  command: z.literal('act_fixture'), target: fixtureTargetSchema, element: fixtureElementSchema,
  // Lone surrogates have no Foundation encoding; reject before spawn so they cannot surface as an unknown effect.
  value: z.string().max(1024).refine((value) => !loneSurrogate.test(value)).optional(),
}).refine((request) => (request.element.operation === 'press') === (request.value === undefined))
  .refine((request) => (request.element.operation === 'set_value') === (request.element.identifier === 'fixture.text'));
export const fixtureActResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId, status: z.literal('dispatched'),
    execution: z.enum(['completed', 'unknown']), readback: z.enum(['match', 'mismatch', 'unavailable', 'not_applicable']),
  }),
  z.strictObject({
    protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId, status: z.literal('error'),
    code: z.enum(['READ_DENIED', 'TARGET_CHANGED', 'TARGET_AMBIGUOUS', 'CAPABILITY_UNAVAILABLE']),
  }),
]);
export type FixtureActRequest = z.infer<typeof fixtureActRequestSchema>;
export type FixtureActResponse = z.infer<typeof fixtureActResponseSchema>;
export function parseFixtureActResponse(value: unknown): FixtureActResponse {
  return parseContract(fixtureActResponseSchema, value);
}
export const nativeReadRequestSchema = z.discriminatedUnion('command', [nativeHealthRequestSchema, fixtureObserveRequestSchema, fixtureRevalidateRequestSchema]);
export const nativeRequestSchema = z.union([nativeReadRequestSchema, fixtureActRequestSchema]);
export type NativeRequest = z.infer<typeof nativeRequestSchema>;
export type NativeReadRequest = z.infer<typeof nativeReadRequestSchema>;

export const fixtureObserveResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId,
    status: z.literal('ok'), snapshot: fixtureSnapshotSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId,
    status: z.literal('error'), code: z.enum(['READ_DENIED', 'TARGET_CHANGED', 'TARGET_AMBIGUOUS', 'CAPABILITY_UNAVAILABLE']),
  }),
]);
export type FixtureObserveRequest = z.infer<typeof fixtureObserveRequestSchema>;
export type FixtureObserveResponse = z.infer<typeof fixtureObserveResponseSchema>;
export function parseFixtureObserveRequest(value: unknown): FixtureObserveRequest {
  return parseContract(fixtureObserveRequestSchema, value);
}
export function parseFixtureObserveResponse(value: unknown): FixtureObserveResponse {
  return parseContract(fixtureObserveResponseSchema, value);
}
