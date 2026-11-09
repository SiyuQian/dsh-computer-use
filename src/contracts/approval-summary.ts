import { z } from 'zod';
import { opaqueId } from './shared.js';

/** Safe metadata only. Neither input bytes nor their private fingerprint belong in host prompt/audit payloads. */
export const pendingApprovalSummarySchema = z.strictObject({
  approvalId: opaqueId,
  summary: z.strictObject({
    operation: z.enum(['press', 'set_value']), inputLength: z.number().int().min(0).max(16_384),
    pid: z.number().int().positive().max(2_147_483_647), windowId: z.number().int().positive(), mode: z.literal('background'),
    actionId: opaqueId, leaseId: opaqueId, observationId: opaqueId, targetHandle: opaqueId,
    processStart: opaqueId, windowKey: z.enum(['primary', 'secondary']), windowInstance: opaqueId,
    riskReason: z.enum(['unclassified_effect', 'raised_risk']),
  }),
});
export type PendingApprovalSummary = z.infer<typeof pendingApprovalSummarySchema>;
