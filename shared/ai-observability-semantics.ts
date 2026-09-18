/**
 * Low-sensitivity AI observability semantic mapping.
 *
 * The public trace store intentionally exposes a small canonical vocabulary so
 * OpenTelemetry, Phoenix/OpenInference and Langfuse exporters can converge on
 * the same dashboards without accepting prompts, completions, tool arguments,
 * URLs or credentials.
 */

export const AI_OBSERVABILITY_SCHEMA_VERSION = 'rdk.ai.observability.v1' as const;

export type AiObservabilityScalar = string | number | boolean;
export type AiObservabilitySpanKind = 'agent' | 'generation' | 'tool' | 'retrieval' | 'http' | 'approval' | 'custom';

export interface AiSemanticAttributes {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolName?: string;
  projectId?: string;
  service?: string;
  environment?: string;
  release?: string;
  sessionRef?: string;
  objectType?: string;
  objectId?: string;
  objectName?: string;
  objectVersion?: string;
  promptVersion?: string;
  outcome?: string;
  outcome_kind?: string;
  is_error?: boolean;
  'external.name'?: string;
  'external.kind'?: AiObservabilitySpanKind;
}

const TEXT_ALIASES: Partial<Record<keyof AiSemanticAttributes, readonly string[]>> = {
  model: ['model', 'gen_ai.request.model', 'gen_ai.response.model', 'llm.request.model', 'llm.response.model', 'llm.model_name'],
  provider: ['provider', 'gen_ai.system', 'gen_ai.provider.name', 'llm.system', 'llm.provider'],
  toolName: ['toolName', 'tool.name', 'gen_ai.tool.name', 'moss.tool.name', 'openinference.tool.name'],
  projectId: ['projectId', 'project.id', 'service.project_id'],
  service: ['service', 'service.name'],
  environment: ['environment', 'deployment.environment.name', 'deployment.environment'],
  release: ['release', 'service.version', 'deployment.version'],
  sessionRef: ['sessionRef', 'session.id', 'gen_ai.conversation.id', 'conversation.id'],
  objectType: ['objectType', 'rdk.object.type'],
  objectId: ['objectId', 'rdk.object.id'],
  objectName: ['objectName', 'rdk.object.name'],
  objectVersion: ['objectVersion', 'rdk.object.version'],
  promptVersion: ['promptVersion', 'gen_ai.prompt.version', 'llm.prompt.version'],
  outcome: ['outcome', 'moss.outcome'],
  outcome_kind: ['outcome_kind', 'moss.tool.outcome_kind'],
  'external.name': ['external.name'],
  'external.kind': ['external.kind'],
};

const NUMBER_ALIASES: Record<'inputTokens' | 'outputTokens', readonly string[]> = {
  inputTokens: ['inputTokens', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.usage.prompt_tokens', 'llm.token_count.prompt', 'llm.token_count.prompt_tokens'],
  outputTokens: ['outputTokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.usage.completion_tokens', 'llm.token_count.completion', 'llm.token_count.completion_tokens'],
};

function text(value: unknown, max = 160): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function scalar(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    return item.stringValue ?? item.boolValue ?? item.intValue ?? item.doubleValue ?? item.string_value ?? item.bool_value ?? item.int_value ?? item.double_value;
  }
  return value;
}

function firstValue(input: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = scalar(input[key]);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(scalar(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1_000_000_000, parsed)) : undefined;
}

/** Maps OTel/OpenInference/Langfuse aliases into the d-obs low-sensitivity vocabulary. */
export function normalizeAiSemanticAttributes(
  value: Record<string, unknown> = {},
  resource: Record<string, unknown> = {},
): AiSemanticAttributes {
  const merged = { ...resource, ...value };
  const result: AiSemanticAttributes = {};
  for (const key of Object.keys(TEXT_ALIASES) as Array<keyof AiSemanticAttributes>) {
    const aliases = TEXT_ALIASES[key];
    if (!aliases) continue;
    const resolved = text(firstValue(merged, aliases), key === 'sessionRef' ? 200 : 160);
    if (resolved) {
      if (key === 'external.kind') {
        const allowed: readonly AiObservabilitySpanKind[] = ['agent', 'generation', 'tool', 'retrieval', 'http', 'approval', 'custom'];
        if (allowed.includes(resolved as AiObservabilitySpanKind)) result[key] = resolved as never;
      } else {
        result[key] = resolved as never;
      }
    }
  }
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    const resolved = finiteNumber(firstValue(merged, NUMBER_ALIASES[key]));
    if (resolved !== undefined) result[key] = resolved;
  }
  const errorValue = firstValue(merged, ['is_error', 'error', 'gen_ai.error']);
  if (typeof errorValue === 'boolean') result.is_error = errorValue;
  else if (typeof errorValue === 'string' && ['true', '1', 'yes'].includes(errorValue.toLowerCase())) result.is_error = true;
  return result;
}

export function inferAiSpanKind(name: string, attributes: AiSemanticAttributes = {}): AiObservabilitySpanKind {
  const kind = text(attributes['external.kind'], 32);
  if (kind) return kind as AiObservabilitySpanKind;
  const operation = text((attributes as Record<string, unknown>)['gen_ai.operation.name'], 48).toLowerCase();
  const normalized = `${operation} ${name}`.toLowerCase();
  if (/approval|authorize|consent/.test(normalized)) return 'approval';
  if (/retriev|embedding|vector|search/.test(normalized)) return 'retrieval';
  if (/tool|function|mcp/.test(normalized) || attributes.toolName) return 'tool';
  if (/http|request|fetch|grpc/.test(normalized)) return 'http';
  if (/generation|chat|completion|llm|language|model|embedding/.test(normalized) || attributes.model) return 'generation';
  if (/agent|workflow|run|turn|chain/.test(normalized)) return 'agent';
  return 'custom';
}

/** OpenInference and Langfuse use a string enum for span kind. */
export function mapAiSpanKindHint(value: unknown): AiObservabilitySpanKind | undefined {
  const normalized = text(value, 40).toLowerCase();
  if (!normalized) return undefined;
  if (['llm', 'generation', 'chat', 'completion'].includes(normalized)) return 'generation';
  if (['tool', 'function'].includes(normalized)) return 'tool';
  if (['retriever', 'retrieval', 'embedding'].includes(normalized)) return 'retrieval';
  if (['agent', 'chain', 'workflow'].includes(normalized)) return 'agent';
  if (['guardrail', 'evaluator', 'approval'].includes(normalized)) return 'approval';
  return undefined;
}

export function resolveAiRunId(attributes: Record<string, unknown>, traceId: string): string {
  return text(firstValue(attributes, [
    'moss.run.id',
    'rdk.run.id',
    'run.id',
    'gen_ai.conversation.id',
    'conversation.id',
  ]), 200) || traceId;
}
