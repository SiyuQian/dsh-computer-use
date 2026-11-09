import { isAbsolute } from 'node:path';
import type { HostContext } from './context.js';
import { ownerSchema, parseContract } from '../contracts/shared.js';

export interface HostScope {
  agentId: string;
  sessionId: string;
  generation: string;
  workspace: string;
  lifetime: object;
}

/** Snapshot an already host-bound caller. Validation is not authentication or permission. */
export function snapshotHostScope(context: HostContext): HostScope {
  if (context.signal.aborted) throw new Error('CANCELLED: The host call was cancelled.');
  return snapshotHostScopeForRevocation(context);
}

/** Identity checks for authority-reducing cleanup only. Cancellation must not prevent release; never use for admission. */
export function snapshotHostScopeForRevocation(context: HostContext): HostScope {
  const owner = parseContract(ownerSchema, context.owner);
  if (!isAbsolute(context.workspace) || typeof context.lifetime !== 'object' || context.lifetime === null) {
    throw new Error('INVALID_REQUEST: A current host scope is required.');
  }
  return { ...owner, workspace: context.workspace, lifetime: context.lifetime };
}

export function sameHostScope(first: HostScope, second: HostScope): boolean {
  return first.agentId === second.agentId && first.sessionId === second.sessionId && first.generation === second.generation &&
    first.workspace === second.workspace && first.lifetime === second.lifetime;
}
