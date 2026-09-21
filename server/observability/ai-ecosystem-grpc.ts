import {
  Server,
  ServerCredentials,
  status,
  type Metadata,
  type sendUnaryData,
  type ServerUnaryCall,
} from '@grpc/grpc-js';
import {
  ingestLogPayload,
  ingestMetricPayload,
  ingestTracePayload,
  principalFromGrpcMetadata,
  type OtlpIngestResult,
} from './ai-ecosystem-routes.js';
import {
  logsServiceDefinition,
  metricsServiceDefinition,
  traceServiceDefinition,
} from './ai-ecosystem-protobuf.js';

type JsonObject = Record<string, unknown>;
type OtlpResponse = { partialSuccess?: { rejectedSpans?: string; rejectedDataPoints?: string; rejectedLogRecords?: string; errorMessage?: string } };

function metadataValue(metadata: Metadata, key: string): string | Buffer | undefined {
  const value = metadata.get(key)[0];
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value;
  return undefined;
}

async function identityForCall(call: ServerUnaryCall<unknown, unknown>) {
  return await principalFromGrpcMetadata(
    metadataValue(call.metadata, 'authorization'),
    metadataValue(call.metadata, 'x-api-key')
      ?? metadataValue(call.metadata, 'api-key')
      ?? metadataValue(call.metadata, 'x-rdk-observability-token'),
  );
}

function responseForTrace(result: OtlpIngestResult): OtlpResponse {
  return {
    partialSuccess: {
      rejectedSpans: String(result.rejected),
      ...(result.rejected ? { errorMessage: 'Some spans were rejected by the low-sensitivity policy.' } : {}),
    },
  };
}

function grpcError(code: status, message: string): { code: status; message: string } {
  return { code, message };
}

async function exportTrace(
  call: ServerUnaryCall<JsonObject, OtlpResponse>,
  callback: sendUnaryData<OtlpResponse>,
): Promise<void> {
  const identity = await identityForCall(call);
  if (!identity) {
    callback(grpcError(status.UNAUTHENTICATED, 'invalid_observability_token'));
    return;
  }
  try {
    const result = await ingestTracePayload(call.request, identity);
    if (!result.valid) {
      callback(grpcError(status.INVALID_ARGUMENT, 'invalid_otlp_trace_payload'));
      return;
    }
    callback(null, responseForTrace(result));
  } catch {
    callback(grpcError(status.UNAVAILABLE, 'otlp_trace_ingest_unavailable'));
  }
}

async function exportMetrics(
  call: ServerUnaryCall<JsonObject, OtlpResponse>,
  callback: sendUnaryData<OtlpResponse>,
): Promise<void> {
  const identity = await identityForCall(call);
  if (!identity) {
    callback(grpcError(status.UNAUTHENTICATED, 'invalid_observability_token'));
    return;
  }
  try {
    const result = await ingestMetricPayload(call.request, identity);
    if (!result.valid) {
      callback(grpcError(status.INVALID_ARGUMENT, 'invalid_otlp_metric_payload'));
      return;
    }
    callback(null, {
      partialSuccess: {
        rejectedDataPoints: String(result.rejected),
        ...(result.rejected ? { errorMessage: 'Some metric points could not be persisted.' } : {}),
      },
    });
  } catch {
    callback(grpcError(status.UNAVAILABLE, 'otlp_metric_ingest_unavailable'));
  }
}

async function exportLogs(
  call: ServerUnaryCall<JsonObject, OtlpResponse>,
  callback: sendUnaryData<OtlpResponse>,
): Promise<void> {
  const identity = await identityForCall(call);
  if (!identity) {
    callback(grpcError(status.UNAUTHENTICATED, 'invalid_observability_token'));
    return;
  }
  try {
    const result = await ingestLogPayload(call.request, identity);
    if (!result.valid) {
      callback(grpcError(status.INVALID_ARGUMENT, 'invalid_otlp_log_payload'));
      return;
    }
    callback(null, {
      partialSuccess: {
        rejectedLogRecords: String(result.rejectedRecords),
        ...(result.rejectedRecords ? { errorMessage: 'Some log records were rejected by the low-sensitivity policy or storage limit.' } : {}),
      },
    });
  } catch {
    callback(grpcError(status.UNAVAILABLE, 'otlp_log_ingest_unavailable'));
  }
}

export type AiEcosystemGrpcRuntime = {
  server: Server;
  address: string;
};

export function startAiEcosystemGrpcServer(options: {
  host?: string;
  port: number;
}): Promise<AiEcosystemGrpcRuntime> {
  const host = options.host?.trim() || '127.0.0.1';
  const server = new Server();
  server.addService(traceServiceDefinition, { Export: exportTrace });
  server.addService(metricsServiceDefinition, { Export: exportMetrics });
  server.addService(logsServiceDefinition, { Export: exportLogs });
  return new Promise((resolve, reject) => {
    server.bindAsync(`${host}:${options.port}`, ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        server.forceShutdown();
        reject(error);
        return;
      }
      resolve({ server, address: `${host}:${port}` });
    });
  });
}

export function startConfiguredAiEcosystemGrpcServer(): Promise<AiEcosystemGrpcRuntime | null> {
  const rawPort = String(process.env.RDK_OTLP_GRPC_PORT ?? '').trim();
  if (!rawPort) return Promise.resolve(null);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return Promise.reject(new Error('RDK_OTLP_GRPC_PORT must be an integer between 0 and 65535'));
  }
  return startAiEcosystemGrpcServer({
    host: String(process.env.RDK_OTLP_GRPC_HOST ?? '127.0.0.1'),
    port,
  });
}
