/**
 * 事故副驾的模型研判通道（可选，默认关闭）。
 *
 * 配置 RDK_COPILOT_MODEL_ENABLED=1 且模型池 admin 可用时，工作台可以把证据
 * 包（ref/kind/label 全部低敏字段）交给模型池主路由生成假设；模型只能引用
 * 传入的 ref（服务端逐条校验），不产生新证据、不执行动作。任何失败都让
 * 客户端回落确定性证据引擎，不影响只读调查。
 */
import {
  getGatewayConfigSummary,
  isGatewayAdminConfigured,
} from '../credits/gateway-admin-client.js';

export type CopilotEvidenceRef = { ref: string; kind: string; label: string };

export type CopilotModelAnalysis = {
  source: 'model';
  modelStatus: 'available';
  model: string;
  headline: string;
  executiveSummary: string;
  confidence: number;
  hypotheses: Array<{
    title: string;
    confidence: number;
    evidenceRefs: string[];
    falsificationTest?: string;
    missingEvidence?: string;
  }>;
  nextActions: Array<{
    priority: string;
    title: string;
    rationale: string;
    evidenceRefs: string[];
    requiresApproval: boolean;
  }>;
  doNotDo: string[];
  generatedAt: string;
  evidenceIndex: CopilotEvidenceRef[];
};

export function copilotModelEnabled(): boolean {
  return String(process.env.RDK_COPILOT_MODEL_ENABLED ?? '').trim() === '1'
    && isGatewayAdminConfigured();
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEvidenceIndex(value: unknown): CopilotEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  const result: CopilotEvidenceRef[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 64)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const ref = cleanText(row.ref, 200);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    result.push({ ref, kind: cleanText(row.kind, 32) || 'evidence', label: cleanText(row.label, 160) || ref });
  }
  return result;
}

async function resolveGatewayChatTarget(): Promise<{ baseUrl: string; model: string; apiKey: string } | null> {
  const config = await getGatewayConfigSummary();
  const mappings = config.modelMapping ?? {};
  const candidates = Object.values(mappings)
    .map((item) => item && item.baseUrl && item.model && item.apiKey
      ? { baseUrl: item.baseUrl, model: item.model, apiKey: item.apiKey }
      : null)
    .filter((item): item is { baseUrl: string; model: string; apiKey: string } => item !== null);
  return candidates[0] ?? null;
}

async function callGatewayChat(
  target: { baseUrl: string; model: string; apiKey: string },
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${target.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: target.model,
        messages,
        stream: false,
        temperature: 0.2,
        max_tokens: 1_200,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`gateway_http_${response.status}`);
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content !== 'string' || !content.trim()) throw new Error('gateway_empty_response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

function clampRefs(refs: unknown, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(refs)) return [];
  return [...new Set(
    refs
      .map((item) => cleanText(item, 200))
      .filter((item) => item && allowed.has(item)),
  )].slice(0, 8);
}

export async function analyzeIncidentEvidence(input: {
  question?: unknown;
  evidenceIndex?: unknown;
  posture?: unknown;
  warning?: unknown;
}): Promise<CopilotModelAnalysis> {
  if (!copilotModelEnabled()) throw new Error('copilot_model_disabled');
  const evidenceIndex = normalizeEvidenceIndex(input.evidenceIndex);
  if (!evidenceIndex.length) throw new Error('copilot_no_evidence');
  const allowedRefs = new Set(evidenceIndex.map((item) => item.ref));
  const question = cleanText(input.question, 600);
  const posture = input.posture && typeof input.posture === 'object' && !Array.isArray(input.posture)
    ? input.posture as Record<string, unknown>
    : {};
  const warning = Array.isArray(input.warning)
    ? input.warning.map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 6)
    : [];

  const target = await resolveGatewayChatTarget();
  if (!target) throw new Error('copilot_model_unavailable');

  const system = [
    '你是生产可观测平台的事故研判副驾。输入是一组低敏感证据（ref/类型/标签）与生产态势计数。',
    '严格要求：',
    '1. 只输出一个 JSON 对象，不要输出任何其他文字。',
    '2. JSON 字段：headline(<=80字), executiveSummary(<=240字), confidence(0-1),',
    'hypotheses:[{title,confidence(0-1),evidenceRefs,falsificationTest,missingEvidence}]（1-4 条）,',
    'nextActions:[{priority("P0"|"P1"|"P2"),title,rationale,evidenceRefs,requiresApproval}]（0-4 条）,',
    'doNotDo:[string]（安全边界）。',
    '3. evidenceRefs 只能从提供的证据 ref 列表中选取，禁止编造。',
    '4. nextActions 只允许只读调查或需要人工审批的建议，不得建议自动执行生产变更。',
    '5. 用简体中文。',
  ].join('\n');
  const user = JSON.stringify({
    question: question || null,
    posture: {
      openIncidents: Number(posture.openIncidents) || 0,
      criticalIncidents: Number(posture.criticalIncidents) || 0,
      aiErrors: Number(posture.aiErrors) || 0,
    },
    warning,
    evidence: evidenceIndex.map((item) => ({ ref: item.ref, kind: item.kind, label: item.label })),
  }, null, 1);

  let raw: string;
  try {
    raw = await callGatewayChat(target, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], 30_000);
  } catch {
    throw new Error('copilot_model_unavailable');
  }
  const parsed = extractJson(raw);
  if (!parsed) throw new Error('copilot_model_invalid_output');

  const clamp01 = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
  };
  const hypotheses = (Array.isArray(parsed.hypotheses) ? parsed.hypotheses : []).slice(0, 4)
    .map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return {
        title: cleanText(row.title, 160),
        confidence: clamp01(row.confidence),
        evidenceRefs: clampRefs(row.evidenceRefs, allowedRefs),
        falsificationTest: cleanText(row.falsificationTest, 400) || undefined,
        missingEvidence: cleanText(row.missingEvidence, 240) || undefined,
      };
    })
    .filter((item) => item.title && item.evidenceRefs.length);
  const nextActions = (Array.isArray(parsed.nextActions) ? parsed.nextActions : []).slice(0, 4)
    .map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      const priority = cleanText(row.priority, 2).toUpperCase();
      return {
        priority: PRIORITIES.has(priority) ? priority : 'P2',
        title: cleanText(row.title, 160),
        rationale: cleanText(row.rationale, 400),
        evidenceRefs: clampRefs(row.evidenceRefs, allowedRefs),
        requiresApproval: row.requiresApproval === true,
      };
    })
    .filter((item) => item.title);
  if (!hypotheses.length) throw new Error('copilot_model_invalid_output');

  return {
    source: 'model',
    modelStatus: 'available',
    model: cleanText(target.model, 96),
    headline: cleanText(parsed.headline, 80) || '模型研判已生成',
    executiveSummary: cleanText(parsed.executiveSummary, 240),
    confidence: clamp01(parsed.confidence),
    hypotheses,
    nextActions,
    doNotDo: (Array.isArray(parsed.doNotDo) ? parsed.doNotDo : [])
      .map((item) => cleanText(item, 200))
      .filter(Boolean)
      .slice(0, 5),
    generatedAt: new Date().toISOString(),
    evidenceIndex,
  };
}
