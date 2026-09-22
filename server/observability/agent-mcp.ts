/**
 * 面向 AI agent 的 MCP（Model Context Protocol）工具面。
 * Streamable HTTP 形态的零依赖实现：客户端 POST JSON-RPC 2.0，本服务以
 * application/json 应答（不做 SSE 推流，工具全是只读查询，无需服务端主动推送）。
 * 协议处理是纯函数，工具集由路由层注入（依赖各 store），便于单测。
 */

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

export type McpServerInfo = { name: string; version: string };

const JSON_RPC_VERSION = '2.0';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18']);
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
};

function isRequest(message: unknown): message is JsonRpcRequest {
  return !!message && typeof message === 'object' && !Array.isArray(message);
}

function errorResponse(id: unknown, code: number, message: string) {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

function textResult(id: unknown, value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { jsonrpc: JSON_RPC_VERSION, id, result: { content: [{ type: 'text', text }], isError: false } };
}

export async function handleMcpJsonRpc(
  message: unknown,
  tools: McpTool[],
  serverInfo: McpServerInfo,
): Promise<Record<string, unknown> | null> {
  if (!isRequest(message)) {
    return errorResponse(null, -32600, 'invalid json-rpc request');
  }
  const { id, method } = message;
  if (typeof method !== 'string') {
    return errorResponse(id ?? null, -32600, 'missing method');
  }
  // 通知（无 id）不产生应答；HTTP 层回 202。
  if (id === undefined || id === null) {
    return null;
  }
  const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION;
      return {
        jsonrpc: JSON_RPC_VERSION,
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        },
      };
    }
    case 'ping':
      return { jsonrpc: JSON_RPC_VERSION, id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: JSON_RPC_VERSION,
        id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return errorResponse(id, -32602, `unknown tool: ${name || '(empty)'}`);
      }
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      try {
        return textResult(id, await tool.handler(args));
      } catch (error) {
        const reason = String((error as Error)?.message ?? error);
        return {
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: { content: [{ type: 'text', text: `tool ${name} failed: ${reason}` }], isError: true },
        };
      }
    }
    default:
      return errorResponse(id, -32601, `method not found: ${method}`);
  }
}

function integerArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(args[key]));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function textArg(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = String(args[key] ?? '').trim();
  if (!value) return undefined;
  return value.slice(0, max);
}

type MetricsQueryDeps = {
  listSeries: (input: { limit: number }) => Promise<Array<{ metric: string; labels: unknown }>>;
  queryRanges: (input: {
    metric: string;
    fromMs?: number;
    toMs?: number;
    windowMinutes?: number;
    maxPoints: number;
  }) => Promise<Array<{ metric: string; labels: unknown; points: Array<{ ts: number; value: number }> }>>;
  queryLogs: (input: {
    service?: string;
    severityMin: number;
    fromMs: number;
    toMs: number;
    limit: number;
  }) => Promise<Array<Record<string, unknown>>>;
  metricCatalog: () => unknown;
  listDevices: () => Promise<Array<Record<string, unknown>>>;
  nlQuery: (question: string) => Promise<unknown>;
};

/** 组装只读工具集；io 依赖由路由层注入。 */
export function buildObservabilityMcpTools(io: MetricsQueryDeps, now: () => number = Date.now): McpTool[] {
  return [
    {
      name: 'list_metric_series',
      description: '列出平台内落库的全部指标序列（指标名 + 标签，含 service）。先看这个再决定查哪个指标。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => io.listSeries({ limit: 500 }),
    },
    {
      name: 'query_metric',
      description:
        '查询某指标的时间序列。默认最近 240 分钟；可用 minutes（5~20160）或 fromMs/toMs（跨度 ≤14 天）指定范围。',
      inputSchema: {
        type: 'object',
        properties: {
          metric: { type: 'string', description: '指标名，OTLP 指标带点号' },
          minutes: { type: 'integer', description: '回看窗口分钟数（可选）' },
          fromMs: { type: 'integer', description: '起始毫秒时间戳（与 toMs 成对使用，可选）' },
          toMs: { type: 'integer', description: '结束毫秒时间戳（可选）' },
          points: { type: 'integer', description: '聚合点数，默认 240（可选）' },
        },
        required: ['metric'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const metric = String(args.metric ?? '').trim();
        if (!metric || metric.length > 96) throw new Error('metric is required (≤96 chars)');
        const points = integerArg(args, 'points', 240, 20, 500);
        let fromMs: number | undefined;
        let toMs: number | undefined;
        let windowMinutes: number | undefined;
        if (args.fromMs != null || args.toMs != null) {
          toMs = integerArg(args, 'toMs', now(), 0, 8_64_000_000_000_000);
          fromMs = integerArg(args, 'fromMs', toMs - 240 * 60_000, 0, toMs);
          if (toMs - fromMs > 60 * 24 * 14 * 60_000) throw new Error('range span must be ≤ 14 days');
        } else {
          windowMinutes = integerArg(args, 'minutes', 240, 5, 60 * 24 * 14);
        }
        const series = await io.queryRanges({ metric, fromMs, toMs, windowMinutes, maxPoints: points });
        return { window: fromMs != null && toMs != null ? { fromMs, toMs } : { minutes: windowMinutes }, series };
      },
    },
    {
      name: 'query_logs',
      description: '检索低敏感白名单日志。可按 service 过滤、按 severityMin 提门槛（9=INFO+, 13=WARN+, 17=ERROR+）。',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'service.name 前缀匹配（可选）' },
          severityMin: { type: 'integer', description: '最低严重级别，默认 9（可选）' },
          minutes: { type: 'integer', description: '回看窗口分钟数，默认 240（可选）' },
          limit: { type: 'integer', description: '返回条数，默认 100 上限 500（可选）' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const to = now();
        const minutes = integerArg(args, 'minutes', 240, 5, 60 * 24 * 14);
        return io.queryLogs({
          service: textArg(args, 'service', 160),
          severityMin: integerArg(args, 'severityMin', 9, 1, 24),
          fromMs: to - minutes * 60_000,
          toMs: to,
          limit: integerArg(args, 'limit', 100, 1, 500),
        });
      },
    },
    {
      name: 'metric_catalog',
      description: '指标字典：每个指标的中文名、说明、标签与所属数据面（otlp/prometheus/pattern）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => io.metricCatalog(),
    },
    {
      name: 'list_devices',
      description: '列出已注册边缘设备：ID、在线状态、最近心跳、型号与固件。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => io.listDevices(),
    },
    {
      name: 'nl_query',
      description: '自然语言查指标：用一句中文描述想看的数据（如“最近1小时 checkout 请求量”），返回解析出的查询 spec。',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string', description: '中文问题' } },
        required: ['question'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const question = textArg(args, 'question', 500);
        if (!question) throw new Error('question is required');
        return io.nlQuery(question);
      },
    },
  ];
}
