/** Bounded, request-authorized camera orchestration over the existing atomic SDK contract. */
import { createHash, randomUUID } from 'node:crypto';
import { VisionDeviceExecutionError, VisionDeviceRegistry, validateVisionCameraControls, validateVisionControlValues, type VisionCameraControls, type VisionDeviceContext, type VisionDeviceOperation } from './vision-workshop-device.js';
import { VisionWorkshopService, VisionWorkshopError, imageDimensions, type VisionCameraFrame, type VisionCameraIdentity, type VisionJsonObject } from './vision-workshop-service.js';
import { analyzeVisionProcessedPng, prepareVisionModelPng, type VisionOutputStatistics } from './vision-workshop-quality.js';
import { planVisionCameraDebug, type VisionAiDebugDecision, type VisionAiDebugInput, type VisionAiDebugImage } from './vision-workshop-ai-model.js';
import { VISION_WORKSHOP_API } from './vision-workshop-operations.js';
import { VISION_AI_DEBUG_REQUIRED_OPERATIONS } from './vision-workshop-experience.js';
import { visionRecoveryStatus } from './vision-workshop-readiness.js';
import { validateVisionBaseline, validateVisionIspPatches, type VisionNumericRule, type VisionIspPatch } from './vision-workshop-model.js';

export interface VisionAiDebugObservation {
  frameId: string; frameHash: string; controls: VisionCameraControls; statistics: VisionOutputStatistics; tuningHash: string; modelPreview?: VisionAiDebugImage['provenance'];
}
export interface VisionAiDebugSnapshot {
  controls: VisionCameraControls; tuning: VisionJsonObject; rules?: VisionNumericRule[]; hash: string; frameId?: string; frameHash?: string; iteration?: number; reason?: string; assessment?: VisionAiDebugDecision['assessment'];
}
export interface VisionAiDebugIteration {
  index: number; source: 'model'; model: string; modelInput: 'camera_images_controls_and_history'; tool: 'camera_debug_decision'; validationWarnings?: string[]; action: VisionAiDebugDecision['action']; notes: string;
  assessment: VisionAiDebugDecision['assessment']; before: VisionAiDebugObservation;
  requestedValues?: Record<string, number | boolean>; requestedPatches?: VisionIspPatch[]; readback?: VisionCameraControls; readbackHash?: string; after?: VisionAiDebugObservation; createdAt: string;
}
export interface VisionAiDebugRun {
  id: string; source: 'model'; tool: 'camera_debug_decision'; status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  goal: string; maxRounds: number; adjustmentCount: number; iterations: VisionAiDebugIteration[];
  operations: Array<{ operationId: string; jobId?: string; status: 'completed' | 'failed'; receipt?: Record<string, unknown>; error?: string; createdAt: string }>;
  original?: VisionAiDebugSnapshot; best?: VisionAiDebugSnapshot;
  final?: { controls: VisionCameraControls; frameId?: string; frameHash?: string; restored: boolean; reason: string; hash?: string; imageError?: string; streamVerification?: 'verified' | 'unverified' | 'failed'; visualVerification: 'unverified' };
  cancelRequested: boolean; stopReason?: string; error?: string; restorationError?: string; goalSatisfied?: boolean;
  createdAt: string; updatedAt: string; completedAt?: string;
}
export type VisionAiDebugPlanner = (input: VisionAiDebugInput) => Promise<VisionAiDebugDecision>;
const running = new Map<string, AbortController>();
const requiredOperations: readonly VisionDeviceOperation[] = VISION_AI_DEBUG_REQUIRED_OPERATIONS;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const code = (error: unknown) => error instanceof VisionWorkshopError ? error.code : error instanceof Error && /^vision_[a-z0-9_]+$/.test(error.message) ? error.message : 'vision_ai_debug_operation_failed';
const timestamp = () => new Date().toISOString();
const receipt = (result: Record<string, unknown>) => { const out = { ...result }; delete out.contentBase64; return out; };
const failureReceipt = (error: unknown) => error instanceof VisionDeviceExecutionError ? { receipt: { ...error.receipt } } : {};

export class VisionAiDebugManager {
  constructor(private service: VisionWorkshopService, private devices: VisionDeviceRegistry, private planner: VisionAiDebugPlanner = planVisionCameraDebug) {}

