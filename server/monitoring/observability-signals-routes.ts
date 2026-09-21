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
import { recordOpsConfigurationAudit } from './observability-store.js';
import { queryLogs } from '../observability/ai-ecosystem-logs-store.js';
import { queryMetricRanges, queryMetricSeries } from '../observability/ai-ecosystem-metrics-store.js';
import {
  invalidateDeviceTokenCache,
  listDevices,
  queryDeviceSamples,
  registerDevice,
  rotateDeviceToken,
  setDeviceStatus,
  DEVICE_ID_PATTERN,
} from './device-registry.js';
import { issueIngestToken, invalidateIngestTokenCache, listIngestTokens, revokeIngestToken, rotateIngestToken } from '../observability/ingest-token-store.js';
import { METRIC_CATALOG } from '../observability/metric-dictionary.js';
import { nlQuery } from '../observability/nl-query-service.js';
import { createPanel, deletePanel, listPanels, normalizePanelSpec } from './dashboard-panels-store.js';
import { analyzeIncidentEvidence, copilotModelEnabled } from '../observability/copilot-model.js';
import { listModelPrices, upsertModelPrice } from '../flywheel/model-prices-store.js';
import { loadQualityTrend } from '../public-api/public-observability-quality-trend.js';
export function registerSignalsRoutes(router: Router): void {
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
        const to = Date.now();
        const from = to - windowMinutes * 60_000;
        const ranges = await queryMetricRanges({
          metric: queryText(query, 'metric', 96),
          fromMs: from,
          toMs: to,
          maxPoints: queryInteger(query, 'points', 240, 20, 500),
        });
        res.json({
          ok: true,
          window: { fromMs: from, toMs: to, minutes: windowMinutes },
          series: ranges,
        });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'metrics_query_unavailable') });
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
        const series = await queryMetricSeries({ limit: 300 });
        const indexMap = new Map<string, string>();
        for (const row of series) {
          const service = String((row.labels as Record<string, unknown> | null)?.service ?? '');
          const key = `${row.metric}\u0000${service}`;
          if (!indexMap.has(key)) indexMap.set(key, service);
        }
        const seriesIndex = [...indexMap.entries()].map(([key, service]) => ({
          metric: key.split('\u0000')[0],
          service,
        }));
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

  // ---- 自定义面板（保存的指标查询；按运营身份隔离） ----

  router.get('/api/ops/observability/panels', requireObservabilityAccess, async (req: Request, res: Response) => {
    try {
      const panels = await listPanels(resolveOpsActor(req));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, panels });
    } catch (error) {
      res.status(503).json({ ok: false, error: clientErrorCode(error, 'panels_unavailable') });
    }
  });

  router.post(
    '/api/ops/observability/panels',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const spec = normalizePanelSpec(body.spec);
      const title = String(body.title ?? '').replace(/\0/g, '').trim().slice(0, 120);
      if (!spec || !title) {
        res.status(400).json({ ok: false, error: 'invalid_panel_spec' });
        return;
      }
      try {
        const panel = await createPanel({ owner: resolveOpsActor(req), title, spec });
        res.status(201).json({ ok: true, panel });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'panels_unavailable') });
      }
    },
  );

  router.delete(
    '/api/ops/observability/panels/:panelId',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const removed = await deletePanel(resolveOpsActor(req), String(req.params.panelId ?? ''));
        if (!removed) {
          res.status(404).json({ ok: false, error: 'panel_not_found' });
          return;
        }
        res.json({ ok: true });
      } catch (error) {
        res.status(503).json({ ok: false, error: clientErrorCode(error, 'panels_unavailable') });
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
