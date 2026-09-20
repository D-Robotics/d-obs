import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPackageDefinition,
  type Client,
  type ServiceDefinition,
  type ServiceClientConstructor,
} from '@grpc/grpc-js';
import {
  loadSync,
  type MessageTypeDefinition,
  type PackageDefinition,
} from '@grpc/proto-loader';

type Message = Record<string, unknown>;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const traceProtoPath = join(moduleDir, 'otlp-trace.proto');
const metricsProtoPath = join(moduleDir, 'otlp-metrics.proto');
const logsProtoPath = join(moduleDir, 'otlp-logs.proto');

const loaderOptions = {
  keepCase: false,
  longs: String,
  enums: Number,
  defaults: false,
  oneofs: true,
  bytes: Buffer,
} as const;

const tracePackageDefinition = loadSync(traceProtoPath, loaderOptions);
const metricsPackageDefinition = loadSync(metricsProtoPath, loaderOptions);
const logsPackageDefinition = loadSync(logsProtoPath, loaderOptions);

function messageDefinition(
  definition: PackageDefinition,
  name: string,
): MessageTypeDefinition<object, Message> {
  const value = definition[name];
  if (!value || !('deserialize' in value) || !('serialize' in value)) {
    throw new Error(`OTLP protobuf message definition missing: ${name}`);
  }
  return value as MessageTypeDefinition<object, Message>;
}

export const traceServiceDefinition = tracePackageDefinition[
  'opentelemetry.proto.collector.trace.v1.TraceService'
] as ServiceDefinition;
export const metricsServiceDefinition = metricsPackageDefinition[
  'opentelemetry.proto.collector.metrics.v1.MetricsService'
] as ServiceDefinition;

export const traceServiceClient = (
  loadPackageDefinition(tracePackageDefinition) as unknown as {
    opentelemetry: { proto: { collector: { trace: { v1: { TraceService: ServiceClientConstructor } } } } };
  }
).opentelemetry.proto.collector.trace.v1.TraceService;

export const metricsServiceClient = (
  loadPackageDefinition(metricsPackageDefinition) as unknown as {
    opentelemetry: { proto: { collector: { metrics: { v1: { MetricsService: ServiceClientConstructor } } } } };
  }
).opentelemetry.proto.collector.metrics.v1.MetricsService;

export const logsServiceDefinition = logsPackageDefinition[
  'opentelemetry.proto.collector.logs.v1.LogsService'
] as ServiceDefinition;

export const logsServiceClient = (
  loadPackageDefinition(logsPackageDefinition) as unknown as {
    opentelemetry: { proto: { collector: { logs: { v1: { LogsService: ServiceClientConstructor } } } } };
  }
).opentelemetry.proto.collector.logs.v1.LogsService;

const traceRequest = messageDefinition(
  tracePackageDefinition,
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
);
const metricsRequest = messageDefinition(
  metricsPackageDefinition,
  'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest',
);
const logsRequest = messageDefinition(
  logsPackageDefinition,
  'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest',
);

export function decodeTraceProtobuf(payload: Buffer): Message {
  return traceRequest.deserialize(payload);
}

export function decodeMetricsProtobuf(payload: Buffer): Message {
  return metricsRequest.deserialize(payload);
}

export function decodeLogsProtobuf(payload: Buffer): Message {
  return logsRequest.deserialize(payload);
}

export function encodeTraceProtobuf(value: Message): Buffer {
  return traceRequest.serialize(value);
}

export function encodeMetricsProtobuf(value: Message): Buffer {
  return metricsRequest.serialize(value);
}

export type OtlpGrpcClient = Client;
