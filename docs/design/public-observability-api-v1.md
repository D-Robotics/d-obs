# Public Observability API v1

This document is the compatibility contract for the low-sensitivity public
run/trace API. The machine-readable capability document is available at
`GET /api/v1/ecosystem/capabilities` and currently reports
`rdk.ai.observability.capabilities.v2`.

The API is intentionally separate from the OTLP receiver. OTLP clients should
use `/v1/traces`, `/v1/metrics`, or `/v1/logs`; application code that needs a
run lifecycle, scores, evaluations, or feedback can use the endpoints below.

## Authentication and scope

Send `Authorization: Bearer <token>`. A configured
`RDK_PUBLIC_OBSERVABILITY_API_TOKEN` is the production credential. Registered
ingest tokens are also accepted and resolve to the same owner partition as the
OTLP receiver. Dynamic bearer identities are a development-only compatibility
mode and must be explicitly enabled with
`RDK_ALLOW_DYNAMIC_OBSERVABILITY_TOKENS=1` outside production.

The server never persists or returns the bearer value. Each credential maps to
an opaque owner partition; a credential cannot read another credential's runs.

## Endpoints

All successful responses use `{ "ok": true, "data": ... }` unless noted.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/observability/runs` | Create or idempotently replay a run |
| `POST` | `/api/v1/observability/runs/:runId/spans:batch` | Append a bounded batch of spans and optionally update run status |
| `GET` | `/api/v1/observability/runs` | List runs with filters and a bounded limit |
| `GET` | `/api/v1/observability/catalog` | List observed object/catalog dimensions |
| `GET` | `/api/v1/observability/objects` | List registered objects |
| `GET` | `/api/v1/observability/objects/:objectId` | Read one object summary |
| `PATCH` | `/api/v1/observability/objects/:objectId` | Update low-sensitivity object labels/profile |
| `GET` | `/api/v1/observability/summary` | Aggregate run, score, evaluation, and feedback summary |
| `GET` | `/api/v1/observability/runs/:runId` | Read one run |
| `GET` | `/api/v1/observability/runs/:runId/trace` | Read the bounded trace for a run |
| `POST` | `/api/v1/observability/runs/:runId/scores` | Record a score |
| `POST` | `/api/v1/observability/runs/:runId/evaluations` | Record an evaluator result |
| `GET` | `/api/v1/observability/runs/:runId/evaluations` | Read evaluator results |
| `POST` | `/api/v1/observability/runs/:runId/feedback` | Record low-sensitivity feedback |

## Run and span contract

Run creation requires `projectId`, `environment`, and `service`. Optional
identity fields include `team`, `objectType`, `objectId`, `objectVersion`,
`release`, and `sessionRef`. Metadata is scalar-only and allowlisted.

Span batches use schema `rdk.public.observability.span.v1`. A span has a
`name`, `startTime`, `endTime`, and optional `traceId`, `spanId`,
`parentSpanId`, `kind`, `status`, `statusMessage`, and scalar attributes.
Allowed kinds are `agent`, `generation`, `tool`, `retrieval`, `http`,
`approval`, and `custom`.

The current limits are also exposed in the capabilities response:

- JSON/protobuf request body: 2 MiB;
- OTLP spans/metric points/log records per request: 512 each;
- Public API span batch: 64 spans;
- cumulative spans per run: 256, including the synthetic root span created at
  run creation;
- trace reads: 256 spans;
- run list reads: 200 records;
- log body: 1,000 characters.

The cumulative run limit is enforced by the store. Replaying a span with the
same `traceId:spanId` does not consume another slot. A batch that would add
spans beyond the limit is rejected atomically and does not partially append.

## Idempotency and retries

Set `Idempotency-Key` when creating a run if the caller may retry. The response
contains `Idempotent-Replayed: true` for a replay. The shared TypeScript SDK
retries GET/HEAD, `:batch` append, and requests carrying an idempotency key;
it uses bounded exponential backoff with jitter and honors `Retry-After`.

Callers should treat run and span IDs as stable correlation keys and avoid
retrying a non-idempotent score, evaluation, or feedback write unless the
caller supplies its own deduplication boundary.

## Error contract

Non-OTLP HTTP endpoints return:

```json
{
  "ok": false,
  "error": "stable_machine_code",
  "code": "stable_machine_code",
  "retryable": false,
  "details": {}
}
```

`details` is optional and contains bounded, non-sensitive values. Clients
should branch on `code`, not on human-readable text.

| HTTP | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_request_body`, `invalid_*` | Request does not satisfy the contract |
| `401` | `invalid_observability_token` | Missing or invalid credential |
| `404` | `observability_run_not_found`, `observability_object_not_found` | Resource is not visible in this owner scope |
| `409` | `observability_run_conflict` | Run ID belongs to another owner |
| `429` | `observability_run_span_quota_exceeded` | Cumulative run span budget is exhausted; `retryable=false` |
| `500` | `observability_api_unavailable` | Unexpected server failure; response is retryable |

For the quota error, `details` contains `limit`, `current`, and `requested`.
The server rejects the complete append, so the caller can drop or split the
batch without having to reconcile a partial write.

OTLP endpoints retain the OpenTelemetry partial-success response shape. They
may return `rejectedSpans`, `rejectedDataPoints`, or `rejectedLogRecords` and
must not be interpreted using the public API envelope.

## Data and privacy boundary

Only low-sensitivity metadata is retained: model/provider, token counts,
service/environment/version, tool name, stable device/object references,
status, timing, and bounded scalar labels. Prompts, completions, tool
arguments/results, credentials, URL query strings, raw account identifiers,
and arbitrary payloads are not part of this contract.

## Compatibility rules

The `rdk.public.observability.span.v1` schema and endpoint paths are stable
within v1. Additive response fields are allowed. Existing fields, enum values,
error codes, privacy rules, and limit semantics must not be silently changed.
Breaking changes require a new path or schema version and a corresponding
capabilities entry. The capabilities endpoint is the source of truth for
which optional signals, evaluations, health endpoints, protocols, and limits
are enabled by a deployment.
