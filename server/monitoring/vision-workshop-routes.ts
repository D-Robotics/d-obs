import express, { type Request, type Response, type Router } from 'express';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { requireVisionWorkshopAccess, requireVisionWorkshopUploadAccess, visionWorkshopOwner, visionWorkshopDevices } from './vision-workshop-access.js';
import { requireOpsMutationGuard } from './observability-route-kit.js';
import { VisionWorkshopService, VisionWorkshopError, buildVisionHandbook, imageDimensions, visionWorkshopLimitsFromEnv, type VisionJsonObject, type VisionRawMetadata, type VisionRawSample, type VisionProcessedImage, type VisionCameraFrame, type VisionDeviceCapability, type VisionCapabilities } from './vision-workshop-service.js';
import { generateVisionIspCandidate, visionModelEnabled, type VisionModelInput, type VisionIspCandidate } from './vision-workshop-model.js';
import { analyzeVisionRaw } from './vision-workshop-raw.js';
import { compareVisionProcessedPng, analyzeVisionProcessedPng, analyzeVisionTargetChart, VisionQualityError } from './vision-workshop-quality.js';
import { VisionDeviceRegistry, VisionDeviceExecutionError, configuredVisionDevices, VISION_DEVICE_OPERATIONS, type VisionDeviceOperation, type VisionCameraControls, validateVisionControlValues } from './vision-workshop-device.js';
import { createVisionArchive, renderVisionHandbook, buildVisionAiDebugExport, buildVisionWorkshopDeliveryExport, type VisionArchiveEntry } from './vision-workshop-export.js';
import { renderVisionWorkshopPage } from './vision-workshop-page.js';
import { VisionAiDebugManager, type VisionAiDebugPlanner } from './vision-workshop-ai-debug.js';
import { buildVisionWorkshopReadiness } from './vision-workshop-readiness.js';
import { buildVisionCameraWorkflow, analyzeVisionCameraStreamEvidence } from './vision-workshop-workflow.js';
import { buildVisionWorkshopDelivery, visionAcceptancePlanInput, visionAcceptanceRecordInput } from './vision-workshop-delivery.js';
import { registerVisionPluginPackageRoutes } from './vision-workshop-packages.js';
import { VISION_KNOWLEDGE_CONTRACT, getVisionCameraKnowledge, searchVisionCameraKnowledge, summarizeVisionCameraKnowledge, visionKnowledgeReadiness } from './vision-workshop-knowledge.js';
import { registerPlatformOperations, buildPlatformMcpTools, executePlatformOperation, type PlatformOperationArguments } from './platform-operations.js';
import { registerVisionCalibrationRoutes, buildVisionCalibrationMcpTools, VISION_CALIBRATION_OPERATIONS } from './vision-workshop-calibration.js';
import { handleMcpJsonRpc, type McpTool } from '../observability/agent-mcp.js';

import { VISION_WORKSHOP_API, VISION_WORKSHOP_CONTRACT, VISION_WORKSHOP_MCP, VISION_WORKSHOP_OPERATIONS } from './vision-workshop-operations.js';
export { VISION_WORKSHOP_API, VISION_WORKSHOP_CONTRACT, VISION_WORKSHOP_MCP, VISION_WORKSHOP_OPERATIONS } from './vision-workshop-operations.js';
let configuredService: VisionWorkshopService | undefined;
export function getConfiguredVisionWorkshopService(): VisionWorkshopService {
  return configuredService ??= new VisionWorkshopService({ dataDir: process.env.RDK_VISION_STATE_DIR || path.join(homedir(), '.local', 'state', 'd-obs', 'vision-workshop'), ...visionWorkshopLimitsFromEnv() });
}
type Options = { getService?: () => VisionWorkshopService; getDevices?: () => VisionDeviceRegistry; modelEnabled?: () => boolean; generateCandidate?: (input: VisionModelInput) => Promise<VisionIspCandidate>; planDebug?: VisionAiDebugPlanner };
const shortText = z.string().trim().min(1).max(100);
const id = z.string().min(1).max(100);
const goalSchema = z.string().trim().min(1).max(2000);
const knowledgeQuery = z.object({ q: z.string().trim().max(160).optional(), board: z.string().trim().max(100).optional(), sensorModel: z.string().trim().max(100).optional() }).strict();
const knowledgeId = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/);
const streamAnalysisInput = z.object({ runIds: z.array(id).min(1).max(128).refine(values => new Set(values).size === values.length).optional(), expectedFps: z.number().finite().positive().max(1000).optional(), tolerancePercent: z.number().finite().min(0).max(100).optional(), minimumDurationSeconds: z.number().finite().positive().max(3600).optional() }).strict();
const streamAnalysisQuery = z.object({
  runIds: z.string().max(14000).transform(value => { try { return JSON.parse(value); } catch { return null; } }).pipe(streamAnalysisInput.shape.runIds.unwrap()).optional(),
  expectedFps: z.coerce.number().finite().positive().max(1000).optional(), tolerancePercent: z.coerce.number().finite().min(0).max(100).optional(), minimumDurationSeconds: z.coerce.number().finite().positive().max(3600).optional(),
}).strict();
const experimentInput = z.object({ title: z.string().trim().min(1).max(120), goal: goalSchema, board: shortText.optional(), sensorVendor: shortText.optional(), sensorModel: shortText.optional(), sdkVersion: shortText.optional(), cameraInterface: shortText.optional(), cameraMode: shortText.optional(), targetId: id.optional() }).strict();
const cameraIdentityFields = ['board', 'sensorVendor', 'sensorModel', 'sdkVersion', 'cameraInterface', 'cameraMode'] as const;
// Only these operations can leave device state unconfirmed; a failed read or a
// local storage rejection must not be reported as a possible pending ISP write.
const deviceWriteOperations = new Set<VisionDeviceOperation>(['apply_tuning', 'tuning_load', 'controls_set', 'calibration_apply', 'restore_tuning']);
const baselineInput = z.object({ config: z.record(z.unknown()), rules: z.array(z.object({ path: z.string().min(1).max(300), label: shortText, min: z.number().finite(), max: z.number().finite(), step: z.number().finite().positive().optional(), precision: z.enum(['float32', 'seconds-float32-us']).optional() }).strict()).min(1).max(128) }).strict();
const candidateInput = z.object({ goal: goalSchema.optional(), frameIds: z.array(id).min(1).max(16).refine(values => new Set(values).size === values.length).optional(), targetAnalysisFrameId: id.optional() }).strict();
const resultInput = z.object({ sampleId: id, candidateId: id.optional(), filename: z.string().max(200).optional(), mimeType: z.enum(['image/png', 'image/jpeg']).optional() }).strict();
const rawMetadataInput = z.object({ scene: z.string().trim().min(1).max(120), width: z.number().int(), height: z.number().int(), bitDepth: z.union([z.literal(8), z.literal(10), z.literal(12), z.literal(14), z.literal(16)]), bayer: z.enum(['RGGB', 'BGGR', 'GRBG', 'GBRG']), packing: z.enum(['unpacked16le', 'mipi-raw10', 'mipi-raw12']), stride: z.number().int(), blackLevel: z.number().int(), whiteLevel: z.number().int(), exposureUs: z.number().finite().optional(), gain: z.number().finite().optional() }).strict();

function failure(res: Response, error: unknown): void {
  if (error instanceof VisionWorkshopError) { res.status(error.status).json({ ok: false, error: error.code }); return; }
  if (error instanceof VisionQualityError) { res.status(error.status).json({ ok: false, error: error.code }); return; }
  if (error instanceof ZodError || (error instanceof Error && /^vision_(?:raw_invalid|baseline_invalid|patch_invalid)/.test(error.message))) { res.status(400).json({ ok: false, error: 'vision_invalid_request' }); return; }
  const code = error instanceof Error && /^vision_[a-z0-9_]+$/.test(error.message) ? error.message : 'vision_workshop_unavailable';
  res.status(503).json({ ok: false, error: code });
}
function metadataHeader(req: Request, key: string): Record<string, unknown> {
  const value = req.header(key);
  if (!value || value.length > 8000) throw new VisionWorkshopError('vision_upload_metadata_required', 'Upload metadata header is required');
  try {
    const data: unknown = JSON.parse(decodeURIComponent(value));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new VisionWorkshopError('vision_upload_metadata_invalid', 'Invalid upload metadata header'); }
}
function decodeBase64(value: unknown, maxBytes: number): Buffer {
  // A repeated four-character group can overflow V8's regexp stack for normal
  // 4K Raw payloads. Check the character set linearly and verify canonical form
  // after decoding instead.
  if (typeof value !== 'string' || !value.length || value.length % 4 || value.length > Math.ceil(maxBytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value)) throw new VisionWorkshopError('vision_invalid_file_encoding', 'Use canonical bounded base64');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > maxBytes || data.toString('base64') !== value) throw new VisionWorkshopError('vision_invalid_file_encoding', 'Use canonical bounded base64');
  return data;
}
function resultBytes(result: Record<string, unknown>, maxBytes: number): Buffer {
  const data = decodeBase64(result.contentBase64, maxBytes);
  if (typeof result.sha256 !== 'string' || createHash('sha256').update(data).digest('hex') !== result.sha256) throw new VisionWorkshopError('vision_device_artifact_hash_mismatch', 'Device artifact does not match its receipt', 502);
  return data;
}
function binaryResultType(data: Buffer): 'image/png' | 'image/jpeg' {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216) return 'image/jpeg';
  throw new VisionWorkshopError('vision_invalid_processed_image', 'Only PNG/JPEG images can be uploaded');
}
function safeReceipt(result: Record<string, unknown>): Record<string, unknown> {
  const receipt = { ...result }; delete receipt.contentBase64;
  if (receipt.vendorCandidate && typeof receipt.vendorCandidate === 'object' && !Array.isArray(receipt.vendorCandidate)) {
    const candidate = { ...receipt.vendorCandidate as Record<string, unknown> }; delete candidate.contentBase64;
    receipt.vendorCandidate = candidate;
  }
  return receipt;
}