  async get(owner: string, experimentId: string, runId: string): Promise<VisionAiDebugRun> {
    const run = await this.service.readAiDebugRun(owner, experimentId, runId);
    if (['queued', 'running'].includes(run.status) && !running.has(run.id)) {
      run.status = 'interrupted'; run.stopReason = 'process_interrupted_restoration_unconfirmed';
      await this.service.saveAiDebugRun(owner, experimentId, run);
    }
    return run;
  }

  async list(owner: string, experimentId: string): Promise<VisionAiDebugRun[]> {
    const runs = await this.service.listAiDebugRuns(owner, experimentId);
    return Promise.all(runs.map(run => this.get(owner, experimentId, run.id)));
  }

  async start(owner: string, experimentId: string, goal: string, maxRounds = 4): Promise<VisionAiDebugRun> {
    if (!goal.trim() || goal.length > 2000 || !Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 6) throw new VisionWorkshopError('vision_ai_debug_input_invalid', 'Supply a goal and 1–6 adjustment rounds');
    const experiment = await this.service.getExperiment(owner, experimentId);
    experiment.aiDebugRuns = await this.list(owner, experimentId);
    if (visionRecoveryStatus(experiment).status === 'unconfirmed') throw new VisionWorkshopError('vision_ai_debug_recovery_required', 'Confirm restoration of the previous original configuration before starting another AI run', 409);
    if (!experiment.targetId || !experiment.board || !experiment.sensorModel || !experiment.sdkVersion) throw new VisionWorkshopError('vision_device_adapter_required', 'Bind a real camera profile before AI debug', 409);
    const profile = this.devices.get(experiment.targetId).profile;
    if (!requiredOperations.filter(operation => operation !== 'controls_set').every(operation => profile.operations.includes(operation))
      || !profile.operations.some(operation => operation === 'controls_set' || operation === 'apply_tuning')) throw new VisionWorkshopError('vision_ai_debug_atomic_unavailable', 'AI debug requires probe, actual controls, a supported write operation, frame capture and verified restoration', 503);
    const session = this.devices.acquireSession(experiment.targetId);
    const context: Omit<VisionDeviceContext, 'jobId'> = { experimentId, board: experiment.board, sensorModel: experiment.sensorModel, sdkVersion: experiment.sdkVersion, sensorVendor: experiment.sensorVendor, cameraInterface: experiment.cameraInterface, cameraMode: experiment.cameraMode };
    const now = timestamp();
    const run: VisionAiDebugRun = { id: randomUUID(), source: 'model', tool: 'camera_debug_decision', status: 'queued', goal: goal.trim(), maxRounds, adjustmentCount: 0, iterations: [], operations: [], cancelRequested: false, createdAt: now, updatedAt: now };
    const controller = new AbortController(); running.set(run.id, controller);
    try { await this.service.saveAiDebugRun(owner, experimentId, run); }
    catch (error) { running.delete(run.id); session.release(); throw error; }
    // Capture the authenticated identity once. Background execution never reconstructs anonymous authority.
    void this.execute(owner, experimentId, run, context, { board: experiment.board, sensorModel: experiment.sensorModel, sdkVersion: experiment.sdkVersion, sensorVendor: experiment.sensorVendor, cameraInterface: experiment.cameraInterface, cameraMode: experiment.cameraMode }, session, controller).catch(() => undefined);
    return structuredClone(run);
  }

  async cancel(owner: string, experimentId: string, runId: string): Promise<VisionAiDebugRun> {
    const run = await this.service.readAiDebugRun(owner, experimentId, runId);
    if (['queued', 'running'].includes(run.status)) {
      run.cancelRequested = true; await this.service.saveAiDebugRun(owner, experimentId, run);
      running.get(run.id)?.abort('user_cancel');
      if (!running.has(run.id)) { run.status = 'interrupted'; run.stopReason = 'process_interrupted_restoration_unconfirmed'; await this.service.saveAiDebugRun(owner, experimentId, run); }
    }
    return run;
  }

