import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-subprocess';
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { mkdtemp, rm, chmod, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FixtureComputerUse, fixtureApprovalTimeoutMs, type ApprovalSummary } from '../service/fixture-computer-use.js';
import { observeFixtureSnapshot } from '../backend/macos/observe.js';
import { actFixtureElement } from '../backend/macos/act.js';
import { NativeController } from '../backend/macos/controller.js';
import { FixtureSession } from '../backend/macos/fixture-session.js';
import { installScopeLifecycle } from './scope-lifecycle.js';
import { ControlGate } from './control-gate.js';
import { bindHostContext } from './context.js';

const json = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }];
const looseObject = { type: 'object' } as const;

/**
 * Ask the host approval service once. Approval is optional, so it is read with ctx.get instead of a required inject.
 * Refuses when the service is absent, the policy is never, or the call has no agent.
 */
export async function requestFixtureApproval(ctx: Context, exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>, summary: ApprovalSummary) {
  const approval = ctx.get('approval') as Pick<ApprovalService, 'config' | 'overrideOf' | 'request'> | undefined;
  const agent = exec.agent;
  if (!approval || !agent || exec.signal.aborted) return 'unavailable' as const;
  if ((approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask') === 'never') return 'unavailable' as const;
  const outcome = await approval.request({ agent, toolName: 'cu_act', callId: exec.callId,
    reason: `Computer use on the owned test fixture: ${summary.operation} ${summary.identifier} (${summary.windowKey} window); input length ${summary.inputLength}; risk ${summary.riskReason}. Input text is omitted.`,
    signal: AbortSignal.any([exec.signal, AbortSignal.timeout(fixtureApprovalTimeoutMs)]) });
  return outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled' ? outcome : 'unavailable' as const;
}

/** Host services the fixture tools read at call time. Cordis lets a plugin scope read only the services it declares. */
export const fixtureToolServices = ['agents', 'sessions', 'workingDirectory', 'subprocess'] as const;

/**
 * Install the fixture-only model tools in a nested scope that declares the host services they read. The tools exist
 * only while every service is available, and they are removed when a service unloads. The gate belongs to the plugin
 * scope, so a stop stays sticky until the plugin itself reloads. Returns a host-side control-state reader for cu_status.
 */
export function installFixtureTools(ctx: Context, repositoryRoot: string, options: { visible: boolean }): () => 'ready' | 'stopped' | 'disabled' {
  const gate = new ControlGate(() => NativeController.start(repositoryRoot));
  let active = false;
  ctx.effect(() => () => { void gate.close(); }, 'cu.fixtureControlGate');
  ctx.inject([...fixtureToolServices], (scope) => {
    registerFixtureTools(scope, repositoryRoot, options, gate);
    active = true;
    scope.effect(() => () => { active = false; }, 'cu.fixtureToolsActive');
  });
  return () => (gate.stopped ? 'stopped' : active ? 'ready' : 'disabled');
}

/**
 * Register the fixture-only model tools in a scope that already declares {@link fixtureToolServices}. The services are
 * resolved lazily at call time; a missing service fails closed. Approval uses the optional public DSH approval service.
 * A supplied gate is shared and owned by the caller; otherwise this scope owns a new one.
 * Returns a host-side control-state reader for cu_status.
 */
export function registerFixtureTools(ctx: Context, repositoryRoot: string, options: { visible: boolean },
  sharedGate?: ControlGate): () => 'ready' | 'stopped' | 'disabled' {
  let state: { service: FixtureComputerUse; fixture: FixtureSession; ledger: string } | undefined;
  /** Single-flight first initialization: concurrent first calls must share one runtime, fixture and ledger. */
  let starting: Promise<NonNullable<typeof state>> | undefined;
  const gate = sharedGate ?? new ControlGate(() => NativeController.start(repositoryRoot));
  /** Closing a gate makes its stop sticky, so only the gate owner may close it. */
  const ownsGate = sharedGate === undefined;
  let disposed = false;

  const host = () => {
    const c = ctx as unknown as { agents?: unknown; sessions?: unknown; workingDirectory?: unknown; subprocess?: unknown };
    if (!c.agents || !c.sessions || !c.workingDirectory || !c.subprocess) throw new Error('HOST_CONTEXT_UNAVAILABLE: Computer use requires a live DSH agent host.');
    return ctx as Context;
  };
  const requestApproval = (exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>, summary: ApprovalSummary) => requestFixtureApproval(ctx, exec, summary);
  const ensure = () => {
    if (disposed) return Promise.reject(new Error('HOST_CONTEXT_UNAVAILABLE: Computer use is disabled.'));
    if (state) return Promise.resolve(state);
    starting ??= initialize().finally(() => { starting = undefined; });
    return starting;
  };
  const initialize = async () => {
    const current = host();
    const ledger = await realpath(await mkdtemp(join(tmpdir(), 'cu-ledger-'))); await chmod(ledger, 0o700);
    const fixture = new FixtureSession(current.subprocess, repositoryRoot, options);
    const service = new FixtureComputerUse(current, {
      fixtureTarget: (windowKey, signal) => fixture.target(windowKey, signal),
      observe: (target, signal) => observeFixtureSnapshot(current.subprocess, repositoryRoot, target, { signal }),
      act: (target, element, value, signal) => actFixtureElement(current.subprocess, repositoryRoot, target, element, value, { signal, timeoutMs: 5000 }),
      beginControl: () => gate.begin(),
      requestApproval,
    }, { ledgerDirectory: ledger });
    const created = { service, fixture, ledger };
    if (disposed) { service.dispose(); await rm(ledger, { recursive: true }).catch(() => {}); throw new Error('HOST_CONTEXT_UNAVAILABLE: Computer use is disabled.'); }
    state = created;
    return created;
  };

  const observe: ToolDefinition = {
    name: 'cu_observe',
    description: 'Observe the plugin\'s own test fixture window (public test data only). Returns elements with short-lived handles. '
      + 'Always observe before acting; handles expire after about 15 seconds and after any change. Secure fields never show values.',
    parameters: { type: 'object', properties: { window: { type: 'string', enum: ['primary', 'secondary'], description: 'Fixture window. Default primary.' } }, additionalProperties: false },
    output: { schema: looseObject, render: (_args, value) => json(value) },
    async execute(args, exec) {
      bindHostContext(host(), exec, 'fixture-tools');
      const { service } = await ensure();
      return service.observe(exec, args ?? {});
    },
  };
  const act: ToolDefinition = {
    name: 'cu_act',
    description: 'Perform ONE semantic action on an element from the latest cu_observe result: press a button, or set_value on the public text field. '
      + 'The host re-validates the target, may ask the user to approve, and returns a receipt. execution=unknown means the effect is unknown: '
      + 'do not retry; observe again first. effect=unverified is not proof of task success. Use public test text only.',
    parameters: {
      type: 'object',
      properties: {
        observationId: { type: 'string' },
        action: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['press', 'set_value'] },
            targetHandle: { type: 'string' },
            value: { type: 'string', maxLength: 1024, description: 'Required for set_value only.' },
          },
          required: ['kind', 'targetHandle'], additionalProperties: false,
        },
      },
      required: ['observationId', 'action'], additionalProperties: false,
    },
    output: { schema: looseObject, render: (_args, value) => json(value) },
    async execute(args, exec) {
      bindHostContext(host(), exec, 'fixture-tools');
      const { service } = await ensure();
      return service.act(exec, args);
    },
  };
  const stop: ToolDefinition = {
    name: 'cu_stop',
    description: 'Immediately revoke all computer-use control for this OS user. Stop is sticky until the plugin is reloaded. '
      + 'Users can also run the CUController --stop client independently of the model.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: looseObject, render: (_args, value) => json(value) },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      // Host-sticky: holds even if no controller process was ever started or the revoked one later dies.
      await gate.stop();
      state?.service.policyChangedFromHost();
      return { status: 'revoked', drained: false, dispatchable: false };
    },
  };
  for (const tool of [observe, act, stop]) ctx.tools.register(tool);

  const lifecycle = {
    agentDisposedFromHost: (agent: Parameters<FixtureComputerUse['agentDisposedFromHost']>[0]) => state?.service.agentDisposedFromHost(agent),
    sessionDisposedFromHost: (session: Parameters<FixtureComputerUse['sessionDisposedFromHost']>[0]) => state?.service.sessionDisposedFromHost(session),
    workspaceChangedFromHost: (session: Parameters<FixtureComputerUse['workspaceChangedFromHost']>[0]) => state?.service.workspaceChangedFromHost(session),
    dispose: () => {
      disposed = true;
      const current = state; state = undefined;
      current?.service.dispose();
      if (ownsGate) void gate.close();
      void current?.fixture.close();
      if (current) {
        const ledger = resolve(current.ledger);
        if (ledger.startsWith(resolve(tmpdir(), 'cu-ledger-')) || ledger.startsWith(`${realpathSync(tmpdir())}/cu-ledger-`)) {
          void rm(ledger, { recursive: true }).catch(() => {});
        }
      }
    },
  };
  installScopeLifecycle(ctx, lifecycle, 'cu.fixtureTools');
  return () => (disposed ? 'disabled' : gate.stopped ? 'stopped' : 'ready');
}
