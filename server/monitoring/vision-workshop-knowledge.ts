import type { VisionDeviceOperation, VisionDeviceProfile } from './vision-workshop-device.js';
import { VISION_X5_IMX415_KNOWLEDGE } from './vision-workshop-x5-imx415-knowledge.js';

export const VISION_KNOWLEDGE_CONTRACT = 'rdk.vision-knowledge.v1';
export const VISION_CAMERA_KNOWLEDGE = [VISION_X5_IMX415_KNOWLEDGE] as const;
export type VisionCameraKnowledge = typeof VISION_CAMERA_KNOWLEDGE[number];
export type VisionKnowledgeQuery = { q?: string; board?: string; sensorModel?: string };
export type VisionKnowledgeReadiness = {
  status: 'adapter_unavailable' | 'configured_unverified';
  reason: string;
  hardwareVerification: 'unverified';
  adapters: Array<Pick<VisionDeviceProfile, 'id' | 'label' | 'sdkVersion' | 'cameraMode'>>;
  atomics: Array<{ id: string; status: 'unavailable' | 'configured_unverified' | 'manual_required'; missingOperations: VisionDeviceOperation[] }>;
};

const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** A reviewed document is searchable knowledge, never a configured device adapter. */
export function searchVisionCameraKnowledge(query: VisionKnowledgeQuery = {}): VisionCameraKnowledge[] {
  const terms = (query.q ?? '').trim().split(/\s+/).filter(Boolean).map(normalized);
  return VISION_CAMERA_KNOWLEDGE.filter(entry => {
    if (query.board && !normalized(entry.target.board).includes(normalized(query.board))) return false;
    if (query.sensorModel && !normalized(entry.target.sensorModel).includes(normalized(query.sensorModel))) return false;
    const corpus = normalized(JSON.stringify(entry));
    return terms.every(term => corpus.includes(term));
  }).map(entry => structuredClone(entry));
}

export function getVisionCameraKnowledge(id: string): VisionCameraKnowledge | undefined {
  const entry = VISION_CAMERA_KNOWLEDGE.find(item => item.id === id);
  return entry ? structuredClone(entry) : undefined;
}

/** Read-only registry inspection: do not execute probe or compose operations across devices. */
export function visionKnowledgeReadiness(entry: VisionCameraKnowledge, profiles: readonly VisionDeviceProfile[]): VisionKnowledgeReadiness {
  const matching = profiles.filter(profile => normalized(profile.board) === normalized(entry.target.board)
    && normalized(profile.sensorModel) === normalized(entry.target.sensorModel)
    && normalized(profile.cameraInterface ?? '') === normalized(entry.target.cameraInterface));
  const atomics: VisionKnowledgeReadiness['atomics'] = entry.requiredAtomics.map(atomic => {
    const operations: readonly VisionDeviceOperation[] = atomic.operations;
    if (!operations.length) return { id: atomic.id, status: 'manual_required', missingOperations: [] };
    const supported = matching.some(profile => operations.every(operation => profile.operations.includes(operation)));
    // Report the closest single adapter's gaps. Combining two adapters would imply a false executable chain.
    const gaps = matching.map(profile => operations.filter(operation => !profile.operations.includes(operation)))
      .sort((a, b) => a.length - b.length)[0] ?? [...operations];
    return { id: atomic.id, status: supported ? 'configured_unverified' : 'unavailable', missingOperations: [...gaps] };
  });
  return {
    status: matching.length ? 'configured_unverified' : 'adapter_unavailable',
    reason: matching.length ? '仅发现板型、Sensor 与接口匹配的适配器配置；SDK、模式、实际执行及画质仍需本次实机回执确认。' : '尚未配置板型、Sensor 与 MIPI 接口匹配的原生适配器；知识入库不启用设备操作。',
    hardwareVerification: 'unverified',
    adapters: matching.map(({ id, label, sdkVersion, cameraMode }) => ({ id, label, sdkVersion, ...(cameraMode ? { cameraMode } : {}) })),
    atomics,
  };
}

export function summarizeVisionCameraKnowledge(entry: VisionCameraKnowledge, profiles: readonly VisionDeviceProfile[]) {
  return { id: entry.id, title: entry.title, summary: entry.summary, target: entry.target, version: entry.version,
    reviewDate: entry.reviewDate, verification: entry.verification, sourceCount: entry.sources.length,
    teamExperience: { provenance: entry.teamExperience.provenance, reportedOn: entry.teamExperience.reportedOn, topicCount: entry.teamExperience.entries.length },
    atomicCount: entry.requiredAtomics.length, readiness: visionKnowledgeReadiness(entry, profiles) };
}
