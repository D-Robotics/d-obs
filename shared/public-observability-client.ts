export const PUBLIC_OBSERVABILITY_SPAN_SCHEMA = 'rdk.public.observability.span.v1' as const;

export type PublicObservabilityRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type PublicObservabilitySpanKind = 'agent' | 'generation' | 'tool' | 'retrieval' | 'http' | 'approval' | 'custom';
export type PublicObservabilityScalar = string | number | boolean;
export type PublicObservabilitySource = 'client' | 'server';
export type PublicObservabilityTimestampInput = number | string | Date;

export interface PublicObservabilityObjectContext {
  team?: string;
  objectType?: string;
  objectId?: string;
  objectName?: string;
  objectVersion?: string;
}

export interface PublicObservabilityRunInput extends PublicObservabilityObjectContext {
  runId?: string;
  traceId?: string;
  projectId: string;
  environment: string;
  service: string;
  release?: string;
  name?: string;
  sessionRef?: string;
  metadata?: Record<string, PublicObservabilityScalar>;
  status?: PublicObservabilityRunStatus;
  idempotencyKey?: string;
}

export interface PublicObservabilitySpanInput {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  source?: PublicObservabilitySource;
  kind?: PublicObservabilitySpanKind;
  name: string;
  startTime: number;
  endTime: number;
  status?: 'ok' | 'error';
  statusMessage?: string;
  attributes?: Record<string, PublicObservabilityScalar>;
}

export interface PublicObservabilitySpanBatchInput {
  traceId?: string;
  source?: PublicObservabilitySource;
  status?: PublicObservabilityRunStatus;
  completedAt?: PublicObservabilityTimestampInput;
  spans: readonly PublicObservabilitySpanInput[];
  run?: Partial<PublicObservabilityRunInput>;
}

export interface PublicObservabilityScoreInput {
  name: string;
  value: number;
  dataType?: string;
  source?: string;
  comment?: string;
  evaluator?: string;
  dataset?: string;
  modelVersion?: string;
  promptVersion?: string;
  threshold?: number;
  metadata?: Record<string, PublicObservabilityScalar>;
}

export interface PublicObservabilityEvaluationInput {
  name: string;
  value: number;
  evaluator: string;
  dataset?: string;
  modelVersion?: string;
  promptVersion?: string;
  threshold?: number;
  metadata?: Record<string, PublicObservabilityScalar>;
}

export interface PublicObservabilityFeedbackInput {
  kind: 'up' | 'down';
  messageId?: string;
  comment?: string;
  userMessage?: string;
  assistantMessage?: string;
  timeline?: string;
}

export interface PublicObservabilityRunRecord {
  runId: string;
  traceId: string;
  team?: string;
  objectType?: string;
  objectId?: string;
  objectName?: string;
  objectVersion?: string;
  projectId: string;
  environment: string;
  service: string;
  release?: string;
  name?: string;
  sessionRef?: string;
  metadata: Record<string, PublicObservabilityScalar>;
  status: PublicObservabilityRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  firstSpanAt?: number;
  lastSpanAt?: number;
  spanCount: number;
  errorSpanCount: number;
  scoreCount: number;
  feedbackCount: number;
  evaluationCount: number;
  idempotencyKey?: string;
}

export interface PublicObservabilityCatalogObject {
  team?: string;
  objectType?: string;
  objectId: string;
  objectName?: string;
  versions: string[];
  runCount: number;
  errorRate: number | null;
  lastSeenAt: number;
  profile?: PublicObservabilityObjectProfile;
}

