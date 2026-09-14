export const CLIENT_ERROR_TELEMETRY_SCHEMA = 'rdk.studio.client-error.v1' as const;

export const CLIENT_ERROR_SOURCES = [
  'window_error',
  'resource_error',
  'unhandled_rejection',
  'console_error',
  'react_boundary',
  'api_error',
  'agent_stream',
  'electron_main',
  'electron_renderer_gone',
  'electron_child_gone',
  'electron_load_failure',
] as const;

export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

export const CLIENT_ERROR_ENVIRONMENTS = ['production', 'development', 'test'] as const;
export type ClientErrorEnvironment = (typeof CLIENT_ERROR_ENVIRONMENTS)[number];

/**
 * 这些 API 失败描述的是 Studio/设备当前状态，不是客户端代码缺陷。
 * 客户端不应入队，服务端也不得持久化；设备状态应由设备在线态与专用诊断链路表达。
 */
export const CLIENT_ERROR_NON_ACTIONABLE_API_CODES = [
  'studio_backend_warming',
  'device_offline_cached',
  'device_offline_skip_ssh',
  'rdk_device_offline_cached',
  'device_command_failed',
  'device_command_timeout',
  'ssh_connect_failed',
  'ssh_connect_timeout',
  'local_bridge_offline',
  'local_bridge_command_timeout',
  'local_flash_bridge_offline',
  'local_flash_bridge_timeout',
] as const;

export interface ClientErrorTelemetryEvent {
  schema: typeof CLIENT_ERROR_TELEMETRY_SCHEMA;
  source: ClientErrorSource;
  occurredAt: string;
  message: string;
  errorName?: string;
  stack?: string;
  route?: string;
  release?: string;
  clientType?: string;
  environment?: ClientErrorEnvironment;
  status?: number;
  code?: string;
  fatal?: boolean;
  occurrences?: number;
}

export interface ClientErrorTelemetryBatch {
  events: ClientErrorTelemetryEvent[];
}