  async restoreOriginal(owner: string, experimentId: string, runId: string): Promise<VisionAiDebugRun> {
    const run = await this.service.readAiDebugRun(owner, experimentId, runId);
    if (['queued', 'running'].includes(run.status) || !run.original) throw new VisionWorkshopError('vision_ai_debug_restore_unavailable', 'Wait for the run to finish before restoring its original snapshot', 409);
    const experiment = await this.service.getExperiment(owner, experimentId);
    if (!experiment.targetId || !experiment.board || !experiment.sensorModel || !experiment.sdkVersion) throw new VisionWorkshopError('vision_device_adapter_required', 'Original camera profile is unavailable', 409);
    const session = this.devices.acquireSession(experiment.targetId);
    try {
      const context = { experimentId, board: experiment.board, sensorModel: experiment.sensorModel, sdkVersion: experiment.sdkVersion, sensorVendor: experiment.sensorVendor, cameraInterface: experiment.cameraInterface, cameraMode: experiment.cameraMode };
      delete run.final; run.goalSatisfied = false;
      run.restorationError = 'vision_ai_debug_restoration_pending'; run.stopReason = 'restoration_unconfirmed'; run.updatedAt = timestamp();
      await this.service.saveAiDebugRun(owner, experimentId, run);
      const result = await session.execute('restore_tuning', context, { tuning: run.original.tuning, tuningHash: run.original.hash });
      if (result.result.appliedHash !== run.original.hash || result.result.readbackHash !== run.original.hash) throw new VisionWorkshopError('vision_device_readback_mismatch', 'Original configuration restoration was not confirmed', 502);
      const actual = await session.execute('controls_get', context, {});
      run.final = { controls: validateVisionCameraControls(actual.result.controls), restored: true, streamVerification: 'unverified', visualVerification: 'unverified', reason: 'operator_restored_original', hash: run.original.hash };
      run.operations.push({ operationId: 'POST ' + VISION_WORKSHOP_API + '/experiments/:id/device/restore_tuning', jobId: result.jobId, status: 'completed', receipt: receipt(result.result), createdAt: timestamp() });
      run.operations.push({ operationId: 'POST ' + VISION_WORKSHOP_API + '/experiments/:id/device/controls_get', jobId: actual.jobId, status: 'completed', createdAt: timestamp() });
      delete run.restorationError;
      run.goalSatisfied = Boolean(run.original.assessment?.goalSatisfied && run.original.assessment.sceneUsable && !run.original.assessment.regressions?.length);
      try {
        let captured: Awaited<ReturnType<typeof session.execute>>;
        try { captured = await session.execute('capture_frame', context, { scene: '人工恢复后的实际现场' }); }
        catch (deviceError) {
          run.final.streamVerification = 'failed';
          run.operations.push({ operationId: 'POST ' + VISION_WORKSHOP_API + '/experiments/:id/device/capture_frame', status: 'failed', error: code(deviceError), ...failureReceipt(deviceError), createdAt: timestamp() });
          throw deviceError;
        }
        const archived = await this.archiveCapture(owner, experimentId, captured, '人工恢复后的实际现场');
        if (archived.observation.tuningHash !== run.original.hash) throw new VisionWorkshopError('vision_ai_debug_snapshot_changed', 'Camera changed after restoring original configuration', 409);
        run.final.controls = archived.observation.controls; run.final.frameId = archived.observation.frameId; run.final.frameHash = archived.observation.frameHash; run.final.streamVerification = 'verified';
        run.operations.push({ operationId: 'POST ' + VISION_WORKSHOP_API + '/experiments/:id/device/capture_frame', jobId: captured.jobId, status: 'completed', receipt: { frameId: archived.observation.frameId }, createdAt: timestamp() });
      } catch (imageError) {
        run.final.imageError = code(imageError);
        if (run.final.streamVerification === 'failed' || imageError instanceof VisionWorkshopError && imageError.code === 'vision_ai_debug_snapshot_changed') throw imageError;
      }
      run.stopReason = 'operator_restored_original'; run.updatedAt = timestamp();
      await this.service.saveAiDebugRun(owner, experimentId, run); return run;
    } catch (error) {
      run.restorationError = code(error); run.updatedAt = timestamp();
      run.goalSatisfied = false;
      run.operations.push({ operationId: 'POST ' + VISION_WORKSHOP_API + '/experiments/:id/ai-debug/runs/' + run.id + '/restore-original', status: 'failed', error: code(error), ...failureReceipt(error), createdAt: timestamp() });
      await this.service.saveAiDebugRun(owner, experimentId, run).catch(() => undefined);
      throw error;
    } finally { session.release(); }
  }

