import type { Context } from '@deepseek-ai/cordis';
import type { ApprovalOutcome, ApprovalRequest, ApprovalService } from '@deepseek-ai/dsh-user-approval';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { pendingApprovalSummarySchema } from '../contracts/approval-summary.js';
import { bindHostContext } from './context.js';
import { sameHostScope, snapshotHostScope } from './scope.js';

const outcomes = new Set<ApprovalOutcome>(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
type Host = Pick<Context, 'agents' | 'sessions' | 'workingDirectory'> & { approval?: Pick<ApprovalService, 'config' | 'overrideOf' | 'request'> };

/** Public SDK adapter. Disabled unless a trusted host explicitly enables interaction; this package never enables it by default. */
export class HostApprovalAdapter {
  readonly #interactiveEnabled: boolean;
  constructor(private readonly host: Host, options: { interactiveEnabled?: boolean } = {}) {
    this.#interactiveEnabled = options.interactiveEnabled === true;
  }

  async request(exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>, generation: string, rawPending: unknown): Promise<ApprovalOutcome> {
    if (exec.signal.aborted) return 'cancelled';
    if (!this.#interactiveEnabled || !this.host.approval) return 'unavailable';
    const parsed = pendingApprovalSummarySchema.safeParse(rawPending);
    if (!parsed.success) return 'unavailable';
    try {
      const before = bindHostContext(this.host, exec, generation);
      const agent = exec.agent;
      if (!agent) return 'unavailable';
      const approval = this.host.approval;
      if ((approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask') === 'never') return 'unavailable';
      const summary = parsed.data.summary;
      const request: ApprovalRequest = {
        agent, toolName: 'cu_act', callId: exec.callId,
        reason: `Fixture ${summary.operation}; input length ${summary.inputLength}; process ${summary.pid}/${summary.processStart}; window ${summary.windowKey}/${summary.windowId}/${summary.windowInstance}; target ${summary.targetHandle}; action ${summary.actionId}; lease ${summary.leaseId}; observation ${summary.observationId}; risk ${summary.riskReason}; background mode. Input is omitted.`,
        signal: AbortSignal.any([exec.signal, AbortSignal.timeout(60_000)]),
      };
      const signal = request.signal!;
      let cancel: () => void = () => {};
      const cancelled = new Promise<ApprovalOutcome>((resolve) => { cancel = () => resolve('cancelled'); });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let outcome: ApprovalOutcome;
      try { outcome = await Promise.race([approval.request(request), cancelled]); }
      finally { signal.removeEventListener('abort', cancel); }
      if (exec.signal.aborted || request.signal?.aborted) return 'cancelled';
      const after = bindHostContext(this.host, exec, generation);
      if (!sameHostScope(snapshotHostScope(before), snapshotHostScope(after)) || before.turn !== after.turn ||
          this.host.approval !== approval || (approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask') === 'never') return 'unavailable';
      return outcomes.has(outcome) ? outcome : 'unavailable';
    } catch { return exec.signal.aborted ? 'cancelled' : 'unavailable'; }
  }
}
