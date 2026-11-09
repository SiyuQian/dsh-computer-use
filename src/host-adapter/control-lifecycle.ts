import type { Context } from '@deepseek-ai/cordis';
import { FixtureControlRuntime } from '../service/fixture-control-runtime.js';
import { installScopeLifecycle } from './scope-lifecycle.js';
import type { HostServices } from './scope-registry.js';

/** Opt-in static-fixture policy lifecycle. Not installed at the plugin entry and not an authorization source. */
export function installFixtureControlRuntime(ctx: Context, host: HostServices, options: { maxScopes?: number } = {}): FixtureControlRuntime {
  ctx.fiber.assertActive();
  const runtime = new FixtureControlRuntime(host, options);
  installScopeLifecycle(ctx, runtime, 'cu.fixtureControlLifecycle');
  return runtime;
}