  private async archiveCapture(owner: string, experimentId: string, captured: Awaited<ReturnType<VisionDeviceRegistry['execute']>>, scene: string): Promise<{ observation: VisionAiDebugObservation; image: VisionAiDebugImage }> {
    const result = captured.result;
    const bytes = typeof result.contentBase64 === 'string' ? Buffer.from(result.contentBase64, 'base64') : Buffer.alloc(0);
    if (!bytes.length || bytes.length > this.service.capabilities().limits.maxImageBytes || bytes.toString('base64') !== result.contentBase64 || hash(bytes) !== result.sha256 || result.mimeType !== 'image/png') throw new VisionWorkshopError('vision_ai_debug_frame_invalid', 'AI debug requires actual hashed PNG camera pixels', 502);
    imageDimensions(bytes, 'image/png');
    if (typeof result.tuningHash !== 'string' || !/^[a-f0-9]{64}$/.test(result.tuningHash)) throw new VisionWorkshopError('vision_ai_debug_snapshot_required', 'Capture must report its actual full configuration hash', 502);
    const controls = validateVisionCameraControls(result.controls);
    const frame: VisionCameraFrame = await this.service.addCameraFrame(owner, experimentId, { filename: typeof result.filename === 'string' ? result.filename : undefined, mimeType: 'image/png', adapterId: captured.profile.id, controls, scene, tuningHash: result.tuningHash, ...(typeof result.capturedAt === 'string' ? { capturedAt: result.capturedAt } : {}) }, bytes);
    const preview = prepareVisionModelPng(bytes);
    const { data: previewBytes, ...provenance } = preview;
    if (provenance.sourceSha256 !== frame.hash) throw new VisionWorkshopError('vision_ai_debug_frame_invalid', 'Model preview is not bound to its archived source frame', 502);
    const observation = { frameId: frame.id, frameHash: frame.hash, controls, statistics: analyzeVisionProcessedPng(bytes), tuningHash: result.tuningHash, modelPreview: provenance };
    return { observation, image: { mimeType: 'image/png', contentBase64: previewBytes.toString('base64'), provenance } };
  }

