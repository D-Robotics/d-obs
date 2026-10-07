import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startAiEcosystemGrpcServer } from './ai-ecosystem-grpc.js';

test('production refuses non-loopback plaintext OTLP/gRPC', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRequireTls = process.env.RDK_OTLP_GRPC_REQUIRE_TLS;
  const previousCert = process.env.RDK_OTLP_GRPC_TLS_CERT_FILE;
  const previousKey = process.env.RDK_OTLP_GRPC_TLS_KEY_FILE;
  process.env.NODE_ENV = 'production';
  delete process.env.RDK_OTLP_GRPC_REQUIRE_TLS;
  delete process.env.RDK_OTLP_GRPC_TLS_CERT_FILE;
  delete process.env.RDK_OTLP_GRPC_TLS_KEY_FILE;
  try {
    await assert.rejects(
      startAiEcosystemGrpcServer({ host: '0.0.0.0', port: 0 }),
      /requires TLS certificate and key files/,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousRequireTls === undefined) delete process.env.RDK_OTLP_GRPC_REQUIRE_TLS;
    else process.env.RDK_OTLP_GRPC_REQUIRE_TLS = previousRequireTls;
    if (previousCert === undefined) delete process.env.RDK_OTLP_GRPC_TLS_CERT_FILE;
    else process.env.RDK_OTLP_GRPC_TLS_CERT_FILE = previousCert;
    if (previousKey === undefined) delete process.env.RDK_OTLP_GRPC_TLS_KEY_FILE;
    else process.env.RDK_OTLP_GRPC_TLS_KEY_FILE = previousKey;
  }
});