export interface PublicObservabilityObjectProfile {
  team?: string;
  objectType?: string;
  objectId: string;
  displayName?: string;
  ownerTeam?: string;
  description?: string;
  labels: string[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  updatedBy?: string;
}

export interface PublicObservabilityCatalog {
  generatedAt: number;
  runCount: number;
  teams: string[];
  objectTypes: string[];
  environments: string[];
  services: string[];
  objects: PublicObservabilityCatalogObject[];
}

/** Object-centred view used by team dashboards and incident drill-downs. */
export interface PublicObservabilityObjectDetail {
  object: PublicObservabilityCatalogObject & {
    firstSeenAt: number;
    environments: string[];
    services: string[];
    releases: string[];
    projects: string[];
  };
  summary: PublicObservabilitySummary;
  recentRuns: PublicObservabilityRunRecord[];
}

export interface PublicObservabilitySummaryQuery extends PublicObservabilityListRunsQuery {
  /** Defaults to the last 24 hours when from/to are omitted. */
  windowMinutes?: number;
}

export interface PublicObservabilityObjectUpdateInput {
  team: string;
  objectType: string;
  displayName?: string;
  ownerTeam?: string;
  description?: string;
  labels?: readonly string[];
  archived?: boolean;
}

export interface PublicObservabilityObjectListQuery extends PublicObservabilityListRunsQuery {
  q?: string;
  ownerTeam?: string;
  label?: string;
  archived?: boolean;
}

export interface PublicObservabilityObjectListResult {
  generatedAt: number;
  total: number;
  limit: number;
  objects: PublicObservabilityCatalogObject[];
}

export interface PublicObservabilityObservationSpanInput {
  name: string;
  kind?: PublicObservabilitySpanKind;
  source?: PublicObservabilitySource;
  parentSpanId?: string;
  attributes?: Record<string, PublicObservabilityScalar>;
}

export interface PublicObservabilityObservationContext {
  run: PublicObservabilityRunRecord;
  span<T>(input: PublicObservabilityObservationSpanInput, work: () => Promise<T> | T): Promise<T>;
  recordScore(input: PublicObservabilityScoreInput): Promise<PublicObservabilityScoreRecord>;
  recordEvaluation(input: PublicObservabilityEvaluationInput): Promise<PublicObservabilityEvaluationRecord>;
  recordFeedback(input: PublicObservabilityFeedbackInput): Promise<PublicObservabilityFeedbackRecord>;
}

export interface PublicObservabilityObservationResult<T> {
  run: PublicObservabilityRunRecord;
  result: T;
}

export interface PublicObservabilityObserveInput extends PublicObservabilityRunInput {
  operationName?: string;
  spanKind?: PublicObservabilitySpanKind;
  source?: PublicObservabilitySource;
}

export interface PublicObservabilitySummary {
  generatedAt: number;
  windowStart: number;
  windowEnd: number;
  traffic: {
    runCount: number;
    spanCount: number;
    averageSpansPerRun: number | null;
  };
  reliability: {
    completedRuns: number;
    failedRuns: number;
    cancelledRuns: number;
    runningRuns: number;
    successRate: number | null;
    errorRate: number | null;
    errorSpanRate: number | null;
  };
  latency: {
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  saturation: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    generationSpanCount: number;
    toolSpanCount: number;
  };
  quality: {
    scoreCount: number;
    averageScores: Record<string, number>;
    evaluationCount: number;
    averageEvaluations: Record<string, number>;
    evaluationPassRate: number | null;
    feedbackCount: number;
    positiveFeedbackRate: number | null;
  };
}

export interface PublicObservabilitySpanRecord {
  schema: typeof PUBLIC_OBSERVABILITY_SPAN_SCHEMA;
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  source: PublicObservabilitySource;
  kind: PublicObservabilitySpanKind;
  name: string;
  startTime: number;
  endTime: number;
  status: 'ok' | 'error';
  statusMessage?: string;
  attributes: Record<string, PublicObservabilityScalar>;
}

export interface PublicObservabilityScoreRecord {
  scoreId: string;
  runId: string;
  name: string;
  value: number;
  dataType: string;
  source: string;
  comment?: string;
  evaluator?: string;
  dataset?: string;
  modelVersion?: string;
  promptVersion?: string;
  threshold?: number;
  status?: 'passed' | 'failed' | 'unrated';
  metadata?: Record<string, PublicObservabilityScalar>;
  createdAt: number;
}

export interface PublicObservabilityEvaluationRecord {
  evaluationId: string;
  runId: string;
  name: string;
  value: number;
  evaluator: string;
  dataset?: string;
  modelVersion?: string;
  promptVersion?: string;
  threshold?: number;
  status: 'passed' | 'failed' | 'unrated';
  metadata: Record<string, PublicObservabilityScalar>;
  createdAt: number;
}

export interface PublicObservabilityFeedbackRecord {
  feedbackId: string;
  runId: string;
  kind: 'up' | 'down';
  messageId?: string;
  comment?: string;
  userMessage?: string;
  assistantMessage?: string;
  timeline?: string;
  createdAt: number;
}

export interface PublicObservabilityCreateRunResult {
  run: PublicObservabilityRunRecord;
  replayed: boolean;
}

export interface PublicObservabilityAppendSpansResult {
  run: PublicObservabilityRunRecord;
  spans: PublicObservabilitySpanRecord[];
  accepted: number;
}

export interface PublicObservabilityListRunsResult {
  runs: PublicObservabilityRunRecord[];
  limit: number;
}

export interface PublicObservabilityTraceResult {
  runId: string;
  trace: PublicObservabilitySpanRecord[];
  limit: number;
}

export interface PublicObservabilityListRunsQuery {
  team?: string;
  objectType?: string;
  objectId?: string;
  objectVersion?: string;
  projectId?: string;
  environment?: string;
  service?: string;
  status?: PublicObservabilityRunStatus;
  from?: PublicObservabilityTimestampInput;
  to?: PublicObservabilityTimestampInput;
  limit?: number;
}

/**
 * `HeadersInit` 的结构等价物：shared/ 同时被 web（DOM lib）与 server（ES2022 + node
 * types）两套 tsconfig 编译，不能直接引用 DOM 的 HeadersInit。
 */
type HeadersInitLike = [string, string][] | Record<string, string> | Headers;

export interface PublicObservabilityClientOptions {
  baseUrl: string;
  authorization: string | (() => string | Promise<string>);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 最大重试次数（不含首次请求）；仅对可重试且具备幂等语义的请求生效。 */
  maxRetries?: number;
  /** 重试退避基数，默认 250ms；会叠加少量随机抖动。 */
  retryBaseDelayMs?: number;
  headers?: HeadersInitLike;
}

export interface PublicObservabilityClient {
  readonly baseUrl: string;
  createRun(input: PublicObservabilityRunInput): Promise<PublicObservabilityCreateRunResult>;
  appendSpans(runId: string, input: PublicObservabilitySpanBatchInput): Promise<PublicObservabilityAppendSpansResult>;
  listRuns(query?: PublicObservabilityListRunsQuery): Promise<PublicObservabilityListRunsResult>;
  listCatalog(query?: Pick<PublicObservabilityListRunsQuery, 'team' | 'objectType' | 'projectId' | 'environment' | 'service'>): Promise<PublicObservabilityCatalog>;
  listObjects(query?: PublicObservabilityObjectListQuery): Promise<PublicObservabilityObjectListResult>;
  getSummary(query?: PublicObservabilitySummaryQuery): Promise<PublicObservabilitySummary>;
  getObject(objectId: string, query?: Omit<PublicObservabilitySummaryQuery, 'objectId'>): Promise<PublicObservabilityObjectDetail>;
  updateObject(objectId: string, input: PublicObservabilityObjectUpdateInput): Promise<PublicObservabilityObjectDetail>;
  getRun(runId: string): Promise<PublicObservabilityRunRecord>;
  getTrace(runId: string, options?: { limit?: number }): Promise<PublicObservabilityTraceResult>;
  getEvaluations(runId: string): Promise<PublicObservabilityEvaluationRecord[]>;
  recordScore(runId: string, input: PublicObservabilityScoreInput): Promise<PublicObservabilityScoreRecord>;
  recordEvaluation(runId: string, input: PublicObservabilityEvaluationInput): Promise<PublicObservabilityEvaluationRecord>;
  recordFeedback(runId: string, input: PublicObservabilityFeedbackInput): Promise<PublicObservabilityFeedbackRecord>;
  observeRun<T>(
    input: PublicObservabilityObserveInput,
    work: (context: PublicObservabilityObservationContext) => Promise<T> | T,
  ): Promise<PublicObservabilityObservationResult<T>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RUN_FIELDS = 24;
const MAX_SPANS_PER_BATCH = 64;

export class PublicObservabilityApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly safeForUser?: boolean;
  readonly details?: Record<string, unknown>;
  readonly url: string;
  readonly method: string;
  readonly retryAfterMs?: number;
  readonly responseBody?: string;
  readonly responseJson?: unknown;

