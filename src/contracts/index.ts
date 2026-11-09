import { z } from 'zod';
import { parseContract } from './shared.js';
import { nativeHealthRequestSchema } from './health.js';

export * from './actions.js';
export * from './observation.js';
export * from './receipt.js';
export * from './health.js';
export * from './approval-summary.js';
export { errorCodeSchema, ownerSchema } from './shared.js';

/** General diagnostics remain health-only. Fixture reads have a separate strict internal schema. */
export const nativeRequestSchema = nativeHealthRequestSchema;
export * from './fixture-observation.js';
export type NativeRequest = z.infer<typeof nativeRequestSchema>;
export function parseNativeRequest(value: unknown): NativeRequest {
  return parseContract(nativeRequestSchema, value);
}