function ledgerReceipt(result: Record<string, unknown>): Record<string, unknown> {
  const receipt=safeReceipt(result);
  const summarize=(value:unknown):unknown => value && typeof value==='object' && !Array.isArray(value)
    ? { sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'), fields:Object.keys(value as Record<string,unknown>),
        ...Object.fromEntries(['kind','snapshotId','layoutHash'].filter(key=>typeof (value as Record<string,unknown>)[key]==='string').map(key=>[key,(value as Record<string,unknown>)[key]])) }
    : value;
  if (receipt.config) receipt.config=summarize(receipt.config);
  if (receipt.baseline && typeof receipt.baseline==='object') {
    const baseline=receipt.baseline as Record<string,unknown>;
    receipt.baseline={ config:summarize(baseline.config), ruleCount:Array.isArray(baseline.rules)?baseline.rules.length:0 };
  }
  if (receipt.evidence && typeof receipt.evidence==='object' && !Array.isArray(receipt.evidence)) {
    const evidence={...receipt.evidence as Record<string,unknown>};
    if (evidence.config) evidence.config=summarize(evidence.config);
    receipt.evidence=evidence;
  }
  return receipt;
}

export function buildVisionWorkshopMcpTools(router: Router, req: Request, res: Response): McpTool[] {
  const base = buildPlatformMcpTools(router, req, res);
  const execute = async (operationId: string, input: PlatformOperationArguments) => {
    if (!(Object.hasOwn(VISION_WORKSHOP_OPERATIONS, operationId) || Object.hasOwn(VISION_CALIBRATION_OPERATIONS, operationId))) throw new Error('unknown_vision_operation');
    const result = await executePlatformOperation(router, req, res, operationId, input, { timeoutMs: 130_000 });
    if (!result.ok) throw new Error(`platform_http_${result.status}: ${JSON.stringify(result.data)}`);
    return result;
  };
  const experiment = { experimentId: id }; const experimentProperty = { experimentId: { type: 'string', minLength: 1, maxLength: 100 } };
  const alias = (name: string, description: string, suffix: string, schema: z.ZodType<Record<string, unknown>>, properties: Record<string, unknown>, required: string[], method: 'POST' | 'GET' = 'POST'): McpTool => ({
    name, description, inputSchema: { type: 'object', properties: { ...experimentProperty, ...properties }, required: ['experimentId', ...required], additionalProperties: false },
    handler: async (args) => {
      const parsed = schema.parse(args); const { experimentId, ...body } = parsed;
      const params: Record<string, string> = { id: String(experimentId) };
      if (suffix.includes(':runId')) { params.runId = String(body.runId); delete body.runId; }
      return execute(method + ' ' + VISION_WORKSHOP_API + '/experiments/:id' + suffix, { params, ...(method === 'GET' ? { query: body.includeRaw === undefined ? {} : { includeRaw: body.includeRaw ? '1' : '0' } } : { body }) });
    },
  });
  const opaque = { type: 'string', minLength: 1, maxLength: 100 };
  return [
    { name: 'vision_workshop_runtime_status', description: '读取真实视觉运行能力、匹配适配器与模型配置；配置存在不等于硬件或画质已验证。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async args => { z.object({}).strict().parse(args); return execute('GET ' + VISION_WORKSHOP_API + '/capabilities', {}); } },
    { name: 'vision_experiment_list', description: '列出当前身份实际相机实验，不创建或操作设备。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async args => { z.object({}).strict().parse(args); return execute('GET ' + VISION_WORKSHOP_API + '/experiments', {}); } },
    { name: 'vision_experiment_create', description: '创建当前身份相机实验；targetId只能选真实配置的服务端适配器，Sensor/板型/SDK/模式必须匹配。创建不点亮硬件。', inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, goal: { type: 'string', minLength: 1, maxLength: 2000 }, ...Object.fromEntries([...cameraIdentityFields, 'targetId'].map(field => [field, { type: 'string', minLength: 1, maxLength: 100 }])) }, required: ['title', 'goal'], additionalProperties: false }, handler: async args => execute('POST ' + VISION_WORKSHOP_API + '/experiments', { body: experimentInput.parse(args) }) },
    alias('vision_experiment_get', '读取当前身份真实实验、deviceRuns账本与参数版本；超时或断连后先读此账本，不重放写操作。', '', z.object({ ...experiment }).strict(), {}, [], 'GET'),
    alias('vision_tuning_baseline_import', '保存真实SDK基础参数及允许修改的现有数值字段；导入不证明配置已加载或原生ISP支持。', '/baseline', z.object({ ...experiment, ...baselineInput.shape }).strict(), { config: { type: 'object', additionalProperties: true }, rules: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 300 }, label: { type: 'string', minLength: 1, maxLength: 100 }, min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' }, precision: { type: 'string', enum: ['float32', 'seconds-float32-us'] } }, required: ['path', 'label', 'min', 'max'], additionalProperties: false } } }, ['config', 'rules']),
    alias('vision_camera_readiness', '只读查询本实验设备配置、保存的点亮/采图/SDK回读/标定/评价证据和恢复阻塞；不执行硬件，不把配置或历史回执当当前在线或画质通过。', '/readiness', z.object(experiment).strict(), {}, [], 'GET'),
    alias('vision_camera_workflow', '评估本实验从新型号资料与适配到点亮、ISP和交付的阶段及下一步原子能力。只读保存证据，恢复未确认优先阻止新调试，无驱动时形成适配缺口。', '/workflow', z.object(experiment).strict(), {}, [], 'GET'),
    { name: 'vision_camera_stream_analyze', description: '从本实验归档SDK帧号和时间证据分析分组连续性、重复帧与目标帧率偏差；不触发采集，不接收客户端帧样本，不把历史短窗口当当前或长期稳定。', inputSchema: { type: 'object', properties: { ...experimentProperty, runIds: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } }, expectedFps: { type: 'number', exclusiveMinimum: 0, maximum: 1000 }, tolerancePercent: { type: 'number', minimum: 0, maximum: 100 }, minimumDurationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600 } }, required: ['experimentId'], additionalProperties: false }, handler: async args => {
      const input = z.object({ ...experiment, ...streamAnalysisInput.shape }).strict().parse(args); const { experimentId, runIds, ...numbers } = input;
      const query = Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      if (runIds) query.runIds = JSON.stringify(runIds);
      return execute('GET ' + VISION_WORKSHOP_API + '/experiments/:id/stream-analysis', { params: { id: experimentId }, query });
    } },
    alias('vision_workshop_delivery', '读取交付缺失项、版本绑定的验收标准/记录和 tuning 可复用范围；不把导出成功或操作者录入当独立画质认证。', '/delivery', z.object(experiment).strict(), {}, [], 'GET'),
    alias('vision_delivery_target_select', '显式选择本实验的交付参数版本；不执行硬件、不代替验收。版本ID必须来自delivery.targets。', '/delivery-target', z.object({ ...experiment, targetId: id }).strict(), { targetId: opaque }, ['targetId']),
    { name: 'vision_acceptance_plan_save', description: '保存本实验的场景、照明与验收阈值；生成新标准版本，旧记录不会自动适用。', inputSchema: { type: 'object', properties: { ...experimentProperty, plan: { type: 'object', properties: { scene: { type: 'string' }, lighting: { type: 'string' }, criteria: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { enum: ['visual','measurement'] }, required: { type: 'boolean' }, unit: { type: 'string' }, operator: { enum: ['lte','gte','between'] }, minimum: { type: 'number' }, maximum: { type: 'number' }, method: { type: 'string' } }, required: ['id','label','kind','required'], additionalProperties: false } } }, required: ['scene','lighting','criteria'], additionalProperties: false } }, required: ['experimentId','plan'], additionalProperties: false }, handler: async args => { const input = z.object({ experimentId: id, plan: visionAcceptancePlanInput }).strict().parse(args); return execute('POST ' + VISION_WORKSHOP_API + '/experiments/:id/acceptance-plan', { params: { id: input.experimentId }, body: input.plan }); } },
    { name: 'vision_acceptance_record', description: '经明确授权记录操作者提供的测量/观察和真实图像；数值由服务器按保存阈值判断，不声明测量真实性、人工或第三方认证。', inputSchema: { type: 'object', properties: { ...experimentProperty, record: { type: 'object', properties: { planId: { type: 'string' }, candidateId: { type: 'string' }, imageIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } }, observations: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', properties: { criterionId: { type: 'string' }, value: { type: 'number' }, verdict: { enum: ['pass','fail'] }, notes: { type: 'string' } }, required: ['criterionId'], additionalProperties: false } }, report: { type: 'string' }, notes: { type: 'string' } }, required: ['planId','candidateId','imageIds','observations'], additionalProperties: false } }, required: ['experimentId','record'], additionalProperties: false }, handler: async args => { const input = z.object({ experimentId: id, record: visionAcceptanceRecordInput }).strict().parse(args); return execute('POST ' + VISION_WORKSHOP_API + '/experiments/:id/acceptance-records', { params: { id: input.experimentId }, body: input.record }); } },
    { name: 'vision_camera_knowledge_search', description: '检索相机点亮、RAW 与原生 ISP 调试的审定知识、来源和能力缺口；不执行设备操作，资料已核对不等于真机验证。', inputSchema: { type: 'object', properties: { q: { type: 'string', maxLength: 160 }, board: { type: 'string', maxLength: 100 }, sensorModel: { type: 'string', maxLength: 100 } }, additionalProperties: false }, handler: async args => execute('GET ' + VISION_WORKSHOP_API + '/knowledge', { query: knowledgeQuery.parse(args) }) },
    { name: 'vision_camera_knowledge_get', description: '读取相机知识的系统版本、接线、工具平台、原子操作前提和真实证据要求；适配器配置与硬件验收分开，写操作继续走实际实验契约。', inputSchema: { type: 'object', properties: { knowledgeId: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' } }, required: ['knowledgeId'], additionalProperties: false }, handler: async args => { const parsed = z.object({ knowledgeId }).strict().parse(args); return execute('GET ' + VISION_WORKSHOP_API + '/knowledge/:knowledgeId', { params: parsed }); } },
    { name: 'vision_workshop_capabilities', description: '发现视觉Workshop原子操作与参数；账户凭证由当前请求继承。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async (args) => { if (Object.keys(args).length) throw new Error('invalid_operation_arguments'); const catalog = await base[0].handler({ group: '视觉 Workshop' }) as { operations: Array<{ id: string }> }; return { operations: catalog.operations.filter(operation => Object.hasOwn(VISION_WORKSHOP_OPERATIONS, operation.id) || Object.hasOwn(VISION_CALIBRATION_OPERATIONS, operation.id)) }; } },
    { ...base[1], name: 'vision_workshop_execute', description: '执行视觉能力目录返回的operationId。读取、生成候选、SDK操作、评价、导出共用同一业务服务。禁止自造shell/地址或宣称候选已验证。', handler: async (args) => {
      if (typeof args.operationId !== 'string' || !(Object.hasOwn(VISION_WORKSHOP_OPERATIONS, args.operationId) || Object.hasOwn(VISION_CALIBRATION_OPERATIONS, args.operationId))) throw new Error('unknown_vision_operation');
      if (Object.keys(args).some((key) => !['operationId', 'params', 'query', 'body'].includes(key))) throw new Error('invalid_operation_arguments');
      const { operationId, ...input } = args;
      return execute(operationId, input as PlatformOperationArguments);
    } },
    alias('vision_ai_debug_start', '用真实图像与模型调用原子能力自主调试相机；默认最多4次调整，加最后一次图像验收；失败或取消恢复原始参数。', '/ai-debug', z.object({ ...experiment, goal: goalSchema, maxRounds: z.number().int().min(1).max(6).optional() }).strict(), { goal: { type: 'string', minLength: 1, maxLength: 2000 }, maxRounds: { type: 'integer', minimum: 1, maximum: 6 } }, ['goal']),
    alias('vision_ai_debug_status', '查询本身份自主调试运行与真实图像、原子操作、模型评估及恢复证据。', '/ai-debug/runs/:runId', z.object({ ...experiment, runId: id }).strict(), { runId: opaque }, ['runId'], 'GET'),
    alias('vision_ai_debug_cancel', '取消自主调试并等待实际原始配置恢复，取消请求不冒充恢复完成。', '/ai-debug/runs/:runId/cancel', z.object({ ...experiment, runId: id }).strict(), { runId: opaque }, ['runId']),
    alias('vision_ai_debug_restore_original', '运行结束后恢复保存的完整原始相机配置，核对实际回读哈希。', '/ai-debug/runs/:runId/restore-original', z.object({ ...experiment, runId: id }).strict(), { runId: opaque }, ['runId']),
    alias('vision_camera_probe', '探测实验所绑定的服务端相机适配器，保存非空真实facts；型号及SDK由适配配置提供。', '/device/probe', z.object(experiment).strict(), {}, []),
    alias('vision_pipeline_validate', '检查真实媒体链路；失败保存检查项并返回失败。', '/device/pipeline_validate', z.object(experiment).strict(), {}, []),
    alias('vision_camera_bringup', '使用已适配的驱动和模式启动相机，记录实际检查回执；不生成新Sensor驱动，出图须另行验证。', '/device/bringup', z.object(experiment).strict(), {}, []),
    alias('vision_camera_preview_start', '启动绑定相机的预览会话；尺寸和帧率来自设备回执。', '/device/preview_start', z.object(experiment).strict(), {}, []),
    alias('vision_camera_preview_stop', '停止绑定相机的预览会话。', '/device/preview_stop', z.object(experiment).strict(), {}, []),
    alias('vision_camera_preview_frame', '读取预览会话的实际PNG/JPEG帧，不公开设备地址。', '/device/preview_frame', z.object(experiment).strict(), {}, []),
    alias('vision_camera_controls_get', '读取相机实际值、支持范围与可写状态；不推测USB gain的物理意义。', '/device/controls_get', z.object(experiment).strict(), {}, []),
    alias('vision_camera_controls_set', '只修改设备已支持且可写的数值或布尔控制，核对实际回读。', '/device/controls_set', z.object({ ...experiment, values: z.record(z.union([z.number().finite(), z.boolean()])) }).strict(), { values: { type: 'object', additionalProperties: { type: ['number', 'boolean'] }, minProperties: 1, maxProperties: 64 } }, ['values']),
    alias('vision_camera_capture_frame', '归档实际相机PNG/JPEG、场景与控制上下文；明确区别于Bayer Raw。', '/device/capture_frame', z.object({ ...experiment, scene: shortText.optional(), candidateId: id.optional() }).strict(), { scene: { type: 'string', minLength: 1, maxLength: 100 }, candidateId: opaque }, []),
    alias('vision_raw_capture', '采集并归档一帧真实Raw；请求只包含场景，不接受命令或地址。', '/device/capture_raw', z.object({ ...experiment, scene: z.string().trim().min(1).max(120) }).strict(), { scene: { type: 'string', minLength: 1, maxLength: 120 } }, ['scene']),
    alias('vision_isp_generate', '根据已归档Raw或与当前基线匹配的PNG相机帧统计及数值规则生成AI候选，保持画质未经验证。', '/candidates', z.object({ ...experiment, goal: goalSchema.optional(), frameIds: z.array(id).min(1).max(16).refine(values => new Set(values).size === values.length).optional() }).strict(), { goal: { type: 'string', minLength: 1, maxLength: 2000 }, frameIds: { type: 'array', items: opaque, minItems: 1, maxItems: 16, uniqueItems: true } }, []),
    alias('vision_isp_process_raw', '由绑定的SDK适配器用基础或候选参数处理已归档Raw，校验实际PNG/JPEG回执。', '/device/process_raw', z.object({ ...experiment, sampleId: id, candidateId: id.optional() }).strict(), { sampleId: opaque, candidateId: opaque }, ['sampleId']),
    alias('vision_isp_tuning_get', '读取编译SDK描述的完整当前ISP快照、可编辑字段与独立回读哈希。', '/device/tuning_get', z.object(experiment).strict(), {}, []),
    alias('vision_isp_tuning_export', '导出已归档效果库输入及独立SDK模块快照；未公开字段不冒充SDK回读。', '/device/tuning_export', z.object(experiment).strict(), {}, []),
    alias('vision_isp_tuning_load', '加载哈希匹配的效果库JSON字节，保存原始版本，执行SDK并独立回读模块；不接受路径。', '/device/tuning_load', z.object({ ...experiment, contentBase64: z.string().max(24 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), artifactRole: z.literal('vendor_effect_library_candidate').optional() }).strict(), { contentBase64: { type:'string', maxLength:24 * 1024 * 1024 }, sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}, artifactRole:{type:'string',enum:['vendor_effect_library_candidate']} }, ['contentBase64','sha256']),
    alias('vision_calibration_apply', '读取本身份已计算并校验的标定任务，通过匹配SDK私有映射应用并核对模块回读；保留画质未验收状态。', '/device/calibration_apply', z.object({ ...experiment, taskId: z.string().uuid(), options: z.object({ illuminantId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict().optional() }).strict(), { taskId:opaque, options:{ type:'object', properties:{illuminantId:opaque},additionalProperties:false } }, ['taskId']),
    alias('vision_isp_apply', '应用已有候选并核对应用与回读哈希；此动作不能证明画质验收通过。', '/device/apply_tuning', z.object({ ...experiment, candidateId: id }).strict(), { candidateId: opaque }, ['candidateId']),
    alias('vision_isp_restore', '恢复当前或历史基础参数、历史候选；须核对实际应用及回读哈希。', '/device/restore_tuning', z.object({ ...experiment, baselineId: id.optional(), candidateId: id.optional() }).strict().refine(value => !(value.baselineId && value.candidateId)), { baselineId: opaque, candidateId: opaque }, []),
    alias('vision_image_evaluate', '记录对真实结果图的人工评价；评分不冒充自动画质验证。', '/evaluations', z.object({ ...experiment, imageId: id, rating: z.number().int().min(1).max(5), notes: z.string().min(1).max(2000) }).strict(), { imageId: opaque, rating: { type: 'integer', minimum: 1, maximum: 5 }, notes: { type: 'string', minLength: 1, maxLength: 2000 } }, ['imageId', 'rating', 'notes']),
    alias('vision_image_compare', '比较同Raw、同基线参数版本的真实PNG输出亮度和ROI统计；方法png-output-comparison，不代替画质验收。', '/comparisons', z.object({ ...experiment, baselineImageId: id, candidateImageId: id, roi: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).strict().optional() }).strict(), { baselineImageId: opaque, candidateImageId: opaque, roi: { type: 'object', properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false } }, ['baselineImageId', 'candidateImageId']),
    ...buildVisionCalibrationMcpTools(router, req, res),
    alias('vision_workshop_export', '导出实验快照、参数候选、手册、图片和可选Raw；返回受保护ZIP下载地址。', '/bundle', z.object({ ...experiment, includeRaw: z.boolean().optional() }).strict(), { includeRaw: { type: 'boolean' } }, [], 'GET'),
  ];
}

export function registerVisionWorkshopRoutes(router: Router, options: Options = {}): void {
  const service = options.getService ?? getConfiguredVisionWorkshopService;
  const devices = options.getDevices ?? configuredVisionDevices;
  const requestDevices = (req: Request) => visionWorkshopDevices(req, devices());
  const calibration = registerVisionCalibrationRoutes(router, { service, devices, requestDevices });
  const enabled = options.modelEnabled ?? visionModelEnabled;
  const generate = options.generateCandidate ?? generateVisionIspCandidate;
  let generating = 0;
  const runtimeCapabilities = (req: Request) => {
    const profiles = requestDevices(req).list(); const modelAvailable = enabled();
    const operation = (name: VisionDeviceOperation): VisionDeviceCapability => profiles.some((profile) => profile.operations.includes(name)) ? { status: 'available', verification: 'configured-adapter' } : { status: 'unavailable', reason: '尚未配置匹配SDK的板端适配器' };
    const candidateGeneration: VisionCapabilities['candidateGeneration'] = modelAvailable ? { status: 'available', verification: 'unverified' } : { status: 'unavailable', reason: '尚未配置并明确启用视觉模型网关' };
    const aiReady = modelAvailable && profiles.some(profile => ['probe', 'controls_get', 'controls_set', 'capture_frame', 'restore_tuning'].every(operation => operation === 'controls_set'
      ? profile.operations.includes('controls_set') || profile.operations.includes('apply_tuning') : profile.operations.includes(operation as VisionDeviceOperation)));
    return { ...service().capabilities(), aiDebug: { status: aiReady ? 'available' as const : 'unavailable' as const, ...(aiReady ? {} : { reason: !modelAvailable ? '尚未配置并启用真实视觉模型' : '需要实际相机控制、采图及可验证恢复原子能力' }), maxRounds: 6, defaultRounds: 4, modelInput: 'camera_images_controls_and_history' }, modelEnabled: modelAvailable, candidateGeneration, modelInput: 'raw_statistics_and_baseline_or_processed_frame_statistics', deviceAdapters: profiles, bringup: operation('bringup'), capture: operation('capture_raw'), apply: operation('apply_tuning') };
  };
  const get = (suffix: string, handler: (req: Request, res: Response) => unknown) => router.get(VISION_WORKSHOP_API + suffix, requireVisionWorkshopAccess, async (req, res) => { try { await handler(req, res); } catch (error) { failure(res, error); } });
  registerVisionPluginPackageRoutes(router, { access: requireVisionWorkshopAccess, owner: visionWorkshopOwner });
  const post = (suffix: string, handler: (req: Request, res: Response) => unknown, binaryLimit?: string) => {
    router.post(VISION_WORKSHOP_API + suffix,
      ...(binaryLimit ? [requireVisionWorkshopUploadAccess] : []),
      ...(binaryLimit ? [express.raw({ type: ['application/octet-stream', 'image/png', 'image/jpeg'], limit: binaryLimit })] : []),
      requireVisionWorkshopAccess, requireOpsMutationGuard,
      (req, res, next) => { if (req.header('x-rdk-ops-read-only') === '1') res.status(403).json({ ok: false, error: 'platform_read_only_operation_denied' }); else next(); },
      async (req, res) => { try { await handler(req, res); } catch (error) { failure(res, error); } });
  };
  router.get('/ops-observability/vision-workshop', (_req, res) => res.type('html').send(renderVisionWorkshopPage()));
  get('/knowledge', (req, res) => {
    const query = knowledgeQuery.parse(req.query);
    const entries = searchVisionCameraKnowledge(query);
    const profiles = entries.length ? requestDevices(req).list() : [];
    res.json({ ok: true, contract: VISION_KNOWLEDGE_CONTRACT, entries: entries.map(entry => summarizeVisionCameraKnowledge(entry, profiles)) });
  });
  get('/knowledge/:knowledgeId', (req, res) => {
    const key = knowledgeId.parse(req.params.knowledgeId);
    const knowledge = getVisionCameraKnowledge(key);
    if (!knowledge) throw new VisionWorkshopError('vision_knowledge_not_found', 'Unknown reviewed camera knowledge', 404);
    res.json({ ok: true, contract: VISION_KNOWLEDGE_CONTRACT, knowledge, readiness: visionKnowledgeReadiness(knowledge, requestDevices(req).list()) });
  });
  get('/capabilities', (req, res) => {
    res.json({ ok: true, contract: VISION_WORKSHOP_CONTRACT, ...runtimeCapabilities(req), mcpEndpoint: VISION_WORKSHOP_MCP,
      atomicOperations: [...Object.keys(VISION_WORKSHOP_OPERATIONS), ...Object.keys(VISION_CALIBRATION_OPERATIONS)], knowledge: { status: 'available', contract: VISION_KNOWLEDGE_CONTRACT, searchPath: VISION_WORKSHOP_API + '/knowledge' }, binaryUpload: { rawHeader: 'x-vision-sample', imageHeader: 'x-vision-result', type: 'application/octet-stream', metadataEncoding: 'encodeURIComponent(JSON.stringify(metadata))' } });
  });
  get('/experiments', async (req, res) => res.json({ ok: true, experiments: await service().listExperiments(visionWorkshopOwner(req)) }));
  post('/experiments', async (req, res) => {
    const input = experimentInput.parse(req.body);
    if (input.targetId) {
      const profile = requestDevices(req).get(input.targetId).profile;
      for (const field of cameraIdentityFields) {
        if (input[field] !== undefined && input[field] !== profile[field]) throw new VisionWorkshopError('vision_device_profile_mismatch', 'Camera identity differs from the configured adapter: ' + field, 409);
        if (profile[field] !== undefined) input[field] ??= profile[field];
      }
    }
    res.status(201).json({ ok: true, experiment: await service().createExperiment(visionWorkshopOwner(req), input) });
  });
  get('/experiments/:id', async (req, res) => res.json({ ok: true, experiment: await service().getExperiment(visionWorkshopOwner(req), String(req.params.id)) }));
  get('/experiments/:id/delivery', async (req, res) => res.json({ ok: true, delivery: buildVisionWorkshopDelivery(await service().getExperiment(visionWorkshopOwner(req), String(req.params.id))) }));
  post('/experiments/:id/delivery-target', async (req, res) => { const input = z.object({ targetId: id }).strict().parse(req.body); res.json({ ok: true, experiment: await service().setDeliveryTarget(visionWorkshopOwner(req), String(req.params.id), input.targetId) }); });
  get('/experiments/:id/vendor-artifacts/:artifactId/download', async (req, res) => { const stored = await service().readVendorArtifact(visionWorkshopOwner(req), String(req.params.id), String(req.params.artifactId)); res.setHeader('X-Vision-Sha256', stored.artifact.hash); res.attachment(stored.artifact.filename).type('application/json').send(stored.data); });
  post('/experiments/:id/acceptance-plan', async (req, res) => res.status(201).json({ ok: true, plan: await service().setAcceptancePlan(visionWorkshopOwner(req), String(req.params.id), req.body) }));
  post('/experiments/:id/acceptance-records', async (req, res) => res.status(201).json({ ok: true, record: await service().recordAcceptance(visionWorkshopOwner(req), String(req.params.id), req.body) }));
  get('/experiments/:id/handbook', async (req, res) => {
    const manifest = await service().exportManifest(visionWorkshopOwner(req), String(req.params.id)); manifest.capabilities = runtimeCapabilities(req);
    res.attachment('vision-workshop-handbook.md').type('text/markdown').send(renderVisionHandbook(buildVisionHandbook(manifest.experiment, manifest.capabilities), manifest));
  });
  const debugManager = (req: Request) => new VisionAiDebugManager(service(), requestDevices(req), options.planDebug);
  const requireExperimentAdapter = async (req: Request) => {
    const experiment = await service().getExperiment(visionWorkshopOwner(req), String(req.params.id));
    if (experiment.targetId) requestDevices(req).get(experiment.targetId);
  };
  get('/experiments/:id/readiness', async (req, res) => {
    const owner = visionWorkshopOwner(req); const experimentId = String(req.params.id);
    const experiment = await service().getExperiment(owner, experimentId);
    experiment.aiDebugRuns = await debugManager(req).list(owner, experimentId);
    res.json({ ok: true, readiness: buildVisionWorkshopReadiness(experiment, requestDevices(req).list(), enabled(), await calibration.listTasks(owner, experimentId)) });
  });
  get('/experiments/:id/workflow', async (req, res) => {
    z.object({}).strict().parse(req.query);
    const owner = visionWorkshopOwner(req); const experimentId = String(req.params.id);
    const experiment = await service().getExperiment(owner, experimentId);
    experiment.aiDebugRuns = await debugManager(req).list(owner, experimentId);
    res.json({ ok: true, workflow: buildVisionCameraWorkflow(experiment, requestDevices(req).list(), enabled(), await calibration.listTasks(owner, experimentId)) });
  });
  get('/experiments/:id/stream-analysis', async (req, res) => {
    const input = streamAnalysisQuery.parse(req.query);
    const experiment = await service().getExperiment(visionWorkshopOwner(req), String(req.params.id));
    res.json({ ok: true, analysis: analyzeVisionCameraStreamEvidence(experiment, input) });
  });
  post('/experiments/:id/ai-debug', async (req, res) => {
    const input = z.object({ goal: goalSchema, maxRounds: z.number().int().min(1).max(6).optional() }).strict().parse(req.body ?? {});
    await requireExperimentAdapter(req);
    if (!enabled()) throw new VisionWorkshopError('vision_model_disabled', 'Configure and explicitly enable the visual model before starting AI debug', 503);
    const run = await debugManager(req).start(visionWorkshopOwner(req), String(req.params.id), input.goal, input.maxRounds);
    res.status(202).json({ ok: true, run });
  });
  get('/experiments/:id/ai-debug/runs', async (req, res) => res.json({ ok: true, runs: await debugManager(req).list(visionWorkshopOwner(req), String(req.params.id)) }));
  get('/experiments/:id/ai-debug/runs/:runId', async (req, res) => res.json({ ok: true, run: await debugManager(req).get(visionWorkshopOwner(req), String(req.params.id), String(req.params.runId)) }));
  post('/experiments/:id/ai-debug/runs/:runId/cancel', async (req, res) => { z.object({}).strict().parse(req.body ?? {}); await requireExperimentAdapter(req); res.json({ ok: true, run: await debugManager(req).cancel(visionWorkshopOwner(req), String(req.params.id), String(req.params.runId)) }); });
  post('/experiments/:id/ai-debug/runs/:runId/restore-original', async (req, res) => { z.object({}).strict().parse(req.body ?? {}); await requireExperimentAdapter(req); res.json({ ok: true, run: await debugManager(req).restoreOriginal(visionWorkshopOwner(req), String(req.params.id), String(req.params.runId)) }); });
  post('/experiments/:id/baseline', async (req, res) => { const input = baselineInput.parse(req.body); res.json({ ok: true, baseline: await service().setBaseline(visionWorkshopOwner(req), String(req.params.id), { tuning: input.config as VisionJsonObject, rules: input.rules }) }); });
  post('/experiments/:id/samples', async (req, res) => {
    let filename: string | undefined; let metadata: unknown; let bytes: Buffer;
    if (Buffer.isBuffer(req.body)) { const input = rawMetadataInput.extend({ filename: z.string().max(200).optional() }).strict().parse(metadataHeader(req, 'x-vision-sample')); const { filename: name, ...rest } = input; filename = name; metadata = rest; bytes = req.body; }
    else { const input = z.object({ filename: z.string().max(200).optional(), metadata: rawMetadataInput, contentBase64: z.string().max(700000) }).strict().parse(req.body); filename = input.filename; metadata = input.metadata; bytes = decodeBase64(input.contentBase64, 512 * 1024); }
    res.status(201).json({ ok: true, sample: await service().addRawSample(visionWorkshopOwner(req), String(req.params.id), { filename, metadata: metadata as VisionRawMetadata }, bytes) });
  }, '64mb');
  get('/experiments/:id/samples/:sampleId', async (req, res) => {
    const stored = await service().readRawSample(visionWorkshopOwner(req), String(req.params.id), String(req.params.sampleId)); const analysis = analyzeVisionRaw(stored.data, stored.sample.metadata);
    const base = VISION_WORKSHOP_API + '/experiments/' + req.params.id + '/samples/' + req.params.sampleId;
    res.json({ ok: true, sample: stored.sample, statistics: analysis.statistics, warnings: analysis.warnings, preview: { ...analysis.preview, path: base + '/preview.png' }, downloadPath: base + '/download' });
  });
  get('/experiments/:id/samples/:sampleId/preview.png', async (req, res) => { const stored = await service().readRawSample(visionWorkshopOwner(req), String(req.params.id), String(req.params.sampleId)); res.type('png').send(analyzeVisionRaw(stored.data, stored.sample.metadata).previewPng); });
  get('/experiments/:id/samples/:sampleId/download', async (req, res) => { const stored = await service().readRawSample(visionWorkshopOwner(req), String(req.params.id), String(req.params.sampleId)); res.attachment(stored.sample.id + '.raw').type('application/octet-stream').send(stored.data); });
  post('/experiments/:id/candidates', async (req, res) => {
    const input = candidateInput.parse(req.body ?? {}); const owner = visionWorkshopOwner(req); const experimentId = String(req.params.id); const experiment = await service().getExperiment(owner, experimentId);
    if (!experiment.baseline) throw new VisionWorkshopError('vision_baseline_required', 'Import a validated baseline before generating candidates', 409);
    if (!experiment.samples.length && !experiment.cameraFrames.length) throw new VisionWorkshopError('vision_raw_required', 'Import Raw or capture an actual camera frame before generating candidates', 409);
    const useRaw = Boolean(experiment.samples.length && !input.frameIds);
    if (useRaw && experiment.samples.length > 16) throw new VisionWorkshopError('vision_model_sample_limit', 'At most 16 Raw samples can be analyzed in one candidate generation', 409);
    const matchingFrames = experiment.cameraFrames.filter(frame => frame.mimeType === 'image/png' && frame.tuningHash === experiment.baseline!.hash);
    const evidenceFrames = input.frameIds ? input.frameIds.map(frameId => {
      const frame = matchingFrames.find(entry => entry.id === frameId);
      if (!frame) throw new VisionWorkshopError('vision_matching_frame_required', 'Select actual PNG frames captured with the current baseline configuration', 409);
      return frame;
    }) : matchingFrames.slice(-16);
    if (!useRaw && !evidenceFrames.length) throw new VisionWorkshopError('vision_matching_frame_required', 'Capture an actual PNG frame with the current baseline configuration before generating candidates', 409);
    if (!enabled()) throw new VisionWorkshopError('vision_model_disabled', 'Configure and explicitly enable the model gateway', 503);
    if (generating >= 2) throw new VisionWorkshopError('vision_model_busy', 'Candidate generation concurrency limit reached', 429);
    generating++;
    try {
      const statistics = [];
      if (useRaw) for (const sample of experiment.samples) { const stored = await service().readRawSample(owner, experimentId, sample.id); statistics.push(analyzeVisionRaw(stored.data, stored.sample.metadata).statistics); }
      const cameraContext = Object.fromEntries(cameraIdentityFields.filter((field) => experiment[field] !== undefined).map((field) => [field, experiment[field]]));
      const frameStatistics = [];
      if (!useRaw) for (const frame of evidenceFrames) { const stored = await service().readCameraFrame(owner, experimentId, frame.id); frameStatistics.push(analyzeVisionProcessedPng(stored.data)); }
      let targetAnalysis;
      if (input.targetAnalysisFrameId) {
        const chartFrame = experiment.cameraFrames.find(frame => frame.id === input.targetAnalysisFrameId);
        if (!chartFrame || chartFrame.mimeType !== 'image/png') throw new VisionWorkshopError('vision_target_frame_required', 'The target chart evidence must be an actual archived PNG camera frame of this experiment', 404);
        const stored = await service().readCameraFrame(owner, experimentId, chartFrame.id);
        const analysis = analyzeVisionTargetChart(stored.data);
        targetAnalysis = { method: analysis.method, meanDeltaE: analysis.meanDeltaE, maxDeltaE: analysis.maxDeltaE, grayMaxLumaDelta: analysis.grayMaxLumaDelta, whiteBalanceOffset: analysis.whiteBalanceOffset, patchDeltaE: analysis.patches.map(patch => ({ name: patch.name, deltaE: patch.deltaE })) };
      }
      const proposal = await generate({ baseline: experiment.baseline.tuning, rules: experiment.baseline.rules, ...(useRaw ? { rawStatistics: statistics } : { frameStatistics }), ...(targetAnalysis ? { targetAnalysis } : {}), goal: input.goal ?? experiment.goal, cameraContext });
      const current = await service().getExperiment(owner, experimentId);
      if (current.baseline?.id !== experiment.baseline.id || current.baseline?.hash !== experiment.baseline.hash) throw new VisionWorkshopError('vision_baseline_changed', 'Baseline changed while the model was generating; inspect versions before regenerating', 409);
      const candidate = await service().createCandidate(owner, experimentId, { baselineHash: experiment.baseline.hash, baselineId: experiment.baseline.id, patches: proposal.patches, sampleIds: useRaw ? experiment.samples.map((sample) => sample.id) : [], frameIds: useRaw ? [] : evidenceFrames.map(frame => frame.id), modelInput: proposal.modelInput, source: 'model', model: proposal.model });
      res.status(201).json({ ok: true, candidate, modelInput: proposal.modelInput });
    } finally { generating--; }
  });
  post('/experiments/:id/results', async (req, res) => {
    let bytes: Buffer; let input: z.infer<typeof resultInput>;
    if (Buffer.isBuffer(req.body)) { bytes = req.body; input = resultInput.parse(metadataHeader(req, 'x-vision-result')); }
    else { const parsed = resultInput.extend({ contentBase64: z.string().max(700000) }).parse(req.body); bytes = decodeBase64(parsed.contentBase64, 512 * 1024); const { contentBase64: _bytes, ...rest } = parsed; input = rest; }
    const actualType = binaryResultType(bytes);
    if (input.mimeType && input.mimeType !== actualType) throw new VisionWorkshopError('vision_image_type_mismatch', 'Image type does not match its bytes');
    res.status(201).json({ ok: true, image: await service().addProcessedImage(visionWorkshopOwner(req), String(req.params.id), { ...input, mimeType: actualType }, bytes) });
  }, '32mb');
  get('/experiments/:id/frames/:frameId', async (req, res) => { const stored = await service().readCameraFrame(visionWorkshopOwner(req), String(req.params.id), String(req.params.frameId)); res.type(stored.frame.mimeType).send(stored.data); });
  get('/experiments/:id/frames/:frameId/analysis', async (req, res) => {
    const stored = await service().readCameraFrame(visionWorkshopOwner(req), String(req.params.id), String(req.params.frameId));
    let roi: { x: number; y: number; width: number; height: number } | undefined;
    if (req.query.roi !== undefined) {
      if (typeof req.query.roi !== 'string' || req.query.roi.length > 1000) throw new VisionWorkshopError('vision_invalid_request', 'Invalid frame ROI');
      let input: unknown; try { input = JSON.parse(req.query.roi); } catch { throw new VisionWorkshopError('vision_invalid_request', 'Invalid frame ROI'); }
      roi = z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).strict().parse(input);
    }
    res.json({ ok: true, frame: stored.frame, frameId: stored.frame.id, hash: stored.frame.hash, statistics: analyzeVisionProcessedPng(stored.data, roi), inputKind: 'processed-camera-frame', verification: 'unverified' });
  });
  get('/experiments/:id/results/:imageId', async (req, res) => { const stored = await service().readProcessedImage(visionWorkshopOwner(req), String(req.params.id), String(req.params.imageId)); res.type(stored.image.mimeType).send(stored.data); });
  post('/experiments/:id/evaluations', async (req, res) => { const input = z.object({ imageId: id, rating: z.number().int().min(1).max(5), notes: z.string().max(2000) }).strict().parse(req.body); res.status(201).json({ ok: true, evaluation: await service().addEvaluation(visionWorkshopOwner(req), String(req.params.id), { ...input, rating: input.rating as 1 | 2 | 3 | 4 | 5 }) }); });
  post('/experiments/:id/comparisons', async (req, res) => {
    const input = z.object({ baselineImageId: id, candidateImageId: id, roi: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).strict().optional() }).strict().parse(req.body);
    const owner = visionWorkshopOwner(req); const experimentId = String(req.params.id);
    const stored = await service().getExperiment(owner, experimentId);
    const baselineImage = stored.processedImages.find((image) => image.id === input.baselineImageId); const candidateImage = stored.processedImages.find((image) => image.id === input.candidateImageId);
    if (!baselineImage || !candidateImage) throw new VisionWorkshopError('vision_image_not_found', 'Unknown comparison image', 404);
    const candidate = stored.candidates.find((entry) => entry.id === candidateImage.candidateId);
    if (baselineImage.candidateId || !candidateImage.candidateId || baselineImage.sampleId !== candidateImage.sampleId || baselineImage.width !== candidateImage.width || baselineImage.height !== candidateImage.height) throw new VisionWorkshopError('invalid_comparison', 'Compare one baseline and one candidate output from the same Raw', 409);
    if (!candidate || baselineImage.tuningHash !== candidate.baselineHash || candidateImage.tuningHash !== candidate.hash) throw new VisionWorkshopError('comparison_tuning_mismatch', 'Output tuning versions differ from the candidate baseline', 409);
    if (baselineImage.mimeType !== 'image/png' || candidateImage.mimeType !== 'image/png') throw new VisionWorkshopError('vision_quality_unavailable', 'Only supported PNG outputs can be compared', 415);
    const before = await service().readProcessedImage(owner, experimentId, baselineImage.id); const after = await service().readProcessedImage(owner, experimentId, candidateImage.id);
    const metrics = compareVisionProcessedPng(before.data, after.data, input.roi);
    const comparison = await service().recordComparison(owner, experimentId, { baselineImageId: baselineImage.id, candidateImageId: candidateImage.id, metrics: metrics as unknown as VisionJsonObject });
    res.status(201).json({ ok: true, comparison, method: metrics.method });
  });
  post('/experiments/:id/frames/delete', async (req, res) => {
    const input = z.object({ frameIds: z.array(id).min(1).max(32).refine(values => new Set(values).size === values.length) }).strict().parse(req.body);
    const result = await service().deleteCameraFrames(visionWorkshopOwner(req), String(req.params.id), input.frameIds);
    res.json({ ok: true, ...result });
  });
  post('/experiments/:id/frames/:frameId/target-analysis', async (req, res) => {
    const stored = await service().readCameraFrame(visionWorkshopOwner(req), String(req.params.id), String(req.params.frameId));
    res.json({ ok: true, frameId: stored.frame.id, analysis: analyzeVisionTargetChart(stored.data) });
  });
  post('/experiments/:id/target-trend', async (req, res) => {
    const input = z.object({ frameIds: z.array(id).min(2).max(16).refine(values => new Set(values).size === values.length) }).strict().parse(req.body);
    const owner = visionWorkshopOwner(req); const experimentId = String(req.params.id); const experiment = await service().getExperiment(owner, experimentId);
    const series = [];
    for (const frameId of input.frameIds) {
      const frame = experiment.cameraFrames.find(entry => entry.id === frameId);
      if (!frame || frame.mimeType !== 'image/png') throw new VisionWorkshopError('vision_target_frame_required', 'Target trend frames must be actual archived PNG camera frames of this experiment', 404);
      const stored = await service().readCameraFrame(owner, experimentId, frameId);
      const analysis = analyzeVisionTargetChart(stored.data);
      series.push({ frameId, scene: frame.scene, capturedAt: frame.capturedAt ?? frame.createdAt, meanDeltaE: analysis.meanDeltaE, maxDeltaE: analysis.maxDeltaE, grayMaxLumaDelta: analysis.grayMaxLumaDelta, whiteBalanceOffset: analysis.whiteBalanceOffset, sampledPixels: analysis.sampledPixels });
    }
    series.sort((first, second) => String(first.capturedAt).localeCompare(String(second.capturedAt)));
    res.json({ ok: true, series, method: 'target-chart-v1' });
  });
  post('/experiments/:id/selection', async (req, res) => { const input = z.object({ candidateId: id }).strict().parse(req.body); res.json({ ok: true, experiment: await service().selectCandidate(visionWorkshopOwner(req), String(req.params.id), input.candidateId) }); });
  get('/experiments/:id/tuning', async (req, res) => {
    const experiment = await service().getExperiment(visionWorkshopOwner(req), String(req.params.id));
    if (req.query.candidateId !== undefined && typeof req.query.candidateId !== 'string') throw new VisionWorkshopError('vision_invalid_request', 'Invalid candidate query');
    const candidate = experiment.candidates.find((item) => item.id === (req.query.candidateId ?? experiment.selectedCandidateId));
    if (!candidate) throw new VisionWorkshopError('vision_candidate_selection_required', 'Select a candidate or pass candidateId', 409);
    res.setHeader('X-Vision-Verification', candidate.verification); res.attachment('candidate_tuning.json').type('json').send(JSON.stringify(candidate.tuning));
  });
  get('/experiments/:id/bundle', async (req, res) => {
    if (req.query.includeRaw !== undefined && req.query.includeRaw !== '0' && req.query.includeRaw !== '1') throw new VisionWorkshopError('vision_invalid_request', 'includeRaw must be 0 or 1');
    const owner = visionWorkshopOwner(req); const experimentId = String(req.params.id); const manifest = await service().exportManifest(owner, experimentId); manifest.capabilities = runtimeCapabilities(req); const handbook = buildVisionHandbook(manifest.experiment, manifest.capabilities);
    const entries: VisionArchiveEntry[] = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: 'handbook.md', data: Buffer.from(renderVisionHandbook(handbook, manifest)) }];
    entries.push(...await calibration.exportEntries(owner, experimentId));
    entries.push(...buildVisionAiDebugExport(manifest.experiment));
    entries.push(...buildVisionWorkshopDeliveryExport(manifest.experiment));
    for (const artifact of manifest.experiment.vendorArtifacts ?? []) { const stored = await service().readVendorArtifact(owner, experimentId, artifact.id); entries.push({ name: 'vendor-tuning/' + artifact.id + '.json', data: stored.data }); }
    if (manifest.selectedTuning) entries.push({ name: 'candidate_tuning.json', data: Buffer.from(JSON.stringify(manifest.selectedTuning)) });
    for (const frame of manifest.experiment.cameraFrames) { const stored = await service().readCameraFrame(owner, experimentId, frame.id); entries.push({ name: 'frames/' + frame.id + (frame.mimeType === 'image/png' ? '.png' : '.jpg'), data: stored.data }); }
    for (const image of manifest.experiment.processedImages) { const stored = await service().readProcessedImage(owner, experimentId, image.id); entries.push({ name: 'images/' + image.id + (image.mimeType === 'image/png' ? '.png' : '.jpg'), data: stored.data }); }
    if (req.query.includeRaw === '1') for (const sample of manifest.experiment.samples) { const stored = await service().readRawSample(owner, experimentId, sample.id); entries.push({ name: 'raw/' + sample.id + '.raw', data: stored.data }); }
    res.attachment('vision-workshop-' + experimentId + '.zip').type('application/zip').send(createVisionArchive(entries));
  });
  for (const operation of VISION_DEVICE_OPERATIONS) post('/experiments/:id/device/' + operation, async (req, res) => {
    const input = (operation === 'capture_raw' ? z.object({ scene: z.string().trim().min(1).max(120) }).strict() : operation === 'capture_frame' ? z.object({ scene: z.string().trim().min(1).max(120).optional(), candidateId: id.optional() }).strict() : operation === 'process_raw' ? z.object({ sampleId: id, candidateId: id.optional() }).strict() : operation === 'apply_tuning' ? z.object({ candidateId: id }).strict() : operation === 'restore_tuning' ? z.object({ baselineId: id.optional(), candidateId: id.optional() }).strict().refine(value => !(value.baselineId && value.candidateId)) : operation === 'controls_set' ? z.object({ values: z.record(z.union([z.number().finite(), z.boolean()])) }).strict() : operation === 'tuning_load' ? z.object({ contentBase64: z.string().max(24 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), artifactRole: z.literal('vendor_effect_library_candidate').optional() }).strict() : operation === 'calibration_apply' ? z.object({ taskId: z.string().uuid(), options: z.object({ illuminantId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict().optional() }).strict() : z.object({}).strict()).parse(req.body ?? {}) as { scene?: string; sampleId?: string; candidateId?: string; baselineId?: string; values?: Record<string, number | boolean>; contentBase64?:string;sha256?:string;artifactRole?:'vendor_effect_library_candidate';taskId?:string;options?:{illuminantId?:string} };
    const owner = visionWorkshopOwner(req); const experimentId = String(req.params.id); const experiment = await service().getExperiment(owner, experimentId);
    if (!experiment.targetId) throw new VisionWorkshopError('vision_device_adapter_required', 'Create the experiment with a configured adapter targetId', 409);
    const registry = requestDevices(req); const adapter = registry.get(experiment.targetId); const inputs: Record<string, unknown> = {};
    if (operation === 'capture_raw') inputs.scene = input.scene;
    if (operation === 'capture_frame' && input.scene) inputs.scene = input.scene;
    if (operation === 'controls_set') inputs.values = validateVisionControlValues(input.values);
    if (operation === 'tuning_load') {
      const bytes = decodeBase64(input.contentBase64, 16 * 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new VisionWorkshopError('vision_effect_library_hash_mismatch','Effect library hash mismatch');
      try { const json:unknown=JSON.parse(bytes.toString('utf8')); if (!json || typeof json!=='object' || Array.isArray(json)) throw new Error(); } catch { throw new VisionWorkshopError('vision_effect_library_json_invalid','A JSON object is required'); }
      inputs.contentBase64=input.contentBase64; inputs.sha256=input.sha256;
      if (input.artifactRole) inputs.artifactRole = input.artifactRole;
    }
    if (operation === 'calibration_apply') {
      inputs.result = await calibration.getResult(owner,experimentId,input.taskId!);
      inputs.options=input.options ?? {};
    }
    let tuningHash: string | undefined;
    if (operation === 'process_raw' || operation === 'apply_tuning' || operation === 'restore_tuning') {
      const candidate = input.candidateId ? experiment.candidates.find((item) => item.id === input.candidateId) : null;
      if (input.candidateId && !candidate) throw new VisionWorkshopError('vision_candidate_not_found', 'Unknown candidate', 404);
      const baseline = input.baselineId ? experiment.baselineHistory.find(item => item.id === input.baselineId) : experiment.baseline;
      if (input.baselineId && !baseline) throw new VisionWorkshopError('vision_baseline_not_found', 'Unknown baseline version', 404);
      const tuning = candidate?.tuning ?? baseline?.tuning; tuningHash = candidate?.hash ?? baseline?.hash;
      if (!tuning || !tuningHash) throw new VisionWorkshopError('vision_baseline_required', 'Import a matching SDK baseline', 409);
      inputs.tuning = tuning; inputs.tuningHash = tuningHash;
      if (operation === 'process_raw') { const stored = await service().readRawSample(owner, experimentId, input.sampleId!); if (candidate && !candidate.sampleIds.includes(stored.sample.id)) throw new VisionWorkshopError('vision_candidate_sample_mismatch', 'Candidate was generated for different Raw evidence', 409); inputs.raw = { filename: stored.sample.filename, metadata: stored.sample.metadata, sha256: stored.sample.hash, contentBase64: stored.data.toString('base64') }; }
    }
    try {
      if (!experiment.board || !experiment.sensorModel || !experiment.sdkVersion) throw new VisionWorkshopError('vision_device_identity_required', 'Record the configured board, camera and SDK identity before device execution', 409);
      const run = await registry.execute(experiment.targetId, operation, { experimentId, board: experiment.board, sensorVendor: experiment.sensorVendor, sensorModel: experiment.sensorModel, sdkVersion: experiment.sdkVersion, cameraInterface: experiment.cameraInterface, cameraMode: experiment.cameraMode }, inputs);
      let vendorArtifact: Record<string, unknown> | undefined;
      if (operation === 'tuning_export' && run.result.vendorCandidate && typeof run.result.vendorCandidate === 'object' && !Array.isArray(run.result.vendorCandidate)) {
        const candidate = run.result.vendorCandidate as Record<string, unknown>;
        if (candidate.status === 'generated_requires_target_validation') {
          const bytes = resultBytes(candidate, 16 * 1024 * 1024);
          try { const json: unknown = JSON.parse(bytes.toString('utf8')); if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(); } catch { throw new VisionWorkshopError('vision_effect_library_json_invalid', 'Candidate export must contain a JSON object', 502); }
          if (candidate.artifactRole !== 'vendor_effect_library_candidate') throw new VisionWorkshopError('vision_device_invalid_receipt', 'Candidate export role is required', 502);
          const archived = await service().archiveVendorArtifact(owner, experimentId, { bindingHash: candidate.bindingHash as string, sourceReadbackHash: candidate.sourceReadbackHash as string }, bytes);
          vendorArtifact = { id: archived.id, filename: archived.filename, mimeType: 'application/json', artifactRole: candidate.artifactRole, sha256: candidate.sha256, contentBase64: candidate.contentBase64 };
        }
      }
      if (operation === 'tuning_export' && run.result.contentBase64 !== undefined) {
        const bytes=resultBytes(run.result,16*1024*1024);
        if (run.result.mimeType!=='application/json') throw new VisionWorkshopError('vision_effect_library_json_invalid','Only SDK JSON export is supported',502);
        try { const json:unknown=JSON.parse(bytes.toString('utf8')); if (!json || typeof json!=='object' || Array.isArray(json)) throw new Error(); } catch { throw new VisionWorkshopError('vision_effect_library_json_invalid','Export must contain actual JSON bytes',502); }
      }
      let asset: VisionRawSample | VisionProcessedImage | VisionCameraFrame | undefined;
      if (operation === 'probe' && (!run.result.facts || typeof run.result.facts !== 'object' || Array.isArray(run.result.facts) || !Object.keys(run.result.facts).length)) throw new VisionWorkshopError('vision_device_invalid_receipt', 'SDK probe must return a nonempty facts object', 502);
      if (operation === 'capture_raw') asset = await service().addRunnerRawSample(owner, experimentId, { filename: typeof run.result.filename === 'string' ? run.result.filename : undefined, metadata: run.result.metadata as VisionRawMetadata, adapterId: adapter.profile.id }, resultBytes(run.result, service().capabilities().limits.maxRawBytes));
      else if (operation === 'process_raw') { if (run.result.tuningHash !== tuningHash || run.result.readbackHash !== tuningHash || run.result.rawHash !== (inputs.raw as {sha256:string}).sha256) throw new VisionWorkshopError('vision_device_replay_witness_mismatch','RAW replay must bind actual input and independent tuning readback',502); const bytes = resultBytes(run.result, service().capabilities().limits.maxImageBytes); const mimeType = binaryResultType(bytes); if (run.result.mimeType !== mimeType) throw new VisionWorkshopError('vision_device_image_type_mismatch', 'Device image type does not match actual bytes', 502); asset = await service().addRunnerProcessedImage(owner, experimentId, { sampleId: input.sampleId!, candidateId: input.candidateId, filename: typeof run.result.filename === 'string' ? run.result.filename : undefined, mimeType, adapterId: adapter.profile.id, tuningHash }, bytes); }
      else if (operation === 'capture_frame' || operation === 'preview_frame') {
        const bytes = resultBytes(run.result, service().capabilities().limits.maxImageBytes); const mimeType = binaryResultType(bytes);
        if (run.result.mimeType !== mimeType) throw new VisionWorkshopError('vision_device_image_type_mismatch', 'Camera frame type does not match actual bytes', 502);
        const dimensions = imageDimensions(bytes, mimeType);
        if (operation === 'preview_frame') { res.json({ ok: true, operation, frame: { ...safeReceipt(run.result), ...dimensions, contentBase64: bytes.toString('base64') } }); return; }
        asset = await service().addCameraFrame(owner, experimentId, { filename: typeof run.result.filename === 'string' ? run.result.filename : undefined, mimeType, adapterId: adapter.profile.id,
          ...(input.scene ? { scene: input.scene } : {}), ...(input.candidateId ? { candidateId: input.candidateId } : {}), ...(typeof run.result.tuningHash === 'string' ? { tuningHash: run.result.tuningHash } : {}),
          ...(run.result.controls ? { controls: run.result.controls as VisionCameraControls } : {}), ...(typeof run.result.capturedAt === 'string' ? { capturedAt: run.result.capturedAt } : {}) }, bytes);
      }
      else if (['apply_tuning', 'restore_tuning'].includes(operation) && (run.result.appliedHash !== tuningHash || run.result.readbackHash !== tuningHash)) throw new VisionWorkshopError('vision_device_readback_mismatch', 'SDK readback does not match the requested configuration', 502);
      else if (['pipeline_validate', 'bringup'].includes(operation) && typeof run.result.passed !== 'boolean') throw new VisionWorkshopError('vision_device_invalid_receipt', 'SDK check must return a passed boolean', 502);
      if (['tuning_get','tuning_load','calibration_apply'].includes(operation)) {
        const baseline = run.result.baseline as {config?:VisionJsonObject;rules?:unknown};
        if (!baseline?.config || !Array.isArray(baseline.rules) || !baseline.rules.length) throw new VisionWorkshopError('vision_device_invalid_receipt','ISP operation must return an actual baseline',502);
        const actualHash=createHash('sha256').update(JSON.stringify(baseline.config)).digest('hex');
        if (run.result.readbackHash!==actualHash || operation!=='tuning_get' && run.result.appliedHash!==actualHash) throw new VisionWorkshopError('vision_device_readback_mismatch','Independent ISP snapshot hash mismatch',502);
        await service().setBaseline(owner,experimentId,{tuning:baseline.config,rules:baseline.rules as never});
      }
      const checksFailed = ['pipeline_validate', 'bringup'].includes(operation) && run.result.passed === false;
      const runSampleId = input.sampleId ?? (operation === 'capture_raw' ? asset?.id : undefined);
      const deviceRun = operation === 'controls_get' ? undefined : await service().recordDeviceRun(owner, experimentId, { operation, adapterId: adapter.profile.id, board: adapter.profile.board, sensorVendor: adapter.profile.sensorVendor, sensorModel: adapter.profile.sensorModel, sdkVersion: adapter.profile.sdkVersion, cameraInterface: adapter.profile.cameraInterface, cameraMode: adapter.profile.cameraMode, status: checksFailed ? 'failed' : 'completed', ...(runSampleId ? { sampleId: runSampleId } : {}), ...(input.candidateId ? { candidateId: input.candidateId } : {}), evidence: { jobId: run.jobId, result: ledgerReceipt(run.result) as VisionJsonObject } });
      if (checksFailed) { res.status(422).json({ ok: false, error: 'vision_device_checks_failed', operation, deviceRun, result: safeReceipt(run.result) }); return; }
      res.json({ ok: true, operation, deviceRun, result: safeReceipt(run.result), ...(asset ? { asset } : {}), ...(vendorArtifact ? { vendorArtifact } : {}), ...(operation==='tuning_export' && typeof run.result.contentBase64==='string' ? {artifact:{ filename:run.result.filename,mimeType:run.result.mimeType,sha256:run.result.sha256,contentBase64:run.result.contentBase64,artifactRole:run.result.artifactRole ?? 'sdk_declared_library' }} : {}) });
    } catch (error) {
      if (!['preview_frame', 'controls_get'].includes(operation)) await service().recordDeviceRun(owner, experimentId, { operation, adapterId: adapter.profile.id, board: adapter.profile.board, sensorVendor: adapter.profile.sensorVendor, sensorModel: adapter.profile.sensorModel, sdkVersion: adapter.profile.sdkVersion, cameraInterface: adapter.profile.cameraInterface, cameraMode: adapter.profile.cameraMode, status: 'failed', evidence: { ...(deviceWriteOperations.has(operation) ? { outcome: 'unconfirmed' as const } : {}), ...(error instanceof VisionDeviceExecutionError ? error.receipt : {}), code: error instanceof VisionWorkshopError ? error.code : 'vision_device_execution_failed' } }).catch(() => undefined);
      throw error;
    }
  });
  router.post(VISION_WORKSHOP_MCP, requireVisionWorkshopAccess, requireOpsMutationGuard, async (req, res) => { try { const response = await handleMcpJsonRpc(req.body, buildVisionWorkshopMcpTools(router, req, res), { name: 'd-obs-vision-workshop', version: '1.0.0' }); if (response) res.json(response); else res.status(202).end(); } catch (error) { failure(res, error); } });
  registerPlatformOperations(router, VISION_WORKSHOP_OPERATIONS);
}