  constructor(message: string, options: {
    status: number;
    code: string;
    url: string;
    method: string;
    retryAfterMs?: number;
    retryable?: boolean;
    safeForUser?: boolean;
    details?: Record<string, unknown>;
    responseBody?: string;
    responseJson?: unknown;
  }) {
    super(message);
    this.name = 'PublicObservabilityApiError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? options.status >= 500;
    this.safeForUser = options.safeForUser === true ? true : undefined;
    this.details = options.details;
    this.url = options.url;
    this.method = options.method;
    this.retryAfterMs = options.retryAfterMs;
    this.responseBody = options.responseBody;
    this.responseJson = options.responseJson;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, max = 256): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : '';
}

function normalizeBaseUrl(baseUrl: string): URL {
  const url = new URL(cleanText(baseUrl, 2_048));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Public observability baseUrl must use http or https.');
  }
  url.pathname = url.pathname.replace(/\/?$/, '/');
  return url;
}

function normalizeAuthorizationHeader(value: string): string {
  const text = cleanText(value, 4_096);
  if (!text) throw new Error('Public observability authorization is required.');
  if (/^[A-Za-z][A-Za-z0-9_-]*\s+/.test(text)) return text;
  return `Bearer ${text}`;
}

async function resolveAuthorizationHeader(
  authorization: PublicObservabilityClientOptions['authorization'],
): Promise<string> {
  const value = typeof authorization === 'function' ? await authorization() : authorization;
  return normalizeAuthorizationHeader(String(value ?? ''));
}

