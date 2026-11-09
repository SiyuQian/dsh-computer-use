import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-working-directory';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

const lifetimes = new WeakMap<object, WeakMap<object, object>>();
function liveObjectLifetime(agent: object, session: object): object {
  let sessions = lifetimes.get(agent);
  if (!sessions) { sessions = new WeakMap(); lifetimes.set(agent, sessions); }
  let lifetime = sessions.get(session);
  if (!lifetime) { lifetime = Object.freeze({}); sessions.set(session, lifetime); }
  return lifetime;
}

export interface HostContext {
  readonly lifetime: object;
  readonly owner: Readonly<{ agentId: string; sessionId: string; generation: string }>;
  readonly callId: string;
  readonly turn: number;
  readonly workspace: string;
  readonly signal: AbortSignal;
}

/** Bind a call to exact live host objects. This is identity evidence, never a control grant. */
export function bindHostContext(
  ctx: Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>,
  exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>,
  generation: string,
): HostContext {
  exec.signal.throwIfAborted();
  const unavailable = () => new Error('HOST_CONTEXT_UNAVAILABLE: A live host-owned call context is required.');
  const agent = exec.agent;
  if (!agent || !generation || !exec.callId || !ctx.agents || !ctx.sessions || !ctx.workingDirectory) throw unavailable();
  if (ctx.agents.get(agent.id) !== agent || ctx.sessions.get(agent.session.id) !== agent.session || agent.id !== agent.session.id) throw unavailable();
  const boundary = ctx.agents.turnBoundaryOf(agent.session);
  if (boundary.openTurnStartSeq === null || boundary.lastTurn < 1) throw unavailable();
  const workspace = ctx.workingDirectory.get(agent.session);
  if (!isAbsolute(workspace)) throw unavailable();
  return Object.freeze({
    lifetime: liveObjectLifetime(agent, agent.session),
    owner: Object.freeze({ agentId: agent.id, sessionId: agent.session.id, generation }),
    callId: exec.callId,
    turn: boundary.lastTurn,
    workspace,
    signal: exec.signal,
  });
}
