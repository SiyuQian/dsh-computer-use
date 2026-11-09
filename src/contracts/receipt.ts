import { z } from 'zod';
import { errorCodeSchema, opaqueId, parseContract } from './shared.js';

const evidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('target_readback'), evidenceId: opaqueId }),
  z.strictObject({ kind: z.literal('structure_change'), evidenceId: opaqueId }),
  z.strictObject({ kind: z.literal('task_verifier'), evidenceId: opaqueId, verifierId: opaqueId }),
]);

export const receiptSchema = z.strictObject({
  actionId: opaqueId,
  execution: z.enum(['not_executed', 'attempted', 'completed', 'cancelled', 'unknown']),
  target: z.enum(['exact', 'rebound', 'invalid', 'unknown']),
  effect: z.enum(['verified', 'no_change_observed', 'unverified', 'unknown']),
  taskOutcome: z.enum(['not_evaluated', 'verified', 'unverified', 'unknown']),
  evidence: z.array(evidenceSchema).max(32),
  error: z.strictObject({
    code: errorCodeSchema,
    phase: z.enum(['validate', 'authorize', 'approve', 'lock', 'revalidate', 'dispatch', 'verify', 'cancel']),
    retry: z.enum(['never', 'observe_first']),
  }).optional(),
}).superRefine((receipt, ctx) => {
  const add = () => ctx.addIssue({ code: 'custom', message: 'Receipt claims require evidence and a consistent execution phase.' });
  if (receipt.effect === 'verified' && (
    receipt.execution === 'not_executed' || receipt.execution === 'unknown' ||
    (receipt.target !== 'exact' && receipt.target !== 'rebound') ||
    !receipt.evidence.some((evidence) => evidence.kind === 'target_readback')
  )) add();
  if (receipt.taskOutcome === 'verified' && (
    receipt.execution !== 'completed' || receipt.effect !== 'verified' || receipt.error ||
    !receipt.evidence.some((evidence) => evidence.kind === 'task_verifier')
  )) add();
  if (receipt.execution === 'unknown' && receipt.effect !== 'unknown') add();
  if (receipt.execution !== 'not_executed' && receipt.error?.retry === 'observe_first') add();
  if (receipt.execution === 'not_executed' && (
    receipt.error?.phase === 'verify' || receipt.error?.code === 'EFFECT_UNKNOWN'
  )) add();
});

export type ActionReceipt = z.infer<typeof receiptSchema>;
export function parseReceipt(value: unknown): ActionReceipt {
  return parseContract(receiptSchema, value);
}
