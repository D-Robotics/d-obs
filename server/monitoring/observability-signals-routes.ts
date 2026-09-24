/** 观测信号域路由：平台内指标查询、日志查询、边缘设备、自定义面板、事故副驾模型研判、模型单价。 */
import { type Request, type Response, type Router } from 'express';
import {
  clientErrorCode,
  queryInteger,
  queryText,
  requireObservabilityAccess,
  requireOpsMutationGuard,
  resolveOpsActor,
} from './observability-route-kit.js';
import { recordOpsConfigurationAudit, getOpsIncident } from './observability-store.js';
import { buildIncidentCorrelation } from './incident-correlate.js';
import { queryLogs, logFacets } from '../observability/ai-ecosystem-logs-store.js';
import { queryMetricRanges, queryMetricSeries } from '../observability/ai-ecosystem-metrics-store.js';
import {
  invalidateDeviceTokenCache,
  listDevices,
  createDeviceCommand,
  listDeviceCommands,
  queryDeviceSamples,
  registerDevice,
  rotateDeviceToken,
  setDeviceStatus,
  DEVICE_ID_PATTERN,
} from './device-registry.js';
import { issueIngestToken, invalidateIngestTokenCache, listIngestTokens, revokeIngestToken, rotateIngestToken } from '../observability/ingest-token-store.js';
import { METRIC_CATALOG } from '../observability/metric-dictionary.js';
import { nlQuery } from '../observability/nl-query-service.js';
import {
  createBoard,
  deleteBoard,
  listBoards,
  normalizeBoardName,
  normalizeBoardPanel,
  normalizeBoardSpec,
  parseBoardTemplate,
  updateBoard,
  type BoardPanel,
  type BoardSpec,
} from './dashboard-boards-store.js';
import { analyzeIncidentEvidence, callGatewayChat, copilotModelEnabled, extractJson, resolveGatewayChatTarget } from '../observability/copilot-model.js';
import { scanRecentMetricAnomalies } from '../observability/metric-anomalies.js';
import { buildSelfTestLogPayload, buildSelfTestMetricPayload } from '../observability/selftest-metric.js';
import { ingestLogPayload, ingestMetricPayload } from '../observability/ai-ecosystem-routes.js';
import { parseGrafanaDashboard, toGrafanaDashboard } from './grafana-compat.js';
import { deleteLibraryPanel, listLibraryPanels, saveLibraryPanel } from './dashboard-library-store.js';
import { buildObservabilityMcpTools, handleMcpJsonRpc } from '../observability/agent-mcp.js';
import { listModelPrices, upsertModelPrice } from '../flywheel/model-prices-store.js';
import { loadQualityTrend } from '../public-api/public-observability-quality-trend.js';
export function registerSignalsRoutes(router: Router): void {
  // 平台内落库序列索引（metric + service），NL 查询与 MCP 工具共用。
  function buildSeriesIndex(series: Array<{ metric: string; labels: unknown }>): Array<{ metric: string; service: string }> {
    const indexMap = new Map<string, string>();
    for (const row of series) {
      const service = String((row.labels as Record<string, unknown> | null)?.service ?? '');
      const key = `${row.metric}\u0000${service}`;
      if (!indexMap.has(key)) indexMap.set(key, service);
    }
    return [...indexMap.entries()].map(([key, service]) => ({ metric: key.split('\u0000')[0], service }));
  }

  // 跨信号根因关联 v1：事故窗口内汇聚异常指标/错误日志/离线设备（REST 与 MCP 共用）。
  async function correlateIncidentByKey(alertKey: string) {
    const incident = await getOpsIncident(alertKey);
    if (!incident) return null;
    const firstSeenMs = Date.parse(incident.firstSeenAt);
    const fromMs = Number.isFinite(firstSeenMs) ? firstSeenMs : Date.now() - 3_600_000;
    const windowMinutes = Math.max(30, Math.min(60 * 24 * 14, Math.ceil((Date.now() - fromMs) / 60_000)));
    const [anomalies, logs, devices] = await Promise.all([
      scanRecentMetricAnomalies({ windowMinutes, threshold: 3.5 }).catch(() => []),
      queryLogs({ severityMin: 17, fromMs, toMs: Date.now(), limit: 20 }).catch(() => []),
      listDevices()
        .then((rows) => rows.filter((device) => device.status !== 'disabled' && !device.online))
        .catch(() => []),
    ]);
    const correlation = buildIncidentCorrelation({
      incident,
      anomalies,
      errorLogs: logs as Array<{ service?: string; severityText?: string; body?: string; timestampMs?: number }>,
      offlineDevices: devices.map((device) => ({ deviceId: device.deviceId, online: device.online, lastSeenAt: device.lastSeenAt })),
      nowMs: Date.now(),
    });
    return { incident, correlation };
  }

  // AI agent MCP 工具面（只读查询，工具集构建一次）。
  const mcpTools = buildObservabilityMcpTools({
    listSeries: async ({ limit }) => await queryMetricSeries({ limit }),
    queryRanges: async ({ metric, fromMs, toMs, windowMinutes, maxPoints }) => {
      const to = toMs ?? Date.now();
      const from = fromMs ?? to - (windowMinutes ?? 240) * 60_000;
      return queryMetricRanges({ metric, fromMs: from, toMs: to, maxPoints });
    },
    queryLogs: (input) => queryLogs(input),
    metricCatalog: () => METRIC_CATALOG,
    listDevices: () => listDevices(),
    nlQuery: async (question) => nlQuery(question, buildSeriesIndex(await queryMetricSeries({ limit: 300 }))),
    incidentCorrelate: (alertKey) => correlateIncidentByKey(alertKey),
  });

  // ---- 平台内指标查询（OTLP metrics 落库后的一等查询面，管理员只读） ----

  router.get(
    '/api/ops/observability/metrics/series',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const series = await queryMetricSeries({
          metric: queryText(query, 'metric', 96),
          limit: queryInteger(query, 'limit', 200, 1, 500),
        });
        res.json({ ok: true, series });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'metrics_query_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/metrics/query',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const windowMinutes = queryInteger(query, 'minutes', 240, 5, 60 * 24 * 14);
        // 绝对时间范围优先（看板自定义区间 / MCP 工具）；缺省回退"最近 N 分钟"。
        const to = queryInteger(query, 'toMs', Date.now(), 0, 8_640_000_000_000_000);
        const from = queryInteger(query, 'fromMs', to - windowMinutes * 60_000, 0, to);
        const spanMinutes = Math.round((to - from) / 60_000);
        if (spanMinutes < 5 || spanMinutes > 60 * 24 * 14) {
          res.status(400).json({ ok: false, error: 'invalid_time_range' });
          return;
        }
        const ranges = await queryMetricRanges({
          metric: queryText(query, 'metric', 96),
          fromMs: from,
          toMs: to,
          maxPoints: queryInteger(query, 'points', 240, 20, 500),
        });
        res.json({
          ok: true,
          window: { fromMs: from, toMs: to, minutes: spanMinutes },
          series: ranges,
        });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'metrics_query_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/metrics/anomalies',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const windowMinutes = queryInteger(query, 'minutes', 240, 30, 60 * 24 * 14);
        const threshold = Number(query.threshold);
        const anomalies = await scanRecentMetricAnomalies({
          windowMinutes,
          threshold: Number.isFinite(threshold) ? threshold : undefined,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, anomalies: anomalies.slice(0, 50), scanned: { windowMinutes } });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'metrics_query_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/incidents/:alertKey/correlate',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const result = await correlateIncidentByKey(String(req.params.alertKey ?? ''));
        if (!result) {
          res.status(404).json({ ok: false, error: 'incident_not_found' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, ...result });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'incident_correlate_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/logs/facets',
    requireObservabilityAccess,
    async (_req: Request, res: Response) => {
      try {
        const facets = await logFacets(Date.now() - 14 * 24 * 60 * 60_000);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, facets });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'logs_facets_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/logs',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const windowMinutes = queryInteger(query, 'minutes', 240, 5, 60 * 24 * 14);
        const to = Date.now();
        const rows = await queryLogs({
          service: queryText(query, 'service', 160),
          owner: queryText(query, 'owner', 160),
          severityMin: queryInteger(query, 'severityMin', 1, 1, 24),
          fromMs: to - windowMinutes * 60_000,
          toMs: to,
          limit: queryInteger(query, 'limit', 100, 1, 500),
        });
        res.json({ ok: true, logs: rows });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'logs_query_unavailable') });
      }
    },
  );

  // ---- 边缘设备面（注册 / 状态 / 样本查询；token 只在签发与轮换响应出现一次） ----

  // ---- 质量与反馈趋势（score/feedback 数据的运营侧消费者） ----

  router.get(
    '/api/ops/observability/quality/summary',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const trend = await loadQualityTrend(queryInteger(query, 'days', 30, 1, 90));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, trend });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'quality_summary_unavailable') });
      }
    },
  );

  router.get('/api/ops/observability/devices', requireObservabilityAccess, async (_req, res) => {
    try {
      const devices = await listDevices();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, devices, offlineMinutes: Number(process.env.RDK_DEVICE_OFFLINE_MINUTES ?? 5) });
    } catch (error) {
      res.status(503).json({ ok: false, error: clientErrorCode(error, 'device_store_unavailable') });
    }
  });

  router.post(
    '/api/ops/observability/devices',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const { device, token } = await registerDevice({
          deviceId: String(body.deviceId ?? ''),
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          tenantId: typeof body.tenantId === 'string' ? body.tenantId : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          labels: body.labels,
          createdBy: resolveOpsActor(req),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'device_register',
          summary: `注册边缘设备 ${device.deviceId}（租户 ${device.tenantId}）`,
        });
        invalidateDeviceTokenCache();
        res.status(201).json({ ok: true, device, token, tokenHeader: 'x-rdk-device-token' });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'invalid_device_id' || !DEVICE_ID_PATTERN.test(String(body.deviceId ?? ''))) {
          res.status(400).json({ ok: false, error: 'invalid_device_id' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'device_store_unavailable') });
      }
    },
  );

  router.post(
    '/api/ops/observability/devices/:deviceId/token',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const { device, token } = await rotateDeviceToken(String(req.params.deviceId ?? ''));
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'device_token_rotate',
          summary: `轮换边缘设备 ${device.deviceId} 的 token`,
        });
        invalidateDeviceTokenCache();
        res.json({ ok: true, device, token, tokenHeader: 'x-rdk-device-token' });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'device_not_found') {
          res.status(404).json({ ok: false, error: 'device_not_found' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'device_store_unavailable') });
      }
    },
  );

  router.post(
    '/api/ops/observability/devices/:deviceId/status',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const status = String((req.body as Record<string, unknown> | undefined)?.status ?? '');
      if (status !== 'active' && status !== 'disabled') {
        res.status(400).json({ ok: false, error: 'invalid_device_status' });
        return;
      }
      try {
        const device = await setDeviceStatus(String(req.params.deviceId ?? ''), status);
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'device_status',
          summary: `边缘设备 ${device.deviceId} 状态改为 ${status}`,
        });
        invalidateDeviceTokenCache();
        res.json({ ok: true, device });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'device_not_found') {
          res.status(404).json({ ok: false, error: 'device_not_found' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'device_store_unavailable') });
      }
    },
  );

  router.get('/api/ops/observability/ingest-tokens', requireObservabilityAccess, async (_req, res) => {
    try {
      const tokens = await listIngestTokens();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, tokens });
    } catch (error) {
      res.status(503).json({ ok: false, error: clientErrorCode(error, 'ingest_token_store_unavailable') });
    }
  });

  // ---- 指标字典与自然语言查询（免 PromQL 的查询入口） ----

  router.get('/api/ops/observability/metrics/catalog', requireObservabilityAccess, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, catalog: METRIC_CATALOG });
  });

  router.post(
    '/api/ops/observability/nl-query',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const question = typeof body.question === 'string' ? body.question : '';
      if (!question.trim()) {
        res.status(400).json({ ok: false, error: 'question_required' });
        return;
      }
      try {
        // 平台内落库序列索引（metric + service），让规则层与模型都能选到用户应用指标。
        const seriesIndex = buildSeriesIndex(await queryMetricSeries({ limit: 300 }));
        const result = await nlQuery(question, seriesIndex);
        res.json({ ok: true, ...result });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'nl_query_no_match' || message === 'nl_query_empty') {
          res.status(400).json({ ok: false, error: 'nl_query_no_match' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'nl_query_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/prom/query',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      const base = String(process.env.RDK_PROMETHEUS_QUERY_URL ?? '').trim().replace(/\/$/, '');
      if (!base) {
        res.status(501).json({ ok: false, error: 'prometheus_not_configured' });
        return;
      }
      const query = queryText(req.query as Record<string, unknown>, 'query', 2000) ?? '';
      if (!query || !/^[a-zA-Z0-9_{}()[\]|,!=<>+\-*/\s"'.:@]+$/.test(query)) {
        res.status(400).json({ ok: false, error: 'invalid_promql' });
        return;
      }
      const minutes = queryInteger(req.query as Record<string, unknown>, 'minutes', 240, 5, 20_160);
      const end = Date.now() / 1000;
      const start = end - minutes * 60;
      const step = Math.max(15, Math.ceil((minutes * 60) / 240));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const url = `${base}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start.toFixed(0)}&end=${end.toFixed(0)}&step=${step}`;
        const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) {
          res.status(502).json({ ok: false, error: 'prometheus_query_failed' });
          return;
        }
        const payload = await response.json() as {
          status?: string;
          data?: { result?: Array<{ metric?: Record<string, unknown>; values?: Array<[number, string]> }> };
        };
        const series = (payload.data?.result ?? []).slice(0, 24).map((row) => {
          const labels = { ...(row.metric ?? {}) };
          delete (labels as Record<string, unknown>).__name__;
          return {
            name: `${query.split('{')[0]}${Object.keys(labels).length ? ' ' + JSON.stringify(labels) : ''}`,
            points: (row.values ?? []).map(([ts, value]) => ({ ts: Math.trunc(ts * 1000), value: Number(value) })).filter((p) => Number.isFinite(p.value)),
          };
        }).filter((row) => row.points.length);
        res.json({ ok: true, promql: query, series });
      } catch {
        res.status(502).json({ ok: false, error: 'prometheus_unreachable' });
      } finally {
        clearTimeout(timer);
      }
    },
  );

  router.post(
    '/api/ops/observability/ingest-tokens',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const { record, token } = await issueIngestToken({
          subjectType: body.subjectType,
          subjectId: body.subjectId,
          displayName: body.displayName,
          labels: body.labels,
          createdBy: resolveOpsActor(req),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'ingest_token_issue',
          summary: `签发生态接入凭据 ${record.tokenId}（${record.subjectType}:${record.subjectId}）`,
        });
        invalidateIngestTokenCache();
        res.status(201).json({ ok: true, record, token, tokenHeader: 'authorization' });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'invalid_subject_type' || message === 'invalid_subject_id') {
          res.status(400).json({ ok: false, error: message });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'ingest_token_store_unavailable') });
      }
    },
  );

  router.post(
    '/api/ops/observability/ingest-tokens/:tokenId/rotate',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const { record, token } = await rotateIngestToken(String(req.params.tokenId ?? ''));
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'ingest_token_rotate',
          summary: `轮换生态接入凭据 ${record.tokenId}（${record.subjectType}:${record.subjectId}）`,
        });
        invalidateIngestTokenCache();
        res.json({ ok: true, record, token, tokenHeader: 'authorization' });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'ingest_token_not_found') {
          res.status(404).json({ ok: false, error: 'ingest_token_not_found' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'ingest_token_store_unavailable') });
      }
    },
  );

  router.post(
    '/api/ops/observability/ingest-tokens/:tokenId/revoke',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const record = await revokeIngestToken(String(req.params.tokenId ?? ''));
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'ingest_token_revoke',
          summary: `吊销生态接入凭据 ${record.tokenId}（${record.subjectType}:${record.subjectId}）`,
        });
        invalidateIngestTokenCache();
        res.json({ ok: true, record });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'ingest_token_not_found') {
          res.status(404).json({ ok: false, error: 'ingest_token_not_found' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'ingest_token_store_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/devices/:deviceId/samples',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const query = req.query as Record<string, unknown>;
        const windowMinutes = queryInteger(query, 'minutes', 240, 5, 60 * 24 * 14);
        const to = Date.now();
        const samples = await queryDeviceSamples(String(req.params.deviceId ?? ''), {
          fromMs: to - windowMinutes * 60_000,
          toMs: to,
          maxPoints: queryInteger(query, 'points', 240, 20, 500),
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, samples, window: { fromMs: to - windowMinutes * 60_000, toMs: to } });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'device_store_unavailable') });
      }
    },
  );

  // ---- 自定义看板（面板编组 + 时间维度 + 模板导入导出；按运营身份隔离） ----

  router.get('/api/ops/observability/boards', requireObservabilityAccess, async (req: Request, res: Response) => {
    try {
      const boards = await listBoards(resolveOpsActor(req));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, boards });
    } catch (error) {
      res.status(503).json({ ok: false, error: clientErrorCode(error, 'boards_unavailable') });
    }
  });

  router.post(
    '/api/ops/observability/boards',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = normalizeBoardName(body.name);
      let spec: BoardSpec | undefined;
      if (body.spec != null) {
        const parsed = normalizeBoardSpec(body.spec);
        if (!parsed) {
          res.status(400).json({ ok: false, error: 'invalid_board_spec' });
          return;
        }
        spec = parsed;
      }
      if (body.name != null && !name) {
        res.status(400).json({ ok: false, error: 'invalid_board_name' });
        return;
      }
      try {
        const board = await createBoard({
          owner: resolveOpsActor(req),
          name: name ?? '未命名看板',
          spec,
        });
        res.status(201).json({ ok: true, board });
      } catch (error) {
        if (String((error as Error)?.message ?? '') === 'too_many_boards') {
          res.status(400).json({ ok: false, error: 'too_many_boards' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'boards_unavailable') });
      }
    },
  );

  router.post(
    '/api/ops/observability/boards/import',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const template = (req.body as Record<string, unknown> | undefined)?.template;
      const parsed = parseBoardTemplate(template);
      if (!parsed) {
        // Grafana dashboard JSON 自动识别：panels[].type/targets 映射为 d-obs 面板。
        const grafana = parseGrafanaDashboard(template);
        if (!grafana) {
          res.status(400).json({ ok: false, error: 'invalid_board_template' });
          return;
        }
        try {
          const board = await createBoard({ owner: resolveOpsActor(req), name: grafana.name, spec: grafana.spec });
          res.status(201).json({ ok: true, board, source: 'grafana', mapped: grafana.mapped, skipped: grafana.skipped });
        } catch (error) {
          if (String((error as Error)?.message ?? '') === 'too_many_boards') {
            res.status(400).json({ ok: false, error: 'too_many_boards' });
            return;
          }
          res.status(503).json({ ok: false, error: clientErrorCode(error, 'boards_unavailable') });
        }
        return;
      }
      try {
        const board = await createBoard({
          owner: resolveOpsActor(req),
          name: parsed.name ?? '导入看板',
          spec: parsed.spec,
        });
        res.status(201).json({ ok: true, board });
      } catch (error) {
        if (String((error as Error)?.message ?? '') === 'too_many_boards') {
          res.status(400).json({ ok: false, error: 'too_many_boards' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'boards_unavailable') });
      }
    },
  );

  router.post(
    '/api/ops/observability/boards/from-nl',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const question = String(body.question ?? '').trim().slice(0, 500);
      if (!question) {
        res.status(400).json({ ok: false, error: 'question_required' });
        return;
      }
      try {
        const seriesIndex = buildSeriesIndex(await queryMetricSeries({ limit: 300 }));
        // 模型层优先：组织多指标看板；逐面板校验且必须命中落库序列，坏面板丢弃。
        let specJson: Record<string, unknown> | null = null;
        if (copilotModelEnabled()) {
          try {
            const target = await resolveGatewayChatTarget();
            if (target) {
              const listing = seriesIndex.map((entry) => `${entry.metric}（service=${entry.service || '—'}）`).join('\n');
              const content = await callGatewayChat(
                target,
                [
                  { role: 'system', content: '你是可观测平台的看板助手。根据中文描述把相关指标组织成一个看板，只能使用给定指标清单里的指标。只输出 JSON。' },
                  { role: 'user', content: `指标清单（每行：指标名（service=…））：\n${listing}\n\n需求：${question}\n\n输出 JSON：{"name":"看板名(≤20字)","panels":[{"title":"面板标题(≤20字)","metric":"清单中的指标名","chart":"line|bar|stat","windowMinutes":240}]}。面板 2~8 个；累计量用 line，当前水位/利用率用 stat，取值范围可见时也可用 bar。` },
                ],
                20_000,
              );
              specJson = extractJson(content);
            }
          } catch {
            specJson = null;
          }
        }
        let panels: BoardPanel[] = [];
        if (specJson && Array.isArray(specJson.panels)) {
          for (const raw of specJson.panels as unknown[]) {
            const panel = normalizeBoardPanel(raw);
            if (panel && seriesIndex.some((entry) => entry.metric === panel.metric)) panels.push(panel);
          }
        }
        // 规则层兜底：模型层没产出时，nlQuery 单指标也能成板。
        if (!panels.length) {
          const result = await nlQuery(question, seriesIndex) as { spec?: { metric?: string; windowMinutes?: number } };
          if (result.spec?.metric) {
            const panel = normalizeBoardPanel({
              title: question.slice(0, 40) || result.spec.metric,
              metric: result.spec.metric,
              windowMinutes: result.spec.windowMinutes ?? 240,
              chart: 'line',
              width: 2,
            });
            if (panel) panels = [panel];
          }
        }
        const spec = normalizeBoardSpec({ windowMinutes: 240, panels: panels.slice(0, 8) });
        if (!spec || !spec.panels.length) {
          res.status(400).json({ ok: false, error: 'nl_board_no_match' });
          return;
        }
        const board = await createBoard({
          owner: resolveOpsActor(req),
          name: normalizeBoardName(specJson?.name) ?? question.slice(0, 20) ?? 'AI 看板',
          spec,
        });
        res.status(201).json({ ok: true, board, source: specJson ? 'model' : 'rules' });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'nl_query_no_match' || message === 'nl_query_empty') {
          res.status(400).json({ ok: false, error: 'nl_board_no_match' });
          return;
        }
        if (message === 'too_many_boards') {
          res.status(400).json({ ok: false, error: 'too_many_boards' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'boards_unavailable') });
      }
    },
  );

  router.put(
    '/api/ops/observability/boards/:boardId',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { name?: string; spec?: BoardSpec } = {};
      if (body.name != null) {
        const name = normalizeBoardName(body.name);
        if (!name) {
          res.status(400).json({ ok: false, error: 'invalid_board_name' });
          return;
        }
        patch.name = name;
      }
      if (body.spec != null) {
        const spec = normalizeBoardSpec(body.spec);
        if (!spec) {
          res.status(400).json({ ok: false, error: 'invalid_board_spec' });
          return;
        }
        patch.spec = spec;
      }
      try {
        const board = await updateBoard(resolveOpsActor(req), String(req.params.boardId ?? ''), patch);
        if (!board) {
          res.status(404).json({ ok: false, error: 'board_not_found' });
          return;
        }
        res.json({ ok: true, board });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'boards_unavailable') });
      }
    },
  );

  router.delete(
    '/api/ops/observability/boards/:boardId',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const removed = await deleteBoard(resolveOpsActor(req), String(req.params.boardId ?? ''));
        if (!removed) {
          res.status(404).json({ ok: false, error: 'board_not_found' });
          return;
        }
        res.json({ ok: true });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'boards_unavailable') });
      }
    },
  );

  // ---- AI agent MCP 工具面（只读查询；Streamable HTTP / JSON-RPC 2.0，通知回 202） ----

  router.post('/api/ops/mcp', requireObservabilityAccess, async (req: Request, res: Response) => {
    const response = await handleMcpJsonRpc(req.body, mcpTools, { name: 'd-obs', version: '1.0.0' });
    if (!response) {
      res.status(202).end();
      return;
    }
    res.json(response);
  });

  // ---- 边缘设备下行命令（运营签发 / 清单；设备端凭 token 认领执行） ----

  router.post(
    '/api/ops/observability/devices/:deviceId/commands',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const deviceId = String(req.params.deviceId ?? '');
      if (!DEVICE_ID_PATTERN.test(deviceId)) {
        res.status(400).json({ ok: false, error: 'invalid_device_id' });
        return;
      }
      try {
        const command = await createDeviceCommand({
          deviceId,
          type: String(body.type ?? ''),
          payload: body.payload,
          createdBy: resolveOpsActor(req),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'device_command_issue',
          summary: `向设备 ${deviceId} 下发命令 ${command.type}`,
        });
        res.status(201).json({ ok: true, command });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'invalid_command_type' || message === 'invalid_command_payload') {
          res.status(400).json({ ok: false, error: message });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'device_store_unavailable') });
      }
    },
  );

  router.get(
    '/api/ops/observability/devices/:deviceId/commands',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const commands = await listDeviceCommands(String(req.params.deviceId ?? ''));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, commands });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'device_store_unavailable') });
      }
    },
  );

  // ---- 接入自检：走与真实接入方相同的 OTLP ingest 管线写一个测试点 ----

  router.post(
    '/api/ops/observability/selftest/metric',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const now = Date.now();
        const result = await ingestMetricPayload(buildSelfTestMetricPayload(now), {
          owner: `selftest:${resolveOpsActor(req)}`.slice(0, 120),
          keyId: 'selftest',
        });
        res.json({
          ok: result.valid && result.accepted > 0,
          accepted: result.accepted,
          rejected: result.rejected,
          metric: 'rdk.obs.selftest',
          note: '指标异步落库，约 5 秒后可在指标查询里看到',
        });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'metrics_query_unavailable') });
      }
    },
  );

  // Grafana 格式导出：以 Grafana 可直接导入的 dashboard JSON 返回当前看板。
  router.get(
    '/api/ops/observability/boards/:boardId/export/grafana',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const owner = resolveOpsActor(req);
        const board = (await listBoards(owner)).find((item) => item.id === String(req.params.boardId ?? ''));
        if (!board) {
          res.status(404).json({ ok: false, error: 'board_not_found' });
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(board.name)}.grafana.json"`);
        res.json(toGrafanaDashboard(board));
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'boards_unavailable') });
      }
    },
  );

  // ---- 库面板：跨看板复用的面板定义（v1 添加 = 副本，不做引用联动） ----

  router.get('/api/ops/observability/library/panels', requireObservabilityAccess, async (req: Request, res: Response) => {
    try {
      const panels = await listLibraryPanels(resolveOpsActor(req));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, panels });
    } catch (error) {
      res.status(503).json({ ok: false, error: clientErrorCode(error, 'library_unavailable') });
    }
  });

  router.post(
    '/api/ops/observability/library/panels',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const panel = normalizeBoardPanel(body.panel);
      if (!panel) {
        res.status(400).json({ ok: false, error: 'invalid_panel_spec' });
        return;
      }
      try {
        const record = await saveLibraryPanel({
          owner: resolveOpsActor(req),
          panel,
          id: typeof body.id === 'string' ? body.id : undefined,
        });
        // 链接式传播：更新已有库面板时，同步所有引用它的看板面板定义。
        let syncedBoards = 0;
        if (body.id && record) {
          const owner = resolveOpsActor(req);
          for (const board of await listBoards(owner)) {
            if (!board.spec.panels.some((p) => p.libraryId === record.id)) continue;
            const panels = board.spec.panels.map((p) =>
              p.libraryId === record.id
                ? { ...panel, libraryId: record.id }
                : p,
            );
            await updateBoard(owner, board.id, { spec: { ...board.spec, panels } });
            syncedBoards += 1;
          }
        }
        res.status(201).json({ ok: true, record, syncedBoards });
      } catch (error) {
        if (String((error as Error)?.message ?? '') === 'too_many_library_panels') {
          res.status(400).json({ ok: false, error: 'too_many_library_panels' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'library_unavailable') });
      }
    },
  );

  router.delete(
    '/api/ops/observability/library/panels/:panelId',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const removed = await deleteLibraryPanel(resolveOpsActor(req), String(req.params.panelId ?? ''));
        if (!removed) {
          res.status(404).json({ ok: false, error: 'library_panel_not_found' });
          return;
        }
        res.json({ ok: true });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'library_unavailable') });
      }
    },
  );

  router.post(
    '/api/ops/observability/selftest/log',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const result = await ingestLogPayload(buildSelfTestLogPayload(Date.now()), {
          owner: `selftest:${resolveOpsActor(req)}`.slice(0, 120),
          keyId: 'selftest',
        });
        res.json({
          ok: result.valid && result.accepted > 0,
          accepted: result.accepted,
          rejected: result.rejected,
          note: '日志异步落库，约 5 秒后可在日志查询中看到（最低级别选 INFO）',
        });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'logs_query_unavailable') });
      }
    },
  );

  // ---- 事故副驾模型研判（可选；未启用时客户端回落确定性证据引擎） ----

  router.get('/api/ops/observability/copilot/status', requireObservabilityAccess, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, modelEnabled: copilotModelEnabled() });
  });

  router.post(
    '/api/ops/observability/copilot/analysis',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const analysis = await analyzeIncidentEvidence({
          question: body.question,
          evidenceIndex: body.evidenceIndex,
          posture: body.posture,
          warning: body.warning,
        });
        res.json({ ok: true, analysis });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'copilot_no_evidence') {
          res.status(400).json({ ok: false, error: 'copilot_no_evidence' });
          return;
        }
        if (message === 'copilot_model_disabled') {
          res.status(403).json({ ok: false, error: 'copilot_model_disabled' });
          return;
        }
        res.status(503).json({ ok: false, error: 'copilot_model_unavailable', retryable: true });
      }
    },
  );

  // ---- 模型单价（token 成本归因） ----

  router.get('/api/ops/observability/model-prices', requireObservabilityAccess, async (_req, res) => {
    try {
      const prices = await listModelPrices();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, prices });
    } catch (error) {
      res.status(503).json({ ok: false, error: clientErrorCode(error, 'model_prices_unavailable') });
    }
  });

  router.put(
    '/api/ops/observability/model-prices/:model',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const inputPerM = Number(body.inputPerM);
      const outputPerM = Number(body.outputPerM);
      if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM) || inputPerM < 0 || outputPerM < 0) {
        res.status(400).json({ ok: false, error: 'invalid_model_price' });
        return;
      }
      try {
        const price = await upsertModelPrice({
          model: String(req.params.model ?? ''),
          inputPerM,
          outputPerM,
          currency: typeof body.currency === 'string' ? body.currency : undefined,
          updatedBy: resolveOpsActor(req),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'model_price_update',
          summary: `模型 ${price.model} 单价更新：输入 ${price.inputPerM} / 输出 ${price.outputPerM}（每百万 token，${price.currency}）`,
        });
        res.json({ ok: true, price });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'invalid_model') {
          res.status(400).json({ ok: false, error: 'invalid_model' });
          return;
        }
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'model_prices_unavailable') });
      }
    },
  );
}
