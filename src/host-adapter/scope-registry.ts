import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { bindHostContext, type HostContext } from './context.js';
import { sameHostScope, snapshotHostScope } from './scope.js';

export type HostCall = Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>;
export type HostServices = Pick<Context, 'agents' | 'sessions' | 'workingDirectory'>;
export interface ScopeLifecycle {
  agentDisposedFromHost(agent: Agent): void;
  sessionDisposedFromHost(session: Session): void;
  workspaceChangedFromHost(session: Session): void;
  dispose(): void;
}
interface TrackedScope { agent: Agent; session: Session; context: HostContext }
interface Cleanup {
  invalidate(contexts: readonly HostContext[]): void;
  policyChanged(contexts: readonly HostContext[]): void;
  dispose(): void;
}
class HostScopeError extends Error {}
export function hostContextUnavailable(code = 'HOST_CONTEXT_UNAVAILABLE'): Error {
  return new HostScopeError(`${code}: A current host-owned fixture runtime is required.`);
}

/** Snapshot once so later caller mutations cannot replace an in-flight Agent, call ID, or original signal. */
export function snapshotHostCall(exec: HostCall): HostCall {
  try {
    const agent = exec.agent;
    return Object.freeze({ ...(agent ? { agent } : {}), callId: exec.callId, signal: exec.signal });
  } catch { throw hostContextUnavailable(); }
}

/** Exact host identity and synchronous lifecycle gate only. Each runtime still owns separate private authorization. */
export class HostScopeRegistry implements ScopeLifecycle {
  readonly #generation = `generation_${randomUUID()}`;
  readonly #scopes = new Map<Agent, TrackedScope>();
  readonly #retiredAgents = new WeakSet<Agent>();
  readonly #retiredSessions = new WeakSet<Session>();
  readonly #maxScopes: number;
  #disposed = false;
  #changing = 0;
  #epoch = 0;

