import { z } from 'zod';
import { opaqueId, parseContract } from './shared.js';

export const nativeHealthRequestSchema = z.strictObject({
  protocolVersion: z.literal(1), requestId: opaqueId, launchId: opaqueId, command: z.literal('health'),
});

export const nativeHealthSchema = z.strictObject({
  protocolVersion: z.literal(1),
  requestId: opaqueId,
  launchId: opaqueId,
  status: z.literal('ok'),
  commands: z.tuple([z.literal('health'), z.literal('observe_fixture'), z.literal('revalidate_fixture'), z.literal('act_fixture')]),
  helperPid: z.number().int().positive(),
  capabilities: z.strictObject({
    axObservation: z.literal(false),
    mutation: z.literal('fixture_semantic_only'),
    keyboard: z.literal(false),
    pointer: z.literal(false),
  }),
  permissions: z.strictObject({ accessibility: z.boolean(), screenCapture: z.boolean() }),
});
export type NativeHealth = z.infer<typeof nativeHealthSchema>;
export function parseNativeHealth(value: unknown): NativeHealth {
  return parseContract(nativeHealthSchema, value);
}