  private async execute(owner: string, experimentId: string, run: VisionAiDebugRun, context: Omit<VisionDeviceContext, 'jobId'>, cameraContext: VisionCameraIdentity,
    session: ReturnType<VisionDeviceRegistry['acquireSession']>, controller: AbortController): Promise<void> {
    const deadline = setTimeout(() => controller.abort('run_budget'), 10 * 60_000);
    let restorationAttempted = false;
    const save = async () => { run.updatedAt = timestamp(); await this.service.saveAiDebugRun(owner, experimentId, run); };
    const check = () => { if (controller.signal.aborted) throw new Error(controller.signal.reason === 'run_budget' ? 'vision_ai_debug_time_budget' : 'vision_ai_debug_canceled'); };
    const atom = async (operation: VisionDeviceOperation, inputs: Record<string, unknown>, durable = true) => {
      const operationId = 'POST ' + VISION_WORKSHOP_API + '/experiments/:id/device/' + operation;
      try {
        const result = await session.execute(operation, context, inputs);
        if (operation === 'probe' && (!result.result.facts || typeof result.result.facts !== 'object' || !Object.keys(result.result.facts as object).length)) throw new VisionWorkshopError('vision_device_invalid_receipt', 'Probe needs actual facts', 502);
        if (['apply_tuning', 'restore_tuning'].includes(operation) && (result.result.appliedHash !== inputs.tuningHash || result.result.readbackHash !== inputs.tuningHash)) throw new VisionWorkshopError('vision_device_readback_mismatch', 'Full configuration application or restoration was not confirmed', 502);
        if (durable) {
          run.operations.push({ operationId, jobId: result.jobId, status: 'completed', receipt: receipt(result.result), createdAt: timestamp() });
          await save();
          if (operation !== 'controls_get') await this.service.recordDeviceRun(owner, experimentId, { operation, adapterId: result.profile.id, ...Object.fromEntries(Object.entries(cameraContext).filter(([, value]) => value !== undefined)), sensorModel: context.sensorModel, status: 'completed', evidence: { aiDebugRunId: run.id, jobId: result.jobId, result: receipt(result.result) as VisionJsonObject } });
        }
        return result;
      } catch (error) {
        run.operations.push({ operationId, status: 'failed', error: code(error), ...failureReceipt(error), createdAt: timestamp() }); await save(); throw error;
      }
    };
    const snapshot = async (): Promise<VisionAiDebugSnapshot> => {
      const probed = await atom('probe', {});
      const facts = probed.result.facts as Record<string, unknown>;
      // An adapter journal may outlive every AI run. Its unresolved device
      // state must not become a newly accepted original snapshot.
      if (facts.cleanupRequired === true) throw new VisionWorkshopError('camera_stream_cleanup_required', 'Stop and clean up the failed camera stream before saving an AI original snapshot', 409);
      if (facts.writeOutcome === 'unconfirmed') throw new VisionWorkshopError('isp_write_unconfirmed_restore_required', 'Restore the existing saved configuration before accepting a new AI original snapshot', 409);
      const baseline = probed.result.baseline as { config?: unknown; rules?: unknown } | undefined;
      if (!baseline?.config || typeof baseline.config !== 'object' || Array.isArray(baseline.config)) throw new VisionWorkshopError('vision_ai_debug_snapshot_required', 'Adapter must expose an actual restorable configuration snapshot', 409);
      const native = (baseline.config as Record<string, unknown>).kind === 'x5-hbn-isp-v2';
      // Native ISP qualification is supplied by the actual adapter snapshot.
      // Flat controls cannot substitute for missing module rules or apply support.
      if (native && (!probed.profile.operations.includes('apply_tuning') || !Array.isArray(baseline.rules) || !baseline.rules.length)) throw new VisionWorkshopError('vision_ai_debug_native_isp_unavailable', 'Native AI debug requires actual qualified numeric rules and apply_tuning', 503);
      if (!native && !probed.profile.operations.includes('controls_set')) throw new VisionWorkshopError('vision_ai_debug_atomic_unavailable', 'This controls adapter does not support controls_set', 503);
      const validated = native ? validateVisionBaseline(baseline.config, baseline.rules) : undefined;
      const controls = validateVisionCameraControls((await atom('controls_get', {})).result.controls);
      const tuning = (validated?.tuning ?? JSON.parse(JSON.stringify(baseline.config))) as VisionJsonObject;
      if (run.original?.rules && (!validated || JSON.stringify(validated.rules) !== JSON.stringify(run.original.rules))) throw new VisionWorkshopError('vision_ai_debug_snapshot_changed', 'Qualified ISP rules changed during the run', 409);
      return { controls, tuning, ...(validated ? { rules: validated.rules } : {}), hash: hash(JSON.stringify(tuning)) };
    };
    const capture = async (scene: string, allowAfterCancel = false, onDeviceFailure?: () => void): Promise<{ observation: VisionAiDebugObservation; image: VisionAiDebugImage }> => {
      if (!allowAfterCancel) check();
      let captured: Awaited<ReturnType<typeof atom>>;
      try { captured = await atom('capture_frame', { scene }, false); }
      catch (error) { onDeviceFailure?.(); throw error; }
      const result = captured.result;
      const { observation, image } = await this.archiveCapture(owner, experimentId, captured, scene);
      run.operations.push({ operationId: 'POST ' + VISION_WORKSHOP_API + '/experiments/:id/device/capture_frame', jobId: captured.jobId, status: 'completed', receipt: { ...receipt(result), frameId: observation.frameId }, createdAt: timestamp() }); await save();
      return { observation, image };
    };
    const restore = async (target: VisionAiDebugSnapshot, reason: string) => {
      // A failed restart/readback is uncertain; do not replay a second restore in
      // the outer error handler. Recovery must be an explicit subsequent action.
      restorationAttempted = true;
      try {
        delete run.final;
        await atom('restore_tuning', { tuning: target.tuning, tuningHash: target.hash });
        const actual = validateVisionCameraControls((await atom('controls_get', {})).result.controls);
        run.final = { controls: actual, restored: target.hash === run.original?.hash, streamVerification: 'unverified', visualVerification: 'unverified', reason, hash: target.hash };
        try {
          const finalFrame = await capture('AI 调试最终现场', true, () => { run.final!.streamVerification = 'failed'; });
          if (finalFrame.observation.tuningHash !== target.hash) throw new VisionWorkshopError('vision_ai_debug_snapshot_changed', 'Camera changed after selecting its final configuration', 409);
          run.final.controls = finalFrame.observation.controls; run.final.frameId = finalFrame.observation.frameId; run.final.frameHash = finalFrame.observation.frameHash; run.final.streamVerification = 'verified';
        } catch (imageError) {
          run.final.imageError = code(imageError);
          if (run.final.streamVerification === 'failed' || imageError instanceof VisionWorkshopError && imageError.code === 'vision_ai_debug_snapshot_changed') throw imageError;
        }
      } catch (restoreError) {
        run.restorationError = code(restoreError); run.goalSatisfied = false;
        throw restoreError;
      }
    };
    try {
      run.status = 'running'; await save(); check();
      run.original = await snapshot(); await save();
      let currentSnapshot = run.original;
      let current = await capture('AI 调试前现场');
      if (current.observation.tuningHash !== run.original.hash) throw new VisionWorkshopError('vision_ai_debug_snapshot_changed', 'Camera changed between original snapshot and capture', 409);
      run.original.frameId = current.observation.frameId; run.original.frameHash = current.observation.frameHash;
      run.best = structuredClone(run.original); run.best.reason = 'original_scene';
      const originalImage = current.image; let bestImage = current.image;
      await save();
      for (let index = 0; index <= run.maxRounds; index++) {
        check(); const assessmentOnly = run.adjustmentCount >= run.maxRounds;
        const decision = await this.planner({ goal: run.goal, round: index + 1, maxRounds: run.maxRounds, controls: current.observation.controls, cameraContext,
          ...(currentSnapshot.rules ? { tuning: { config: structuredClone(currentSnapshot.tuning), rules: structuredClone(currentSnapshot.rules) } } : {}),
          originalImage, currentImage: current.image, bestImage, currentStatistics: current.observation.statistics, history: run.iterations.map(item => ({ index: item.index, action: item.action, notes: item.notes, assessment: item.assessment, requestedValues: item.requestedValues, requestedPatches: item.requestedPatches, readbackHash: item.readbackHash, before: { frameId: item.before.frameId, frameHash: item.before.frameHash, statistics: item.before.statistics }, ...(item.after ? { after: { frameId: item.after.frameId, frameHash: item.after.frameHash, statistics: item.after.statistics } } : {}) })), assessmentOnly, signal: controller.signal });
        check();
        if (decision.source !== 'model' || decision.modelInput !== 'camera_images_controls_and_history' || !decision.model || !['adjust', 'keep', 'restore', 'stop'].includes(decision.action) || assessmentOnly && decision.action === 'adjust') throw new VisionWorkshopError('vision_ai_debug_decision_invalid', 'Model decision violated the bounded debug contract', 502);
        if (decision.values !== undefined && decision.patches !== undefined || decision.action !== 'adjust' && (decision.values !== undefined || decision.patches !== undefined)
          || decision.action === 'adjust' && decision.done) throw new VisionWorkshopError('vision_ai_debug_decision_invalid', 'Model decisions must select exactly one supported adjustment channel', 502);
        const iteration: VisionAiDebugIteration = { index: index + 1, source: 'model', model: decision.model, modelInput: decision.modelInput, tool: 'camera_debug_decision', ...(decision.validationWarnings ? { validationWarnings: [...decision.validationWarnings] } : {}), action: decision.action, notes: decision.notes, assessment: decision.assessment, before: current.observation, createdAt: timestamp() };
        run.iterations.push(iteration); await save();
        if (decision.assessment.improved && decision.assessment.sceneUsable && !decision.assessment.regressions?.length) {
          const verified = await snapshot();
          if (verified.hash !== current.observation.tuningHash) throw new VisionWorkshopError('vision_ai_debug_snapshot_changed', 'Best scene parameters changed after capture', 409);
          run.best = { ...verified, frameId: current.observation.frameId, frameHash: current.observation.frameHash, iteration: iteration.index, reason: decision.assessment.reason, assessment: structuredClone(decision.assessment) }; bestImage = current.image;
        }
        if (current.observation.tuningHash === run.best!.hash && !decision.assessment.regressions?.length) {
          run.best!.assessment = structuredClone(decision.assessment); run.best!.iteration = iteration.index;
          if (current.observation.frameId === run.original.frameId) run.original.assessment = structuredClone(decision.assessment);
        }
        run.goalSatisfied = Boolean(run.best?.assessment?.goalSatisfied && run.best.assessment.sceneUsable && !run.best.assessment.regressions?.length);
        if (decision.action === 'restore') { run.stopReason = 'model_restore_original'; run.best = structuredClone(run.original); break; }
        if (decision.action !== 'adjust' || decision.done || assessmentOnly) { run.stopReason = assessmentOnly ? 'adjustment_budget_completed' : decision.assessment.sceneUsable ? 'model_completed' : 'scene_requires_user_action'; break; }
        if (currentSnapshot.rules) {
          if (decision.values !== undefined || !decision.patches?.length || decision.patches.length > 3) throw new VisionWorkshopError('vision_ai_debug_decision_invalid', 'Native ISP adjustments require 1–3 qualified patches', 502);
          const patches = validateVisionIspPatches(currentSnapshot.tuning, currentSnapshot.rules, decision.patches);
          const tuning = structuredClone(currentSnapshot.tuning);
          for (const patch of patches) {
            const keys = patch.path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
            let node = tuning as Record<string, unknown>;
            for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
            node[keys.at(-1)!] = patch.value;
          }
          const tuningHash = hash(JSON.stringify(tuning));
          if (tuningHash === currentSnapshot.hash) { run.stopReason = 'no_meaningful_adjustment'; break; }
          iteration.requestedPatches = patches; await save();
          const applied = await atom('apply_tuning', { tuning, tuningHash });
          iteration.readbackHash = applied.result.readbackHash as string;
          currentSnapshot = { ...currentSnapshot, tuning, hash: tuningHash };
        } else {
          if (decision.patches !== undefined || !decision.values || Object.keys(decision.values).length > 3) throw new VisionWorkshopError('vision_ai_debug_decision_invalid', 'Controls adjustments require 1–3 supported values', 502);
          const values = validateVisionControlValues(decision.values, current.observation.controls);
          if (!Object.entries(values).some(([key, value]) => current.observation.controls[key]?.value !== value)) { run.stopReason = 'no_meaningful_adjustment'; break; }
          iteration.requestedValues = values; await save();
          const applied = await atom('controls_set', { values }); iteration.readback = validateVisionCameraControls(applied.result.controls);
        }
        run.adjustmentCount++; check(); current = await capture('AI 调整 ' + run.adjustmentCount);
        if (currentSnapshot.rules && current.observation.tuningHash !== currentSnapshot.hash) throw new VisionWorkshopError('vision_ai_debug_snapshot_changed', 'New frame does not match the independently read back ISP configuration', 409);
        iteration.after = current.observation; await save();
      }
      run.goalSatisfied = Boolean(run.best?.assessment?.goalSatisfied && run.best.assessment.sceneUsable && !run.best.assessment.regressions?.length);
      check(); await restore(run.best!, run.best!.hash === run.original.hash ? 'no_verified_usable_improvement_original_retained' : 'model_selected_best_retained');
      run.status = 'completed'; run.completedAt = timestamp(); await save();
    } catch (error) {
      run.cancelRequested ||= controller.signal.reason === 'user_cancel'; run.error = code(error);
      const finalStatus = run.cancelRequested ? 'canceled' : 'failed'; run.stopReason = run.original ? run.cancelRequested ? 'user_cancel_restored_original' : 'error_restored_original' : run.cancelRequested ? 'canceled_before_original_snapshot_no_write' : 'failed_before_original_snapshot_no_write';
      if (run.original && !restorationAttempted) try { await restore(run.original, 'original_restored_after_' + finalStatus); } catch { /* restore preserves the uncertain recovery evidence */ }
      if (run.restorationError) run.stopReason = 'restoration_unconfirmed';
      run.status = finalStatus; run.completedAt = timestamp(); await save().catch(() => undefined);
    } finally { clearTimeout(deadline); running.delete(run.id); session.release(); }
  }
}