function asTimestamp(value: PublicObservabilityTimestampInput): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? String(value.getTime()) : '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.trunc(value)) : '';
  return cleanText(value, 64);
}

function finiteInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function finiteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return parsed;
}

function compactScalarMap(
  value: unknown,
  maxEntries = MAX_RUN_FIELDS,
): Record<string, PublicObservabilityScalar> | undefined {
  if (!isObject(value)) return undefined;
  const result: Record<string, PublicObservabilityScalar> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, maxEntries)) {
    const key = rawKey.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
    if (!key) continue;
    if (typeof rawValue === 'string') {
      const text = cleanText(rawValue, 1_000);
      if (text) result[key] = text;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      result[key] = rawValue;
    } else if (typeof rawValue === 'boolean') {
      result[key] = rawValue;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function compactStringList(value: unknown, maxEntries = 16, maxLength = 64): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => cleanText(item, maxLength))
      .filter(Boolean),
  )].slice(0, maxEntries);
  return result.length ? result : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    result[key] = rawValue;
  }
  return result;
}

function normalizeRunInput(input: Partial<PublicObservabilityRunInput>): Record<string, unknown> {
  return compactObject({
    ...(input.runId ? { runId: cleanText(input.runId, 200) } : {}),
    ...(input.traceId ? { traceId: cleanText(input.traceId, 64) } : {}),
    ...(input.team ? { team: cleanText(input.team, 120) } : {}),
    ...(input.objectType ? { objectType: cleanText(input.objectType, 120) } : {}),
    ...(input.objectId ? { objectId: cleanText(input.objectId, 200) } : {}),
    ...(input.objectName ? { objectName: cleanText(input.objectName, 160) } : {}),
    ...(input.objectVersion ? { objectVersion: cleanText(input.objectVersion, 120) } : {}),
    ...(input.projectId ? { projectId: cleanText(input.projectId, 160) } : {}),
    ...(input.environment ? { environment: cleanText(input.environment, 120) } : {}),
    ...(input.service ? { service: cleanText(input.service, 160) } : {}),
    ...(input.release ? { release: cleanText(input.release, 120) } : {}),
    ...(input.name ? { name: cleanText(input.name, 120) } : {}),
    ...(input.sessionRef ? { sessionRef: cleanText(input.sessionRef, 200) } : {}),
    ...(input.metadata ? { metadata: compactScalarMap(input.metadata) ?? {} } : {}),
    ...(input.status ? { status: input.status } : {}),
  });
}

function normalizeObjectUpdateInput(input: PublicObservabilityObjectUpdateInput): Record<string, unknown> {
  return compactObject({
    team: cleanText(input.team, 120),
    objectType: cleanText(input.objectType, 120),
    ...(input.displayName ? { displayName: cleanText(input.displayName, 160) } : {}),
    ...(input.ownerTeam ? { ownerTeam: cleanText(input.ownerTeam, 120) } : {}),
    ...(input.description ? { description: cleanText(input.description, 2_000) } : {}),
    ...(input.labels ? { labels: compactStringList(input.labels) ?? [] } : {}),
    ...(input.archived !== undefined ? { archived: Boolean(input.archived) } : {}),
  });
}

