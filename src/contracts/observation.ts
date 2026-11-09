import { z } from 'zod';
import { appSchema, instant, opaqueId, parseContract, rectSchema } from './shared.js';

const elementFields = {
  handle: opaqueId,
  role: z.enum(['button', 'text-field', 'static-text', 'group', 'other']),
  name: z.string().max(256),
  enabled: z.boolean(),
  bounds: rectSchema.optional(),
  actions: z.array(z.enum(['press', 'set_value'])).max(2),
};
const publicElementSchema = z.discriminatedUnion('secure', [
  z.strictObject({ ...elementFields, secure: z.literal(true) }),
  z.strictObject({ ...elementFields, secure: z.literal(false), value: z.string().max(16_384).optional() }),
]);
const screenshotSchema = z.strictObject({
  artifactId: opaqueId,
  observationId: opaqueId,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  capturedAt: instant,
  windowFrame: rectSchema,
  transformVersion: z.literal(1),
  pixelToWindow: z.strictObject({
    scaleX: z.number().positive().finite(),
    scaleY: z.number().positive().finite(),
    offsetX: z.number().finite(),
    offsetY: z.number().finite(),
  }),
  coherent: z.boolean(),
});

export const observationSchema = z.strictObject({
  observationId: opaqueId,
  generation: opaqueId,
  observedAt: instant,
  expiresAt: instant,
  app: appSchema,
  window: z.strictObject({
    id: z.number().int().positive(),
    instance: opaqueId,
    frame: rectSchema,
  }),
  structureRevision: opaqueId,
  focusedHandle: opaqueId.optional(),
  elements: z.array(publicElementSchema).max(500),
  coverage: z.strictObject({ truncated: z.boolean(), reasons: z.array(z.enum(['node_limit', 'depth_limit', 'text_limit', 'unavailable'])).max(4) }),
  screenshot: screenshotSchema.optional(),
}).superRefine((observation, ctx) => {
  if (Date.parse(observation.expiresAt) <= Date.parse(observation.observedAt)) {
    ctx.addIssue({ code: 'custom', message: 'Expiry must follow observation.' });
  }
  if (new Set(observation.elements.map((element) => element.handle)).size !== observation.elements.length) {
    ctx.addIssue({ code: 'custom', message: 'Element handles must be unique.' });
  }
  if (observation.screenshot && observation.screenshot.observationId !== observation.observationId) {
    ctx.addIssue({ code: 'custom', message: 'Screenshot must belong to this observation.' });
  }
  const screenshot = observation.screenshot;
  if (screenshot?.coherent) {
    const frame = observation.window.frame;
    const capturedFrame = screenshot.windowFrame;
    const transform = screenshot.pixelToWindow;
    const sameFrame = frame.x === capturedFrame.x && frame.y === capturedFrame.y &&
      frame.width === capturedFrame.width && frame.height === capturedFrame.height;
    // Pixels map to window-local points. Positive offsets permit explicitly captured subregions.
    const withinWindow = transform.offsetX >= 0 && transform.offsetY >= 0 &&
      transform.offsetX + screenshot.width * transform.scaleX <= capturedFrame.width + 0.001 &&
      transform.offsetY + screenshot.height * transform.scaleY <= capturedFrame.height + 0.001;
    if (!sameFrame || !withinWindow) {
      ctx.addIssue({ code: 'custom', message: 'Coherent screenshot coordinates must remain within the observed window.' });
    }
  }
  if (observation.focusedHandle && !observation.elements.some((element) => element.handle === observation.focusedHandle)) {
    ctx.addIssue({ code: 'custom', message: 'Focused handle must occur in this observation.' });
  }
});

export type Observation = z.infer<typeof observationSchema>;
export function parseObservation(value: unknown): Observation {
  return parseContract(observationSchema, value);
}
