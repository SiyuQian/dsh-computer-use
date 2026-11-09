import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import type { ScopeLifecycle } from './scope-registry.js';

/** Install exact nested event disposers. Closing admission runs before any subscription is removed on teardown. */
export function installScopeLifecycle(ctx: Context, runtime: ScopeLifecycle, label: string): void {
  try {
    ctx.effect(function* () {
      yield ctx.on('agent/disposed', ({ agent }) => runtime.agentDisposedFromHost(agent));
      yield ctx.on('session/disposed', (session) => runtime.sessionDisposedFromHost(session));
      yield ctx.on('session/event', (session, event) => {
        if (event.type === 'working-directory/change') runtime.workspaceChangedFromHost(session);
      });
      yield () => runtime.dispose();
    }, label);
  } catch {
    runtime.dispose();
    throw new Error('HOST_CONTEXT_UNAVAILABLE: Fixture lifecycle registration failed.');
  }
}
