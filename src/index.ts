import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registerFixtureTools } from './host-adapter/fixture-tools.js';

export const name = 'computer-use';
export const inject = ['tools'];

/** Host/user configuration only. The model can never enable control. Unknown keys are rejected. */
export const Config = z.strictObject({
  fixtureControl: z.boolean().default(false),
  showFixture: z.boolean().default(true),
}).default({ fixtureControl: false, showFixture: true });
export type Config = z.infer<typeof Config>;

const emptyRequest = z.strictObject({});
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Diagnostics always; fixture-only computer use only when explicitly enabled in plugin config. */
export function apply(ctx: Context, rawConfig?: unknown): void {
  const config = Config.parse(rawConfig ?? {});
  const fixture = config.fixtureControl;
  let controlState: () => 'ready' | 'stopped' | 'disabled' = () => 'disabled';
  const status: ToolDefinition = {
    name: 'cu_status',
    description: fixture
      ? 'Read plugin capability status. Computer use is limited to the plugin\'s own test fixture app. Pass an empty object.'
      : 'Read plugin capability status. This build cannot read or control applications. Pass an empty object. Do not include private data.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          stage: { type: 'string', enum: ['foundation', 'fixture'] },
          nativeControl: { oneOf: [{ type: 'boolean', const: false }, { type: 'string', const: 'fixture_only' }] },
          privateData: { type: 'boolean', const: false },
          mode: { type: 'string', const: 'background' },
          platform: { type: 'string', enum: ['macos', 'unsupported'] },
          control: { type: 'string', enum: ['ready', 'stopped', 'disabled'] },
        },
        required: ['stage', 'nativeControl', 'privateData', 'mode', 'platform'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec: ToolRunContext) {
      exec.signal.throwIfAborted();
      if (!emptyRequest.safeParse(args).success) throw new Error('INVALID_REQUEST: cu_status accepts an empty object only.');
      const enabled = fixture && process.platform === 'darwin';
      return {
        stage: enabled ? 'fixture' : 'foundation', nativeControl: enabled ? 'fixture_only' : false, privateData: false,
        mode: 'background', platform: process.platform === 'darwin' ? 'macos' : 'unsupported',
        ...(enabled ? { control: controlState() } : {}),
      };
    },
  };
  ctx.tools.register(status);
  if (fixture && process.platform === 'darwin') controlState = registerFixtureTools(ctx, repositoryRoot, { visible: config.showFixture });
}
