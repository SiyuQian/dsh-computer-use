import { z } from 'zod';
import { appSchema, instant, opaqueId, ownerSchema, parseContract } from './shared.js';

export const actionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('press'), targetHandle: opaqueId }),
  z.strictObject({ kind: z.literal('set_value'), targetHandle: opaqueId, value: z.string().max(16_384) }),
]);

export const actionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('prepare'),
    taskLeaseId: opaqueId,
    observationId: opaqueId,
    action: actionSchema,
  }),
  z.strictObject({ kind: z.literal('execute'), actionId: opaqueId }),
]);

/** Host-owned state only. Parsing a lease does not authorize or register it. */
export const taskLeaseSchema = z.strictObject({
  taskLeaseId: opaqueId,
  owner: ownerSchema,
  app: appSchema,
  window: z.strictObject({ id: z.number().int().positive(), instance: opaqueId }),
  mode: z.enum(['background', 'takeover']),
  allowedOperations: z.array(z.enum(['press', 'set_value'])).min(1).max(2),
  allowedTargetHandles: z.array(opaqueId).min(1).max(500),
  issuedAt: instant,
  expiresAt: instant,
  idleTimeoutMs: z.number().int().positive().max(600_000),
  maxActions: z.number().int().positive().max(100),
  policyVersion: opaqueId,
  revocationVersion: z.number().int().nonnegative(),
  authorization: z.enum(['allowed-once', 'static-fixture-policy']),
}).refine((lease) => Date.parse(lease.expiresAt) > Date.parse(lease.issuedAt));

export type Action = z.infer<typeof actionSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type TaskLease = z.infer<typeof taskLeaseSchema>;

export function parseActionRequest(value: unknown): ActionRequest {
  return parseContract(actionRequestSchema, value);
}
export function parseTaskLease(value: unknown): TaskLease {
  return parseContract(taskLeaseSchema, value);
}
