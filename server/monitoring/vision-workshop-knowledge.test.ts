import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Router } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter } from './observability-access-adapter.js';
import { VisionWorkshopService } from './vision-workshop-service.js';
import { VisionDeviceRegistry, type VisionDeviceProfile } from './vision-workshop-device.js';
import { VISION_KNOWLEDGE_CONTRACT, getVisionCameraKnowledge, searchVisionCameraKnowledge, visionKnowledgeReadiness, summarizeVisionCameraKnowledge, type VisionCameraKnowledge, type VisionKnowledgeReadiness } from './vision-workshop-knowledge.js';
import { registerVisionWorkshopRoutes, VISION_WORKSHOP_API as API, VISION_WORKSHOP_MCP as MCP } from './vision-workshop-routes.js';
import { listPlatformOperations } from './platform-operations.js';
import { VISION_X5_IMX415_KNOWLEDGE } from './vision-workshop-x5-imx415-knowledge.js';

const key = 'x5-yahboom-imx415';
const fixtureProfile: VisionDeviceProfile = { id: 'fixture-native', label: '本地协议 fixture，未实机验证', board: 'RDK X5', sensorModel: 'IMX415', cameraInterface: 'MIPI CSI-2', sdkVersion: 'fixture-sdk', cameraMode: 'fixture-mode', operations: ['probe', 'pipeline_validate', 'bringup', 'capture_raw'] };

test('camera knowledge is searchable across board aliases, Chinese ISP concepts and source-backed facts', () => {
  assert.equal(searchVisionCameraKnowledge({ q: 'imx415', board: 'rdkx5' })[0]?.id, key);
  assert.equal(searchVisionCameraKnowledge({ q: 'ISP', sensorModel: 'imx415' })[0]?.id, key);
  assert.equal(searchVisionCameraKnowledge({ q: '接线' })[0]?.id, key);
  for (const q of ['闪连', 'AX88179B inactive', 'PHY stop state', '-36', '旧 ROS 镜像']) {
    assert.equal(searchVisionCameraKnowledge({ q })[0]?.id, key, q);
  }
  assert.equal(searchVisionCameraKnowledge({ q: 'unknown-camera-model' }).length, 0);
  assert.equal(searchVisionCameraKnowledge({ board: 'RDK S100' }).length, 0);
  assert.equal(getVisionCameraKnowledge('not-a-reviewed-camera'), undefined);
});

