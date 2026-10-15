import { z } from 'zod';

export type JsonSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema; enum?: unknown[]; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; minItems?: number; maxItems?: number;
  description?: string; default?: unknown;
};
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,63})?$/).max(100);
const jsonRecord = z.record(z.unknown());
const schema = z.custom<JsonSchema>((v) => !!v && typeof v === 'object' && !Array.isArray(v));
export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(1), id, version, label: z.string().min(1).max(120), description: z.string().max(4000),
  dependencies: z.array(z.object({ id, version }).strict()).max(16).default([]),
  configSchema: schema.default({ type: 'object', properties: {}, additionalProperties: false }),
  tools: z.array(z.object({
    id, description: z.string().min(1).max(2000), inputSchema: schema,
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('platform'), operationId: z.string().max(300) }).strict(),
      z.object({ type: z.literal('mcp'), connectorId: id, toolName: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) }).strict(),
    ]), defaults: jsonRecord.optional(),
  }).strict()).max(32).default([]),
  dataSources: z.array(z.object({ id, toolId: id, args: jsonRecord.optional(), resultPath: z.string().max(200).optional() }).strict()).max(32).default([]),
  panels: z.array(z.object({ id, title: z.string().min(1).max(120), dataSourceId: id, kind: z.enum(['stat', 'table', 'line']),
    valuePath: z.string().max(200).optional(), unit: z.string().max(30).optional(),
    columns: z.array(z.object({ key: z.string().max(100), label: z.string().max(100) }).strict()).max(20).optional(),
  }).strict()).max(32).default([]),
  workflows: z.array(z.object({ id, title: z.string().min(1).max(120), steps: z.array(z.object({ toolId: id,
    args: jsonRecord.optional(), label: z.string().max(120).optional() }).strict()).min(1).max(16) }).strict()).max(16).default([]),
  prompts: z.array(z.object({ id, text: z.string().min(1).max(20000) }).strict()).max(16).default([]),
}).strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginPackage = { manifest: PluginManifest; config: Record<string, unknown> };
export type PluginPublication = PluginPackage & { publishedAt: string };
export type PluginDetail = {
  id: string; revision: number; enabled: boolean; draft: PluginPackage | null; published: PluginPublication | null;
  history: PluginPublication[]; createdAt: string; updatedAt: string;
};
export type PluginSummary = Omit<PluginDetail, 'draft' | 'published' | 'history'> & {
  label: string; description: string; version: string | null; draftVersion: string | null; hasDraft: boolean;
  tools: number; dataSources: number; panels: number; workflows: number;
};
export type PluginExecutionContext = {
  canExecutePlatform: (operationId: string) => boolean;
  executePlatform: (operationId: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  canExecuteMcp?: (connectorId: string, toolName: string) => boolean;
  executeMcp?: (connectorId: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal; timeoutMs?: number;
};
export type PluginReceipt = { id: string; startedAt: string; completedAt: string; durationMs: number; source: unknown };
export type PluginToolResult = { pluginId: string; version: string; toolId: string; data: unknown; receipt: PluginReceipt };
export type PluginQueryResult = PluginToolResult & { dataSourceId: string };
export type PluginWorkflowResult = { pluginId: string; version: string; workflowId: string;
  steps: (PluginToolResult & { label?: string })[]; receipt: PluginReceipt };

export class PluginError extends Error {
  constructor(public readonly code: string, public readonly status: number, message = code) {
    super(message); this.name = 'PluginError';
  }
}