function randomHex(bytes: number): string {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    const chunk = new Uint8Array(bytes);
    crypto.getRandomValues(chunk);
    return [...chunk].map((part) => part.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

function normalizeSpanInput(input: PublicObservabilitySpanInput): Record<string, unknown> {
  const startTime = finiteNumber(input.startTime, 'span.startTime');
  const endTime = finiteNumber(input.endTime, 'span.endTime');
  if (endTime < startTime) {
    throw new Error('span.endTime must be greater than or equal to span.startTime.');
  }
  return compactObject({
    schema: PUBLIC_OBSERVABILITY_SPAN_SCHEMA,
    traceId: cleanText(input.traceId, 64),
    spanId: cleanText(input.spanId || randomHex(8), 16),
    ...(input.parentSpanId ? { parentSpanId: cleanText(input.parentSpanId, 16) } : {}),
    source: input.source ?? 'server',
    kind: input.kind ?? 'custom',
    name: cleanText(input.name, 80),
    startTime: Math.trunc(startTime),
    endTime: Math.trunc(endTime),
    status: input.status ?? 'ok',
    ...(input.statusMessage ? { statusMessage: cleanText(input.statusMessage, 160) } : {}),
    ...(input.attributes ? { attributes: compactScalarMap(input.attributes) ?? {} } : {}),
  });
}

function normalizeListQuery(query: PublicObservabilityListRunsQuery & { windowMinutes?: number }): Record<string, string> {
  const result: Record<string, string> = {};
  if (query.team) result.team = cleanText(query.team, 120);
  if (query.objectType) result.objectType = cleanText(query.objectType, 120);
  if (query.objectId) result.objectId = cleanText(query.objectId, 200);
  if (query.objectVersion) result.objectVersion = cleanText(query.objectVersion, 120);
  if (query.projectId) result.projectId = cleanText(query.projectId, 160);
  if (query.environment) result.environment = cleanText(query.environment, 120);
  if (query.service) result.service = cleanText(query.service, 160);
  if (query.status) result.status = query.status;
  if (query.from !== undefined) result.from = asTimestamp(query.from);
  if (query.to !== undefined) result.to = asTimestamp(query.to);
  if (query.limit !== undefined) {
    const limit = finiteInteger(query.limit);
    if (limit !== undefined) result.limit = String(limit);
  }
  if (query.windowMinutes !== undefined) {
    const windowMinutes = finiteInteger(query.windowMinutes);
    if (windowMinutes !== undefined) result.windowMinutes = String(windowMinutes);
  }
  return result;
}

function normalizeObjectListQuery(query: PublicObservabilityObjectListQuery & { windowMinutes?: number }): Record<string, string> {
  const result = normalizeListQuery(query);
  if (query.q) result.q = cleanText(query.q, 120);
  if (query.ownerTeam) result.ownerTeam = cleanText(query.ownerTeam, 120);
  if (query.label) result.label = cleanText(query.label, 64);
  if (query.archived !== undefined) result.archived = query.archived ? 'true' : 'false';
  return result;
}

function normalizeObservedSpanInput(
  input: PublicObservabilityObservationSpanInput,
  traceId: string,
  startTime: number,
  endTime: number,
  status: 'ok' | 'error',
  statusMessage?: string,
): PublicObservabilitySpanInput {
  return {
    traceId,
    ...(input.parentSpanId ? { parentSpanId: cleanText(input.parentSpanId, 16) } : {}),
    source: input.source ?? 'server',
    kind: input.kind ?? 'custom',
    name: cleanText(input.name, 80) || 'observability.step',
    startTime,
    endTime,
    status,
    ...(statusMessage ? { statusMessage: cleanText(statusMessage, 160) } : {}),
    ...(input.attributes ? { attributes: input.attributes } : {}),
  };
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  return JSON.parse(text) as unknown;
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (isObject(payload) && payload.ok === true && 'data' in payload) {
    return (payload.data as T);
  }
  return payload as T;
}

function parseErrorFields(payload: unknown): {
  code: string;
  message: string;
  retryable?: boolean;
  safeForUser?: boolean;
  details?: Record<string, unknown>;
} {
  if (!isObject(payload)) {
    return { code: 'PUBLIC_OBSERVABILITY_HTTP_ERROR', message: 'Request failed.' };
  }
  const code = cleanText(payload.code ?? payload.errorCode ?? payload.error, 128) || 'PUBLIC_OBSERVABILITY_HTTP_ERROR';
  const message = cleanText(payload.message ?? payload.error ?? payload.detail, 2_000) || 'Request failed.';
  const retryable = typeof payload.retryable === 'boolean' ? payload.retryable : undefined;
  const safeForUser = payload.safeForUser === true ? true : undefined;
  const details = isObject(payload.details) ? payload.details : undefined;
  return { code, message, retryable, safeForUser, details };
}

function retryAfterMsFromResponse(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.ceil(seconds * 1_000));
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(30_000, Math.max(0, date - Date.now()));
}

function timeoutPromise(ms: number): { signal?: AbortSignal; clear(): void } {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { clear() {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${Math.trunc(ms)}ms`)), ms);
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
    },
  };
}

export async function observePublicRun<T>(
  client: PublicObservabilityClient,
  input: PublicObservabilityObserveInput,
  work: (context: PublicObservabilityObservationContext) => Promise<T> | T,
): Promise<PublicObservabilityObservationResult<T>> {
  const { operationName, spanKind = 'agent', source = 'server', ...runInput } = input;
  const created = await client.createRun(runInput);
  const runStartAt = Date.now();
  const spanName = cleanText(operationName ?? runInput.name ?? created.run.name ?? created.run.objectName ?? created.run.runId, 80) || created.run.runId;
  const context: PublicObservabilityObservationContext = {
    run: created.run,
    span: async <U>(spanInput: PublicObservabilityObservationSpanInput, spanWork: () => Promise<U> | U): Promise<U> => {
      const spanStart = Date.now();
      try {
        const result = await spanWork();
        await client.appendSpans(created.run.runId, {
          traceId: created.run.traceId,
          source: spanInput.source ?? source,
          run: runInput,
          spans: [
            normalizeObservedSpanInput(
              spanInput,
              created.run.traceId,
              spanStart,
              Date.now(),
              'ok',
            ),
          ],
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await client.appendSpans(created.run.runId, {
            traceId: created.run.traceId,
            source: spanInput.source ?? source,
            run: runInput,
            spans: [
              normalizeObservedSpanInput(
                spanInput,
                created.run.traceId,
                spanStart,
                Date.now(),
                'error',
                message,
              ),
            ],
          });
        } catch {
          // best-effort span capture; preserve the original failure
        }
        throw error;
      }
    },
    recordScore: (score) => client.recordScore(created.run.runId, score),
    recordEvaluation: (evaluation) => client.recordEvaluation(created.run.runId, evaluation),
    recordFeedback: (feedback) => client.recordFeedback(created.run.runId, feedback),
  };
  try {
    const result = await work(context);
    const completedAt = Date.now();
    const finalized = await client.appendSpans(created.run.runId, {
      traceId: created.run.traceId,
      source,
      status: 'completed',
      completedAt,
      run: runInput,
      spans: [
        normalizeObservedSpanInput(
          {
            name: spanName,
            kind: spanKind,
            source,
          },
          created.run.traceId,
          runStartAt,
          completedAt,
          'ok',
        ),
      ],
    });
    return { run: finalized.run, result };
  } catch (error) {
    const failedAt = Date.now();
    try {
      await client.appendSpans(created.run.runId, {
        traceId: created.run.traceId,
        source,
        status: 'failed',
        completedAt: failedAt,
        run: runInput,
        spans: [
          normalizeObservedSpanInput(
            {
              name: spanName,
              kind: spanKind,
              source,
            },
            created.run.traceId,
            runStartAt,
            failedAt,
            'error',
            error instanceof Error ? error.message : String(error),
          ),
        ],
      });
    } catch {
      // best-effort finalization; preserve the original failure
    }
    throw error;
  }
}

export function createPublicObservabilityClient(options: PublicObservabilityClientOptions): PublicObservabilityClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl).toString();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this environment.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultHeaders = new Headers(options.headers ?? {});
  let client!: PublicObservabilityClient;

  async function requestJsonOnce<T>(
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: unknown; extraHeaders?: HeadersInitLike } = {},
  ): Promise<{ data: T; response: Response }> {
    const url = new URL(path.replace(/^\//, ''), baseUrl);
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value !== undefined && value !== '') url.searchParams.set(key, value);
      }
    }
    const headers = new Headers(defaultHeaders);
    headers.set('Authorization', await resolveAuthorizationHeader(options.authorization));
    headers.set('Accept', 'application/json');
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    if (init.extraHeaders) {
      const extra = new Headers(init.extraHeaders);
      extra.forEach((value, key) => headers.set(key, value));
    }
    const timeout = timeoutPromise(timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(timeout.signal ? { signal: timeout.signal } : {}),
      });
      const responseText = await response.text();
      let parsed: unknown = undefined;
      if (responseText) {
        try {
          parsed = parseJson(responseText);
        } catch {
          throw new PublicObservabilityApiError('The server returned a non-JSON response.', {
            status: response.status,
            code: 'PUBLIC_OBSERVABILITY_INVALID_RESPONSE',
            retryable: response.status >= 500,
            url: url.toString(),
            method,
            responseBody: responseText.slice(0, 8_192),
          });
        }
      }
      if (!response.ok) {
        const errorFields = parseErrorFields(parsed);
        throw new PublicObservabilityApiError(errorFields.message, {
          status: response.status,
          code: errorFields.code,
          retryable: errorFields.retryable ?? response.status >= 500,
          safeForUser: errorFields.safeForUser,
          details: errorFields.details,
          url: url.toString(),
          method,
          responseBody: responseText || undefined,
          responseJson: parsed,
          retryAfterMs: retryAfterMsFromResponse(response),
        });
      }
      const payload = unwrapEnvelope<T>(parsed);
      return {
        data: payload,
        response,
      };
    } catch (error) {
      if (error instanceof PublicObservabilityApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PublicObservabilityApiError(`Request timed out after ${Math.trunc(timeoutMs)}ms.`, {
          status: 0,
          code: 'PUBLIC_OBSERVABILITY_REQUEST_TIMEOUT',
          retryable: true,
          url: url.toString(),
          method,
        });
      }
      if (error instanceof Error && /fetch failed|networkerror|load failed/i.test(error.message)) {
        throw new PublicObservabilityApiError(error.message || 'Network error.', {
          status: 0,
          code: 'PUBLIC_OBSERVABILITY_NETWORK_ERROR',
          retryable: true,
          url: url.toString(),
          method,
        });
      }
      throw error;
    } finally {
      timeout.clear();
    }
  }

  async function requestJson<T>(
    method: string,
    path: string,
    init: { query?: Record<string, string>; body?: unknown; extraHeaders?: HeadersInitLike } = {},
  ): Promise<{ data: T; response: Response }> {
    const maxRetries = Math.max(0, Math.min(5, Math.trunc(options.maxRetries ?? 2)));
    const extraHeaders = init.extraHeaders ? new Headers(init.extraHeaders) : new Headers();
    const idempotent = method === 'GET'
      || method === 'HEAD'
      || path.includes(':batch')
      || extraHeaders.has('Idempotency-Key');
    let attempt = 0;
    while (true) {
      try {
        return await requestJsonOnce<T>(method, path, init);
      } catch (error) {
        const retryable = error instanceof PublicObservabilityApiError && error.retryable;
        if (!retryable || !idempotent || attempt >= maxRetries) throw error;
        const retryAfterMs = error instanceof PublicObservabilityApiError ? error.retryAfterMs ?? 0 : 0;
        const base = Math.max(10, Math.min(30_000, Math.trunc(options.retryBaseDelayMs ?? 250)));
        const exponential = Math.min(30_000, base * 2 ** attempt);
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.25)));
        const delayMs = Math.max(retryAfterMs, exponential + jitter);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        attempt += 1;
      }
    }
  }

  client = {
    baseUrl,
    async createRun(input: PublicObservabilityRunInput): Promise<PublicObservabilityCreateRunResult> {
      const { data, response } = await requestJson<PublicObservabilityCreateRunResult>(
        'POST',
        '/api/v1/observability/runs',
        {
          body: normalizeRunInput(input),
          extraHeaders: input.idempotencyKey ? { 'Idempotency-Key': cleanText(input.idempotencyKey, 256) } : undefined,
        },
      );
      return {
        ...data,
        replayed: response.headers.get('idempotent-replayed') === 'true' || response.status === 202,
      };
    },
    async appendSpans(runId: string, input: PublicObservabilitySpanBatchInput): Promise<PublicObservabilityAppendSpansResult> {
      const spans = input.spans.slice(0, MAX_SPANS_PER_BATCH).map((span) => normalizeSpanInput(span));
      const { data } = await requestJson<PublicObservabilityAppendSpansResult>(
        'POST',
        `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/spans:batch`,
        {
          body: compactObject({
            ...(input.traceId ? { traceId: cleanText(input.traceId, 64) } : {}),
            ...(input.source ? { source: input.source } : {}),
            ...(input.status ? { status: input.status } : {}),
            ...(input.completedAt !== undefined ? { completedAt: asTimestamp(input.completedAt) } : {}),
            ...(input.run ? { run: normalizeRunInput(input.run) } : {}),
            spans,
          }),
        },
      );
      return data;
    },
    async listRuns(query: PublicObservabilityListRunsQuery = {}): Promise<PublicObservabilityListRunsResult> {
      const { data } = await requestJson<PublicObservabilityListRunsResult>('GET', '/api/v1/observability/runs', {
        query: normalizeListQuery(query),
      });
      return data;
    },
    async listCatalog(query = {}): Promise<PublicObservabilityCatalog> {
      const { data } = await requestJson<PublicObservabilityCatalog>('GET', '/api/v1/observability/catalog', {
        query: normalizeListQuery(query),
      });
      return data;
    },
    async listObjects(query: PublicObservabilityObjectListQuery = {}): Promise<PublicObservabilityObjectListResult> {
      const { data } = await requestJson<PublicObservabilityObjectListResult>('GET', '/api/v1/observability/objects', {
        query: normalizeObjectListQuery(query),
      });
      return data;
    },
    async getSummary(query: PublicObservabilitySummaryQuery = {}): Promise<PublicObservabilitySummary> {
      const { data } = await requestJson<PublicObservabilitySummary>('GET', '/api/v1/observability/summary', {
        query: normalizeListQuery(query),
      });
      return data;
    },
    async getObject(objectId: string, query: Omit<PublicObservabilitySummaryQuery, 'objectId'> = {}): Promise<PublicObservabilityObjectDetail> {
      const normalizedObjectId = cleanText(objectId, 200);
      if (!normalizedObjectId) throw new Error('objectId is required.');
      const { data } = await requestJson<PublicObservabilityObjectDetail>(
        'GET',
        `/api/v1/observability/objects/${encodeURIComponent(normalizedObjectId)}`,
        { query: normalizeListQuery({ ...query, objectId: normalizedObjectId }) },
      );
      return data;
    },
    async updateObject(objectId: string, input: PublicObservabilityObjectUpdateInput): Promise<PublicObservabilityObjectDetail> {
      const normalizedObjectId = cleanText(objectId, 200);
      if (!normalizedObjectId) throw new Error('objectId is required.');
      const { data } = await requestJson<PublicObservabilityObjectDetail>(
        'PATCH',
        `/api/v1/observability/objects/${encodeURIComponent(normalizedObjectId)}`,
        {
          body: normalizeObjectUpdateInput(input),
        },
      );
      return data;
    },
    async getRun(runId: string): Promise<PublicObservabilityRunRecord> {
      const { data } = await requestJson<PublicObservabilityRunRecord>(
        'GET',
        `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}`,
      );
      return data;
    },
    async getTrace(runId: string, options: { limit?: number } = {}): Promise<PublicObservabilityTraceResult> {
      const limit = options.limit === undefined ? undefined : finiteInteger(options.limit);
      const { data } = await requestJson<PublicObservabilityTraceResult>(
        'GET',
        `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/trace`,
        {
          query: limit === undefined ? undefined : { limit: String(limit) },
        },
      );
      return data;
    },
    async getEvaluations(runId: string): Promise<PublicObservabilityEvaluationRecord[]> {
      const { data } = await requestJson<{ runId: string; evaluations: PublicObservabilityEvaluationRecord[] }>(
        'GET',
        `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/evaluations`,
      );
      return data.evaluations;
    },
    async recordScore(runId: string, input: PublicObservabilityScoreInput): Promise<PublicObservabilityScoreRecord> {
      const value = finiteNumber(input.value, 'score.value');
      const { data } = await requestJson<PublicObservabilityScoreRecord>(
        'POST',
        `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/scores`,
        {
          body: compactObject({
            name: cleanText(input.name, 120),
            value,
            ...(input.dataType ? { dataType: cleanText(input.dataType, 32) } : {}),
            ...(input.source ? { source: cleanText(input.source, 64) } : {}),
            ...(input.comment ? { comment: cleanText(input.comment, 1_000) } : {}),
            ...(input.evaluator ? { evaluator: cleanText(input.evaluator, 120) } : {}),
            ...(input.dataset ? { dataset: cleanText(input.dataset, 160) } : {}),
            ...(input.modelVersion ? { modelVersion: cleanText(input.modelVersion, 120) } : {}),
            ...(input.promptVersion ? { promptVersion: cleanText(input.promptVersion, 120) } : {}),
            ...(input.threshold !== undefined ? { threshold: finiteNumber(input.threshold, 'score.threshold') } : {}),
            ...(input.metadata ? { metadata: compactScalarMap(input.metadata, 8) } : {}),
          }),
        },
      );
      return data;
    },
    async recordEvaluation(runId: string, input: PublicObservabilityEvaluationInput): Promise<PublicObservabilityEvaluationRecord> {
      const value = finiteNumber(input.value, 'evaluation.value');
      if (!cleanText(input.evaluator, 120)) throw new Error('evaluation.evaluator is required.');
      const { data } = await requestJson<PublicObservabilityEvaluationRecord>(
        'POST',
        `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/evaluations`,
        {
          body: compactObject({
            name: cleanText(input.name, 120),
            value,
            evaluator: cleanText(input.evaluator, 120),
            ...(input.dataset ? { dataset: cleanText(input.dataset, 160) } : {}),
            ...(input.modelVersion ? { modelVersion: cleanText(input.modelVersion, 120) } : {}),
            ...(input.promptVersion ? { promptVersion: cleanText(input.promptVersion, 120) } : {}),
            ...(input.threshold !== undefined ? { threshold: finiteNumber(input.threshold, 'evaluation.threshold') } : {}),
            ...(input.metadata ? { metadata: compactScalarMap(input.metadata, 8) } : {}),
          }),
        },
      );
      return data;
    },
    async recordFeedback(runId: string, input: PublicObservabilityFeedbackInput): Promise<PublicObservabilityFeedbackRecord> {
      const { data } = await requestJson<PublicObservabilityFeedbackRecord>(
        'POST',
        `/api/v1/observability/runs/${encodeURIComponent(cleanText(runId, 200))}/feedback`,
        {
          body: compactObject({
            kind: input.kind,
            ...(input.messageId ? { messageId: cleanText(input.messageId, 160) } : {}),
            ...(input.comment ? { comment: cleanText(input.comment, 4_000) } : {}),
            ...(input.userMessage ? { userMessage: cleanText(input.userMessage, 12_000) } : {}),
            ...(input.assistantMessage ? { assistantMessage: cleanText(input.assistantMessage, 12_000) } : {}),
            ...(input.timeline ? { timeline: cleanText(input.timeline, 24_000) } : {}),
          }),
        },
      );
      return data;
    },
    async observeRun<T>(
      input: PublicObservabilityObserveInput,
      work: (context: PublicObservabilityObservationContext) => Promise<T> | T,
    ): Promise<PublicObservabilityObservationResult<T>> {
      return observePublicRun(client, input, work);
    },
  };
  return client;
}
