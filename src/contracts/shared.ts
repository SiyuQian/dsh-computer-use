import { z } from 'zod';

export const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const instant = z.iso.datetime({ offset: true });
export const rectSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});
export const ownerSchema = z.strictObject({
  agentId: opaqueId,
  sessionId: opaqueId,
  generation: opaqueId,
});
export const appSchema = z.strictObject({
  bundleId: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
  pid: z.number().int().positive(),
  processStart: opaqueId,
});
export const errorCodeSchema = z.enum([
  'INVALID_REQUEST', 'UNSUPPORTED_PLATFORM', 'CAPABILITY_UNAVAILABLE',
  'READ_DENIED', 'CONTROL_DENIED', 'LEASE_EXPIRED', 'OBSERVATION_EXPIRED',
  'TARGET_CHANGED', 'TARGET_AMBIGUOUS', 'FOCUS_CHANGED', 'APPROVAL_REQUIRED',
  'APPROVAL_UNAVAILABLE', 'APPROVAL_INVALIDATED', 'CONTROL_BUSY',
  'USER_INTERVENED', 'ACTION_ID_CONFLICT', 'NATIVE_TIMEOUT', 'EFFECT_UNKNOWN',
  'CANCELLED', 'PROTOCOL_MISMATCH', 'ARTIFACT_INVALID',
]);

/** Parse at a trust boundary without exposing source values or validator diagnostics. */
export function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('INVALID_REQUEST: Request does not match the closed contract.');
  return result.data;
}