test('reviewed knowledge preserves public provenance and cannot mutate its stored record', () => {
  const entry = getVisionCameraKnowledge(key)!;
  assert.deepEqual([entry.verification.documentation, entry.verification.hardware], ['verified', 'unverified']);
  assert.ok(entry.sources.length >= 3);
  const sourceIds = new Set(entry.sources.map(source => source.id));
  for (const fact of entry.facts) { assert.ok(fact.sourceIds.length); for (const id of fact.sourceIds) assert.ok(sourceIds.has(id), id); }
  for (const source of entry.sources) { const url = new URL(source.url); assert.equal(url.protocol, 'https:'); assert.equal(url.username, ''); assert.equal(url.password, ''); }
  assert.doesNotMatch(JSON.stringify(entry), /pfvt|\/Users\/|192\.168\.|Bearer\s|sshpass|token["']?\s*:/i);
  (entry as unknown as { title: string }).title = 'modified caller copy';
  assert.notEqual(getVisionCameraKnowledge(key)!.title, 'modified caller copy');
});

test('X5 v2 knowledge records implemented SDK scope without granting hardware or calibration readiness', () => {
  const entry = VISION_X5_IMX415_KNOWLEDGE;
  assert.equal(entry.version, '2.0.2');
  assert.equal(entry.implementation.nativeAbi, 2);
  assert.equal(entry.implementation.tuningFormat, 'x5-hbn-isp-v2');
  assert.deepEqual([entry.implementation.modules.total, entry.implementation.modules.writableSnapshots, entry.implementation.modules.readonlyObservations], [34, 27, 7]);
  assert.equal(entry.implementation.snapshots.clientNativeBytesAccepted, false);
  assert.equal(entry.implementation.snapshots.privateOpaqueReference, '128bit-server-generated-id');
  assert.equal(entry.implementation.snapshots.modeCompared, true);
  assert.equal(entry.implementation.modules.pointerOrCallbackFields, false);
  assert.deepEqual(entry.implementation.calibration.computations, ['blc', 'lsc', 'ccm', 'awb']);
  assert.equal(entry.implementation.calibration.privateSdkBindingRequired, true);
  assert.equal(entry.implementation.calibration.bindingMissingStatus, 'unavailable');
  assert.equal(entry.implementation.calibration.unexposedLibraryFieldsReadback, 'unverified');
  assert.equal(entry.implementation.replay.timestampSource, 'host_submission');
  assert.equal(entry.implementation.replay.sensorExposureTimestampClaimed, false);
  assert.equal(entry.verification.hardware, 'unverified');
  assert.equal(entry.admission.status, 'not_admitted');
  const prerequisites = entry.implementation.controlPrerequisite;
  assert.match(prerequisites, /modeReadbackEvidence/);
  assert.match(prerequisites, /私有 WB 限值/);
  assert.match(entry.limitations.join(' '), /未公开.*完整有效值读回未验证/);
});

test('new X5 atomic knowledge requires matching adapter operations and preserves missing-binding prerequisites', () => {
  const entry = getVisionCameraKnowledge(key)!;
  const calibration = entry.requiredAtomics.find(atomic => atomic.id === 'calibration')!;
  assert.deepEqual(calibration.operations, ['calibration_apply']);
  assert.match(calibration.prerequisites.join(' '), /私有 SDK binding/);
  assert.match(calibration.notes || '', /缺 binding 返回 unavailable/);
  const readiness = visionKnowledgeReadiness(entry, [fixtureProfile]);
  assert.equal(readiness.atomics.find(atomic => atomic.id === 'calibration')!.status, 'unavailable');
  assert.equal(readiness.atomics.find(atomic => atomic.id === 'process_raw')!.status, 'unavailable');
  assert.equal(readiness.hardwareVerification, 'unverified');
});

test('team experience is searchable, immutable and separately attributed without granting device readiness', () => {
  for (const q of ['USB 最小闭环', 'SC835HAI', '3.3.3 1.0.17', 'Tuning guide 雾感', '专家 Skill', '标定 warning', '全志']) {
    assert.equal(searchVisionCameraKnowledge({ q })[0]?.id, key, q);
  }
  const entry = getVisionCameraKnowledge(key)!;
  assert.equal(entry.teamExperience.provenance.kind, 'user_reported');
  assert.equal(entry.teamExperience.provenance.independentlyVerified, false);
  assert.equal(entry.verification.hardware, 'unverified');
  assert.equal(entry.admission.status, 'not_admitted');
  assert.equal(visionKnowledgeReadiness(entry, []).status, 'adapter_unavailable');
  const summary = summarizeVisionCameraKnowledge(entry, []);
  assert.equal(summary.teamExperience.provenance.kind, 'user_reported');
  assert.equal(summary.teamExperience.topicCount, 9);
  assert.equal(Object.hasOwn(summary.teamExperience, 'entries'), false);
  entry.teamExperience.entries[0].guidance = 'caller mutation';
  assert.notEqual(getVisionCameraKnowledge(key)!.teamExperience.entries[0].guidance, 'caller mutation');
});

test('matching sensor labels on a USB adapter cannot enable native MIPI or ISP knowledge requirements', () => {
  const entry = getVisionCameraKnowledge(key)!;
  for (const profiles of [[], [{ ...fixtureProfile, cameraInterface: 'USB UVC' }], [{ ...fixtureProfile, cameraInterface: undefined }], [{ ...fixtureProfile, board: 'RDK S100' }]]) {
    const readiness = visionKnowledgeReadiness(entry, profiles);
    assert.equal(readiness.status, 'adapter_unavailable');
    assert.equal(readiness.hardwareVerification, 'unverified');
    assert.equal(readiness.adapters.length, 0);
    assert.ok(readiness.atomics.filter(atomic => atomic.status !== 'manual_required').every(atomic => atomic.status === 'unavailable'));
  }
});

test('configured adapters stay unverified and requirements cannot combine operations across two devices', () => {
  const entry = getVisionCameraKnowledge(key)!;
  const required = entry.requiredAtomics.find(atomic => atomic.operations.length > 1);
  assert.ok(required, 'At least one native atomic group must require a complete chain');
  const operations = [...required.operations];
  const profiles: VisionDeviceProfile[] = [{ ...fixtureProfile, operations: [operations[0]] }, { ...fixtureProfile, id: 'fixture-second', operations: operations.slice(1) }];
  const incomplete = visionKnowledgeReadiness(entry, profiles);
  assert.equal(incomplete.status, 'configured_unverified');
  assert.equal(incomplete.atomics.find(atomic => atomic.id === required.id)!.status, 'unavailable');
  assert.ok(incomplete.atomics.find(atomic => atomic.id === required.id)!.missingOperations.length > 0);
  const complete = visionKnowledgeReadiness(entry, [{ ...fixtureProfile, operations }]);
  assert.equal(complete.atomics.find(atomic => atomic.id === required.id)!.status, 'configured_unverified');
  assert.equal(complete.hardwareVerification, 'unverified');
});

let server: Server;
let origin: string;
let dir: string;
let router: Router;
let savedAdmin: string | undefined;
let savedUsers: string | undefined;
let registry: VisionDeviceRegistry;
let deviceCalls: number;
let serviceCalls: number;
beforeEach(async () => {
  savedAdmin = process.env.RDK_CREDITS_ADMIN_TOKEN; savedUsers = process.env.RDK_FLYWHEEL_ADMIN_USER_IDS;
  process.env.RDK_CREDITS_ADMIN_TOKEN = 'knowledge-fixture-admin'; process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = 'knowledge-reviewer';
  configureObservabilityAccess({ getSessionSsoUser: req => req.header('x-fixture-user') ? { id: req.header('x-fixture-user')!, email: 'fixture@example.invalid' } : null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  dir = await mkdtemp(join(tmpdir(), 'd-obs-camera-knowledge-')); const service = new VisionWorkshopService({ dataDir: dir });
  deviceCalls = 0; serviceCalls = 0; registry = new VisionDeviceRegistry([]);
  const app = express(); app.use(express.json()); router = express.Router();
  registerVisionWorkshopRoutes(router, { getService: () => { serviceCalls++; return service; }, getDevices: () => registry, modelEnabled: () => false });
  app.use('/dobs', router); server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}/dobs`;
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (dir) await rm(dir, { recursive: true, force: true });
  if (savedAdmin === undefined) delete process.env.RDK_CREDITS_ADMIN_TOKEN; else process.env.RDK_CREDITS_ADMIN_TOKEN = savedAdmin;
  if (savedUsers === undefined) delete process.env.RDK_FLYWHEEL_ADMIN_USER_IDS; else process.env.RDK_FLYWHEEL_ADMIN_USER_IDS = savedUsers;
  resetObservabilityAccessAdapter();
});
const auth = { 'x-fixture-user': 'knowledge-reviewer' };
const httpGet = (suffix: string, headers: Record<string, string> = auth) => fetch(origin + API + suffix, { headers });
type IndexPayload = { contract: string; entries: Array<ReturnType<typeof summarizeVisionCameraKnowledge>> };
type DetailPayload = { knowledge: VisionCameraKnowledge; readiness: VisionKnowledgeReadiness };
type McpPayload = { result: { isError: boolean; content: Array<{ text: string }> } };
async function mcp(name: string, args: Record<string, unknown>): Promise<McpPayload> {
  const response = await fetch(origin + MCP, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-rdk-ops-action': 'observability', 'x-rdk-ops-read-only': '1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(response.status, 200); return response.json() as Promise<McpPayload>;
}

test('protected HTTP knowledge reads share provenance and maturity without running hardware or creating experiments', async () => {
  const indexResponse = await httpGet('/knowledge?q=IMX415&board=RDK%20X5'); assert.equal(indexResponse.status, 200);
  const index = await indexResponse.json() as IndexPayload; assert.equal(index.contract, VISION_KNOWLEDGE_CONTRACT); assert.equal(index.entries[0].id, key);
  assert.equal(index.entries[0].readiness.status, 'adapter_unavailable');
  assert.equal(index.entries[0].teamExperience.provenance.independentlyVerified, false);
  const detailResponse = await httpGet('/knowledge/' + key); assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as DetailPayload; assert.equal(detail.knowledge.id, key); assert.equal(detail.knowledge.verification.hardware, 'unverified');
  // Search is a compact index; get must retain the complete diagnosis and dated evidence.
  assert.equal(Object.hasOwn(index.entries[0], 'diagnosticCases'), false);
  assert.deepEqual(detail.knowledge.diagnosticCases, VISION_X5_IMX415_KNOWLEDGE.diagnosticCases);
  assert.deepEqual(detail.knowledge.historicalObservations, VISION_X5_IMX415_KNOWLEDGE.historicalObservations);
  assert.deepEqual(detail.knowledge.teamExperience, VISION_X5_IMX415_KNOWLEDGE.teamExperience);
  assert.equal(detail.knowledge.vendorPrerequisites.legacyImageIdentityRequired, true);
  assert.equal(detail.knowledge.vendorPrerequisites.legacyCommandUpgradeScope, 'vendor_documented_old_ros_images_only');
  assert.equal(detail.knowledge.admission.status, 'not_admitted');
  assert.equal(detail.readiness.status, 'adapter_unavailable'); assert.equal(serviceCalls, 0);
  registry = new VisionDeviceRegistry([{ profile: fixtureProfile, execute: async () => { deviceCalls++; throw new Error('knowledge read must not execute device'); } }]);
  const configured = await (await httpGet('/knowledge/' + key)).json() as DetailPayload;
  assert.equal(configured.readiness.status, 'configured_unverified'); assert.equal(configured.readiness.hardwareVerification, 'unverified'); assert.equal(deviceCalls, 0); assert.equal(serviceCalls, 0);
});

test('knowledge preserves existing access and rejects ambiguous queries or unknown records', async () => {
  assert.ok([401, 403].includes((await httpGet('/knowledge', {})).status));
  assert.equal((await httpGet('/knowledge', { 'x-fixture-user': 'non-admin' })).status, 403);
  assert.equal((await httpGet('/knowledge?q=a&q=b')).status, 400);
  assert.equal((await httpGet('/knowledge?host=untrusted.invalid')).status, 400);
  assert.equal((await httpGet('/knowledge?q=' + 'a'.repeat(161))).status, 400);
  const missing = await httpGet('/knowledge/not-reviewed'); assert.equal(missing.status, 404); assert.equal((await missing.json() as { error: string }).error, 'vision_knowledge_not_found');
  assert.equal((await httpGet('/knowledge?board=RDK%20S100')).status, 200);
  assert.equal(serviceCalls, 0);
});

test('platform assistant operations and typed MCP knowledge tools use the same read-only handlers', async () => {
  const declarations = listPlatformOperations(router).filter(operation => operation.path.includes('/knowledge'));
  assert.equal(declarations.length, 2); assert.ok(declarations.every(operation => !operation.mutating && !operation.tenantAccessible));
  const searched = await mcp('vision_camera_knowledge_search', { q: 'ISP IMX415' }); assert.equal(searched.result.isError, false);
  const index = JSON.parse(searched.result.content[0].text).data; assert.equal(index.entries[0].id, key);
  const fetched = await mcp('vision_camera_knowledge_get', { knowledgeId: key }); assert.equal(fetched.result.isError, false);
  const detail = JSON.parse(fetched.result.content[0].text).data; assert.equal(detail.knowledge.id, key); assert.equal(detail.readiness.status, 'adapter_unavailable');
  assert.equal(detail.knowledge.teamExperience.provenance.kind, 'user_reported');
  const experienceSearch = await mcp('vision_camera_knowledge_search', { q: 'SC835HAI' });
  assert.equal(JSON.parse(experienceSearch.result.content[0].text).data.entries[0].teamExperience.provenance.independentlyVerified, false);
  const generic = await mcp('vision_workshop_execute', { operationId: 'GET ' + API + '/knowledge', query: { sensorModel: 'IMX415' } }); assert.equal(generic.result.isError, false);
  const invalid = await mcp('vision_camera_knowledge_get', { knowledgeId: key, command: 'untrusted' }); assert.equal(invalid.result.isError, true);
  assert.equal(deviceCalls, 0); assert.equal(serviceCalls, 0);
});
