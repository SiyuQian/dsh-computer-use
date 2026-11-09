import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';

export const name = 'computer-use';
export const inject = ['tools'];

const emptyRequest = z.strictObject({});

/** Register diagnostics only. Native capabilities remain unavailable until their gates pass. */
export function apply(ctx: Context): void {
  const status: ToolDefinition = {
    name: 'cu_status',
    description: 'Read plugin capability status. This development build cannot read or control applications. Pass an empty object. Do not include private data.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          stage: { type: 'string', const: 'foundation' },
          nativeControl: { type: 'boolean', const: false },
          privateData: { type: 'boolean', const: false },
          mode: { type: 'string', const: 'background' },
          platform: { type: 'string', enum: ['macos', 'unsupported'] },
        },
        required: ['stage', 'nativeControl', 'privateData', 'mode', 'platform'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (!emptyRequest.safeParse(args).success) {
        throw new Error('INVALID_REQUEST: cu_status accepts an empty object only.');
      }
      return {
        stage: 'foundation',
        nativeControl: false,
        privateData: false,
        mode: 'background',
        platform: process.platform === 'darwin' ? 'macos' : 'unsupported',
      };
    },
  };
  ctx.tools.register(status);
}
