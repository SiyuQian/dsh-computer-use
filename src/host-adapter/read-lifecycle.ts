import type { Context } from '@deepseek-ai/cordis';
import { FixtureReadRuntime, type FixtureReadBackends, type FixtureReadRuntimeOptions } from '../service/fixture-read-runtime.js';
import { installScopeLifecycle } from './scope-lifecycle.js';
import type { HostServices } from './scope-registry.js';

/** Internal opt-in factory, not plugin activation or consent. Exact returned runtime is owned by this fiber. */
export function installFixtureReadRuntime(ctx: Context, host: HostServices, backends: FixtureReadBackends,
  options: FixtureReadRuntimeOptions = {}): FixtureReadRuntime {
  ctx.fiber.assertActive();
  const runtime = new FixtureReadRuntime(host, backends, options);
  installScopeLifecycle(ctx, runtime, 'cu.fixtureReadLifecycle');
  return runtime;
}