  constructor(private readonly host: HostServices, private readonly cleanup: Cleanup,
    private readonly domain: 'READ' | 'CONTROL', options: { maxScopes?: number } = {}) {
    this.#maxScopes = options.maxScopes ?? 64;
    if (!Number.isInteger(this.#maxScopes) || this.#maxScopes < 1 || this.#maxScopes > 256) throw hostContextUnavailable('INVALID_REQUEST');
  }

  get epoch(): number { return this.#epoch; }
  assertActive(): void { this.#requireRunning(); }

  /** Existing tracked identity only, for authority-reducing cleanup after caller abort. Never use for admission. */
  contextForCleanup(exec: HostCall): HostContext {
    try {
      const agent = exec.agent; const previous = agent && this.#scopes.get(agent);
      if (!agent || !previous || agent.session !== previous.session || this.host.agents.get(agent.id) !== agent ||
          this.host.sessions.get(previous.session.id) !== previous.session) throw hostContextUnavailable();
      return previous.context;
    } catch { throw hostContextUnavailable(); }
  }

  bind(exec: HostCall): HostContext {
    try { return this.#bindCurrent(exec); }
    catch (error) { if (error instanceof HostScopeError) throw error; throw hostContextUnavailable(); }
  }

  requireCurrent(exec: HostCall, original: HostContext, epoch: number, validate?: (context: HostContext) => void): HostContext {
    this.#requireRunning();
    if (epoch !== this.#epoch) throw hostContextUnavailable();
    const latest = this.bind(exec);
    if (epoch !== this.#epoch || !sameHostScope(snapshotHostScope(original), snapshotHostScope(latest)) || original.signal.aborted) throw hostContextUnavailable();
    if (validate) {
      validate(latest);
      // Internal policy clocks may synchronously close or advance a turn. Do not read cwd again after the final lease check.
      const agent = exec.agent; const session = agent?.session;
      const boundary = session && this.host.agents.turnBoundaryOf(session);
      this.#requireRunning();
      if (epoch !== this.#epoch || original.signal.aborted || !agent || !session || !boundary || boundary.openTurnStartSeq === null ||
          boundary.lastTurn !== latest.turn || this.host.agents.get(agent.id) !== agent || this.host.sessions.get(session.id) !== session) throw hostContextUnavailable();
    }
    return latest;
  }

  agentDisposedFromHost(agent: Agent): void {
    this.#retiredAgents.add(agent);
    this.#invalidate([...this.#scopes.values()].filter((scope) => scope.agent === agent));
  }

  sessionDisposedFromHost(session: Session): void {
    this.#retiredSessions.add(session);
    this.#invalidate([...this.#scopes.values()].filter((scope) => scope.session === session));
  }

  workspaceChangedFromHost(session: Session): void {
    this.#invalidate([...this.#scopes.values()].filter((scope) => scope.session === session));
  }

  policyChangedFromHost(): void {
    if (this.#disposed) return;
    this.#epoch += 1; this.#changing += 1;
    try {
      const previous = [...this.#scopes.values()]; this.#scopes.clear();
      this.cleanup.policyChanged(previous.map((scope) => scope.context));
    } finally { this.#changing -= 1; }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#epoch += 1; this.#scopes.clear();
    this.cleanup.dispose();
  }

  #bindCurrent(exec: HostCall): HostContext {
    this.#requireRunning();
    const agent = exec.agent; const session = agent?.session;
    if (!agent || !session || this.#retiredAgents.has(agent) || this.#retiredSessions.has(session)) throw hostContextUnavailable();
    this.#retireReplacedScopes(); this.#requireRunning();
    const epoch = this.#epoch;
    const context = bindHostContext(this.host, exec, this.#generation);
    // Revalidate the open turn after cwd/registry access; a synchronous getter may close it without an event.
    const boundary = this.host.agents.turnBoundaryOf(session);
    if (boundary.openTurnStartSeq === null || boundary.lastTurn !== context.turn || exec.signal.aborted) throw hostContextUnavailable();
    // Host getters may synchronously change registries or publish lifecycle events.
    if (this.host.agents.get(agent.id) !== agent || this.host.sessions.get(session.id) !== session) throw hostContextUnavailable();
    this.#requireRunning();
    if (epoch !== this.#epoch || exec.agent !== agent || agent.session !== session || this.#retiredAgents.has(agent) || this.#retiredSessions.has(session)) throw hostContextUnavailable();
    const previous = this.#scopes.get(agent);
    if (previous && (previous.session !== session || previous.context.workspace !== context.workspace)) {
      this.#invalidate([previous]); throw hostContextUnavailable(`${this.domain}_DENIED`);
    }
    if (!previous && this.#scopes.size >= this.#maxScopes) throw hostContextUnavailable(`${this.domain}_CAPACITY`);
    this.#scopes.set(agent, { agent, session, context });
    return context;
  }

  #retireReplacedScopes(): void {
    const epoch = this.#epoch; const stale: TrackedScope[] = [];
    for (const scope of this.#scopes.values()) {
      const agentLive = scope.agent.id === scope.context.owner.agentId && this.host.agents.get(scope.agent.id) === scope.agent;
      const sessionLive = this.host.sessions.get(scope.session.id) === scope.session && scope.agent.session === scope.session;
      if (!agentLive || !sessionLive) {
        this.#retiredAgents.add(scope.agent);
        if (!sessionLive) this.#retiredSessions.add(scope.session);
        stale.push(scope);
      }
    }
    this.#requireRunning();
    if (epoch !== this.#epoch) throw hostContextUnavailable();
    if (stale.length) this.#invalidate(stale);
  }

  #invalidate(scopes: TrackedScope[]): void {
    this.#epoch += 1; this.#changing += 1;
    try {
      for (const scope of scopes) this.#scopes.delete(scope.agent);
      this.cleanup.invalidate(scopes.map((scope) => scope.context));
    } finally { this.#changing -= 1; }
  }

  #requireRunning(): void { if (this.#disposed || this.#changing > 0) throw hostContextUnavailable(); }
}
