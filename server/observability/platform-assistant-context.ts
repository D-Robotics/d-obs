/** Page selections are references to investigate, never evidence or authority. */
import { z } from 'zod';

const text = (max: number) => z.string().max(max).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)).transform((value) => value.trim());
const stamp = z.string().datetime({ offset: true });
const schema = z.object({
  view: text(200).optional(),
  tenant: text(200).optional(),
  environment: z.enum(['production', 'staging', 'development', 'test']).optional(),
  timeWindow: z.object({ from: stamp.optional(), to: stamp.optional(), hours: z.number().int().min(1).max(336).optional() }).strict()
    .refine((value) => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to)).optional(),
  selection: z.object({
    incidentKey: text(200).optional(), runLocator: text(4_096).optional(), runRef: text(200).optional(),
    deviceId: text(200).optional(), boardId: text(200).optional(), datasetId: text(200).optional(), collectionTaskId: text(200).optional(),
  }).strict().optional(),
  filters: z.object({ query: text(200).optional(), status: text(80).optional() }).strict().optional(),
}).strict();

export type PlatformAssistantWorkContext = z.infer<typeof schema>;

export function validatePlatformAssistantContext(value: unknown): PlatformAssistantWorkContext {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('platform_assistant_invalid_context');
  return parsed.data;
}
