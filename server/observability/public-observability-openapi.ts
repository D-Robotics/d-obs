/**
 * Machine-readable contract for the public observability and OTLP surfaces.
 * Keep this document additive and versioned with the capabilities response so
 * external SDK generators do not need to scrape prose documentation.
 */
export const PUBLIC_OBSERVABILITY_OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'D-Obs Public Observability API',
    version: '1.0.0',
    description: 'Low-sensitivity run, trace, evaluation and OTLP ingestion contract.',
  },
  servers: [{ url: '/', description: 'Current D-Obs deployment' }],
  security: [{ bearerAuth: [] }],
  components: {
    parameters: {
      RunId: { name: 'runId', in: 'path', required: true, schema: { type: 'string', maxLength: 200 } },
      IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 256 } },
    },
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque-ingest-token' },
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
    },
    schemas: {
      Problem: {
        type: 'object',
        required: ['ok', 'code', 'retryable'],
        properties: {
          ok: { const: false },
          error: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
          retryable: { type: 'boolean' },
          retryAfterSeconds: { type: 'integer', minimum: 0 },
          requestId: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
      SuccessEnvelope: {
        type: 'object',
        required: ['ok', 'data'],
        properties: { ok: { const: true }, data: {} },
      },
    },
  },
  paths: {
    '/api/v1/ecosystem/capabilities': {
      get: { operationId: 'getCapabilities', security: [], responses: { '200': { description: 'Deployment capabilities' } } },
    },
    '/api/v1/ecosystem/openapi.json': {
      get: { operationId: 'getOpenApiDocument', security: [], responses: { '200': { description: 'This OpenAPI document' } } },
    },
    '/v1/traces': {
      post: { operationId: 'ingestOtlpTraces', security: [{ bearerAuth: [] }, { apiKey: [] }], responses: { '200': { description: 'OTLP partial success response' }, '401': { description: 'Unauthorized' }, '429': { description: 'Rate limited' } } },
    },
    '/v1/metrics': {
      post: { operationId: 'ingestOtlpMetrics', security: [{ bearerAuth: [] }, { apiKey: [] }], responses: { '200': { description: 'OTLP partial success response' }, '401': { description: 'Unauthorized' }, '429': { description: 'Rate limited' } } },
    },
    '/v1/logs': {
      post: { operationId: 'ingestOtlpLogs', security: [{ bearerAuth: [] }, { apiKey: [] }], responses: { '200': { description: 'OTLP partial success response' }, '401': { description: 'Unauthorized' }, '429': { description: 'Rate limited' } } },
    },
    '/api/v1/observability/runs': {
      get: { operationId: 'listRuns', responses: { '200': { description: 'Runs in the current owner scope' }, '401': { description: 'Unauthorized' } } },
      post: { operationId: 'createRun', parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }], responses: { '200': { description: 'Created or replayed run' }, '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' } } },
    },
    '/api/v1/observability/catalog': {
      get: { operationId: 'getCatalog', responses: { '200': { description: 'Observed object and run dimensions' }, '401': { description: 'Unauthorized' } } },
    },
    '/api/v1/observability/objects': {
      get: { operationId: 'listObjects', responses: { '200': { description: 'Registered objects' }, '401': { description: 'Unauthorized' } } },
    },
    '/api/v1/observability/summary': {
      get: { operationId: 'getSummary', responses: { '200': { description: 'Run and quality summary' }, '401': { description: 'Unauthorized' } } },
    },
    '/api/v1/observability/objects/{objectId}': {
      get: { operationId: 'getObject', parameters: [{ name: 'objectId', in: 'path', required: true, schema: { type: 'string', maxLength: 200 } }], responses: { '200': { description: 'Object detail' }, '404': { description: 'Not found' } } },
      patch: { operationId: 'updateObject', parameters: [{ name: 'objectId', in: 'path', required: true, schema: { type: 'string', maxLength: 200 } }], responses: { '200': { description: 'Updated object profile' }, '400': { description: 'Invalid request' }, '404': { description: 'Not found' } } },
    },
    '/api/v1/observability/runs/{runId}': {
      get: { operationId: 'getRun', parameters: [{ $ref: '#/components/parameters/RunId' }], responses: { '200': { description: 'Run detail' }, '404': { description: 'Not found' } } },
    },
    '/api/v1/observability/runs/{runId}/trace': {
      get: { operationId: 'getTrace', parameters: [{ $ref: '#/components/parameters/RunId' }], responses: { '200': { description: 'Bounded trace spans' }, '404': { description: 'Not found' } } },
    },
    '/api/v1/observability/runs/{runId}/spans:batch': {
      post: { operationId: 'appendSpans', parameters: [{ $ref: '#/components/parameters/RunId' }, { $ref: '#/components/parameters/IdempotencyKey' }], responses: { '200': { description: 'Accepted span batch' }, '400': { description: 'Invalid request' }, '409': { description: 'Run conflict' }, '429': { description: 'Cumulative span quota exceeded' } } },
    },
    '/api/v1/observability/runs/{runId}/evaluations': {
      get: { operationId: 'listEvaluations', parameters: [{ $ref: '#/components/parameters/RunId' }], responses: { '200': { description: 'Evaluation results' } } },
      post: { operationId: 'recordEvaluation', parameters: [{ $ref: '#/components/parameters/RunId' }], responses: { '200': { description: 'Recorded evaluation' }, '400': { description: 'Invalid request' } } },
    },
    '/api/v1/observability/runs/{runId}/scores': {
      post: { operationId: 'recordScore', parameters: [{ $ref: '#/components/parameters/RunId' }], responses: { '200': { description: 'Recorded score' }, '400': { description: 'Invalid request' } } },
    },
    '/api/v1/observability/runs/{runId}/feedback': {
      post: { operationId: 'recordFeedback', parameters: [{ $ref: '#/components/parameters/RunId' }], responses: { '200': { description: 'Recorded feedback' }, '400': { description: 'Invalid request' } } },
    },
  },
} as const;
