import type { VisionExportManifest, VisionHandbookData, VisionExperiment } from './vision-workshop-service.js';
import type { VisionAiDebugRun, VisionAiDebugSnapshot, VisionAiDebugObservation } from './vision-workshop-ai-debug.js';
import { buildVisionWorkshopDelivery, evaluateVisionAcceptance, type VisionWorkshopDelivery, type VisionAcceptanceRecord } from './vision-workshop-delivery.js';

export interface VisionArchiveEntry { name: string; data: Buffer }

/** The same pure projection backs both the customer guide and its machine-readable receipt. */
export function buildVisionWorkshopDeliveryExport(experiment: VisionExperiment): VisionArchiveEntry[] {
  return [{ name: 'delivery.json', data: Buffer.from(JSON.stringify(buildVisionWorkshopDelivery(experiment), null, 2)) }];
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export function visionCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded ZIP STORE archive: original bytes and hashes are preserved. */
export function createVisionArchive(entries: VisionArchiveEntry[]): Buffer {
  // Current graph: 4 metadata + 128 frames + 128 images + 64 RAW + 48 AI + 1 task index + 128 results + 16 vendor files = 517; retain bounded headroom.
  if (!entries.length || entries.length > 640) throw new Error('vision_archive_entry_limit');
  const names = new Set<string>();
  const chunks: Buffer[] = []; const directory: Buffer[] = [];
  let offset = 0; let total = 0;
  for (const entry of entries) {
    if (!/^[A-Za-z0-9_./-]{1,200}$/.test(entry.name) || entry.name.startsWith('/') || entry.name.split('/').some((p) => !p || p === '.' || p === '..') || names.has(entry.name)) throw new Error('vision_archive_invalid_name');
    names.add(entry.name); total += entry.data.length;
    if (total > 192 * 1024 * 1024) throw new Error('vision_archive_size_limit');
    const name = Buffer.from(entry.name); const crc = visionCrc32(entry.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, entry.data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += local.length + name.length + entry.data.length;
  }
  const centralSize = directory.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...directory, end]);
}

function inline(value: unknown): string { return String(value ?? '').replace(/[\r\n|]/g, ' ').replace(/[<>]/g, '').slice(0, 4000); }

export const VISION_WORKSHOP2_AGENDA = [
  { title: '目标与验收约定', minutes: 15, outcome: '记录场景、问题、验收方法、阈值与责任人；没有约定不预填合格。' },
  { title: '环境与版本预检', minutes: 25, outcome: '核对板卡、模组、接线、OS、驱动、SDK、实际模式、权限和工具。' },
  { title: '点亮与稳定出图', minutes: 30, outcome: '执行实际探测、链路检查和已有驱动点亮；归档可辨认的新帧。' },
  { title: '采图与原始基线', minutes: 30, outcome: '固定场景，保存 RAW 或明确标注的视频帧、实际控制与可恢复基线。' },
  { title: '受控调优与比较', minutes: 60, outcome: '每轮记录理由、有限参数变化、独立回读及新图；保留改善与退化。' },
  { title: '工程到测试评估', minutes: 35, outcome: '按约定场景逐项评估；区分统计观察、模型建议、人工判断和测量结果。' },
  { title: '恢复、复现与签收', minutes: 30, outcome: '核对最终版本、恢复回执、复现条件、交付文件和未完成项。' },
] as const;

function appendDeliveryHandbook(lines: string[], delivery: VisionWorkshopDelivery): void {
  const qualityLabels: Record<string, string> = {
    not_configured: '未建立验收计划', pending: '等待当前计划与配置的验收记录', scene_mismatch: '验收图像场景与计划不匹配',
    recorded_fail: '操作者记录存在未满足的必测项', incomplete: '必测项尚未记录完整', recorded_pass: '操作者记录满足约定项；仍需核验真实性与独立证据',
  };
  const tuningLabels: Record<string, string> = {
    missing: '尚未选定交付配置', session_bound_configuration: '依赖适配器快照的会话配置', configuration_exportable: '可导出配置；独立部署仍按实际验证状态判断', vendor_library_candidate: '具有独立字节的厂商效果库候选；按实际重新加载证据判断',
  };
  const reloadLabels: Record<string, string> = { unverified: '未验证', not_recorded: '尚未记录目标加载', target_reload_recorded: '已记录目标环境加载；新会话证据未齐', fresh_session_reload_recorded: '已记录匹配原生新会话的加载、独立回读与新帧' };
  lines.push('', '## 本次交付与验收状态', '',
    '机器可读记录：delivery.json；契约：' + inline(delivery.contract) + '；实验：' + inline(delivery.experimentId), '',
    '| 项目 | 实际记录 |', '| --- | --- |',
    '| 交付目标 | ' + inline(delivery.selectedTargetId || '未选定') + ' |',
    '| 验收状态 | ' + inline(qualityLabels[delivery.quality.status] || delivery.quality.status) + '（' + inline(delivery.quality.status) + '） |',
    '| 当前验收记录 | ' + inline(delivery.quality.recordId || '未记录') + ' |',
    '| 参数交付类型 | ' + inline(tuningLabels[delivery.tuning.status] || delivery.tuning.status) + '（' + inline(delivery.tuning.kind) + '） |',
    '| 配置 SHA-256 | ' + inline(delivery.tuning.hash || '未记录') + ' |',
    '| 独立部署验证 | ' + inline(reloadLabels[delivery.tuning.independentDeployment] || delivery.tuning.independentDeployment) + '（' + inline(delivery.tuning.independentDeployment) + '） |',
    '| 独立画质验证 | ' + inline(delivery.quality.independentVerification) + ' |',
    '| 硬件 / 画质验证状态 | ' + inline(delivery.hardwareVerification) + ' / ' + inline(delivery.qualityVerification) + ' |',
    '| Workshop 就绪投影 | ' + (delivery.workshopReady ? '满足当前交付规则；仍限所列范围' : '尚未满足当前交付规则') + ' |', '',
    '就绪规则范围：' + inline(delivery.readinessScope) + '；只表示已记录项目验收与目标加载的证据链。验收数据来源：' + inline(delivery.quality.source) + '。操作者录入的数值或主观结论不自动变成经校准测量或独立认证；计划、样本或参数版本变化后应重新复测。');
  const target = delivery.targets.find(item => item.id === delivery.selectedTargetId);
  if (target?.vendor) {
    const vendor = target.vendor;
    lines.push('', '### 厂商候选库、装载与恢复证据', '',
      '| 关联项 | 实际记录 |', '| --- | --- |',
      '| 厂商候选库字节 SHA-256 | ' + inline(vendor.candidateSha256) + ' |',
      '| 私有映射绑定 SHA-256 | ' + inline(vendor.bindingHash) + ' |',
      '| 原始 SDK 模板 / 模块基线 SHA-256 | ' + inline(vendor.templateSha256) + ' / ' + inline(vendor.baselineModulesSha256) + ' |',
      '| 导出时配置 / 模块 SHA-256 | ' + inline(vendor.sourceReadbackHash) + ' / ' + inline(vendor.sourceModulesSha256) + ' |',
      '| 目标装载后配置 SHA-256 | ' + inline(target.hash) + ' |',
      '| 导出回执 / 时间 | ' + inline(vendor.exportRunId) + ' / ' + inline(vendor.exportCreatedAt) + ' |',
      '| 装载回执 / 时间 | ' + inline(vendor.reloadRunId || '未记录') + ' / ' + inline(vendor.reloadCreatedAt || '未记录') + ' |',
      '| 装载状态 | ' + inline(reloadLabels[vendor.reloadStatus] || vendor.reloadStatus) + '（' + inline(vendor.reloadStatus) + '） |', '',
      '候选文件哈希标识原字节；装载后的配置哈希标识独立 SDK 回读，二者用途不同。未公开库字段的完整回读与独立画质仍未验证，适用范围不因一次成功装载扩大。');
  }
  lines.push('', '原始状态恢复：' + inline(delivery.restoration.status) + '；基线 SHA-256：' + inline(delivery.restoration.baselineHash || '未确认') + '；恢复回执：' + inline(delivery.restoration.runId || '未记录') + '。',
    '执行恢复栅栏：' + inline(delivery.recovery.status) + '；未确认写入：' + inline(delivery.recovery.manualFence) + '；流失败阻塞：' + inline(delivery.recovery.streamBlocked) + '；运行未结束：' + inline(delivery.recovery.active) + '。');
  if (delivery.vendorArtifacts.length) {
    lines.push('', '### 已归档厂商候选文件', '', '| 文件 | 原字节 SHA-256 | 字节数 | 绑定 / 导出配置 SHA-256 |', '| --- | --- | --- | --- |');
    for (const artifact of delivery.vendorArtifacts) lines.push('| vendor-tuning/' + inline(artifact.id) + '.json（' + inline(artifact.filename) + '） | ' + inline(artifact.hash) + ' | ' + artifact.byteLength + ' | ' + inline(artifact.bindingHash) + ' / ' + inline(artifact.sourceReadbackHash) + ' |');
  }
  if (delivery.acceptancePlan) {
    const plan = delivery.acceptancePlan;
    lines.push('', '### 当前验收计划', '', '计划 ID：' + inline(plan.id) + '；场景：' + inline(plan.scene) + '；照明：' + inline(plan.lighting), '',
      '| 检查项 | 必测 | 方法 | 约定条件 |', '| --- | --- | --- | --- |');
    for (const criterion of plan.criteria) {
      const threshold = criterion.kind === 'visual' ? '记录实际观察结论及理由' : criterion.operator === 'lte' ? '≤ ' + criterion.maximum : criterion.operator === 'gte' ? '≥ ' + criterion.minimum : String(criterion.minimum) + ' 至 ' + criterion.maximum;
      lines.push('| ' + inline(criterion.id + ' · ' + criterion.label) + ' | ' + (criterion.required ? '是' : '否') + ' | ' + inline(criterion.method || (criterion.kind === 'visual' ? '人工观察' : '未记录')) + ' | ' + inline(threshold + (criterion.unit ? ' ' + criterion.unit : '')) + ' |');
    }
    const record = delivery.acceptanceRecords.find(item => item.id === delivery.quality.recordId);
    if (record) {
      let outcomes: VisionAcceptanceRecord['outcomes'] = [];
      try { outcomes = evaluateVisionAcceptance(plan, record); }
      catch { lines.push('', '当前记录与验收计划不相容，逐项结论保持未确认；请核对 delivery.json 中的原始观察值和失败项。'); }
      lines.push('', '### 当前验收记录与证据', '',
        '记录 ID：' + inline(record.id) + '；计划 ID：' + inline(record.planId) + '；配置 SHA-256：' + inline(record.tuningHash) + '；记录 SHA-256：' + inline(record.hash), '',
        '记录时间：' + inline(record.createdAt) + '；测量真实性：' + inline(record.measurementAuthenticity), '',
        '| 检查项 | 记录结果 | 实测值 / 观察 | 说明 |', '| --- | --- | --- | --- |');
      for (const criterion of plan.criteria) {
        const outcome = outcomes.find(item => item.criterionId === criterion.id), observation = record.observations.find(item => item.criterionId === criterion.id);
        lines.push('| ' + inline(criterion.id) + ' | ' + (outcome?.met === true ? '记录满足' : outcome?.met === false ? '记录未满足' : '未记录') + ' | ' + inline(observation?.value ?? observation?.verdict ?? '未记录') + ' | ' + inline(observation?.notes || '无补充') + ' |');
      }
      lines.push('', '| 图像 ID | SHA-256 | 绑定配置 | 场景 | 来源 |', '| --- | --- | --- | --- | --- |');
      for (const image of record.evidenceImages) lines.push('| ' + inline(image.id) + ' | ' + inline(image.hash) + ' | ' + inline(image.tuningHash || '未记录') + ' | ' + inline(image.scene || '未记录') + ' | ' + inline(image.source) + ' |');
      if (record.reportSha256) lines.push('', '测量报告 SHA-256：' + inline(record.reportSha256) + '；原文与完整历史记录见 delivery.json。');
    }
  }
  lines.push('', '### 阶段证据与尚未完成项', '', '| 阶段 | 状态 | 证据 ID |', '| --- | --- | --- |');
  for (const stage of delivery.stages) lines.push('| ' + inline(stage.id) + ' | ' + inline(stage.status) + ' | ' + inline(stage.evidenceIds.join(', ') || '未记录') + ' |');
  if (delivery.blockers.length) lines.push('', '以下条件仍需完成；标识与 delivery.json 一致：', '', ...delivery.blockers.map(blocker => '- ' + inline(blocker)));
  else lines.push('', '当前交付规则未报告阻塞项；接收方仍须核对适用版本、部署格式、验收范围和实际文件。');
}

function appendWorkshopGuide(lines: string[], experiment: VisionExperiment): void {
  const identity = [experiment.board, experiment.sensorVendor, experiment.sensorModel, experiment.sdkVersion, experiment.cameraInterface, experiment.cameraMode];
  lines.push('', '## 客户复用前提与责任', '',
    '本手册同时保留操作指南和本次实际记录。主办方负责课前环境与素材预验收，工程师执行与留痕，测试人员按约定方法复测，客户确认适用场景与剩余限制。', '',
    '| 前提 | 本实验记录 |', '| --- | --- |',
    '| 板卡 / 厂商 / Sensor / SDK / 接口 / 模式 | ' + identity.map(value => inline(value || '待记录')).join(' / ') + ' |',
    '| 实际适配器 | ' + inline(experiment.targetId || '未绑定；仅可进行资料与文件实验') + ' |',
    '| OS / 驱动 / 相机包 / 原生库构建版本 | 待由现场预检回执确认；不能从 SDK 字段推断 |',
    '| 模组批次、镜头、排线方向与引脚、电压、照明、距离、焦点、温度 | 按实际设备与场景记录；缺项不得填成已验证 |',
    '| 模式与参数资格 | 必须匹配实际宽高、帧率、Bayer、位深、packing、stride；只开放 SDK 与策略允许且能回读的字段 |', '',
    '开始硬件操作前：核对账号和设备授权、探测结果、媒体链路、采图可用性及原始配置恢复路径。设备登记、知识文档和离线计算都不能代替这些现场检查。',
    '没有可用适配器时可先核对资料、导入带来源的文件并运行离线标定；不得把上传图像标记为本次相机采集。', '',
    '## 225 分钟可裁剪议程', '',
    '计划总时长 225 分钟（3 小时 45 分钟）。这是课前已完成设备预验收的安排；设备未预验收、驱动缺失或模式不匹配时不承诺准时完成点亮或画质目标。', '',
    '| 时间 | 环节 | 本段产出 |', '| --- | --- | --- |');
  let elapsed = 0;
  for (const phase of VISION_WORKSHOP2_AGENDA) {
    lines.push('| ' + elapsed + '–' + (elapsed + phase.minutes) + ' 分钟 | ' + phase.title + ' | ' + phase.outcome + ' |'); elapsed += phase.minutes;
  }
  lines.push('', '裁剪方式：已验过的预检可减少重复演示；优先完成一个明确场景和一项调优目标，复杂标定或其他模式移至课后。保留原始基线、实际回读、失败记录、恢复和交付签收，不能为了赶时间删掉证据。', '',
    '## 现场操作与阶段出口', '',
    '1. **约定目标**：由工程与测试共同写清画质问题、场景、评价方法、阈值和范围；既有人工评分或模型 goalSatisfied 不自动满足客户验收。',
    '2. **检查环境**：读取实际 OS/SDK/驱动与模式、适配器 capabilities 和实验 readiness；GET readiness 是已存证据汇总，不是一次新的设备探测。',
    '3. **点亮并确认新帧**：执行 probe、pipeline_validate、bringup 与预览；检查可辨认场景、实际尺寸、帧率及连续性。I²C 有地址、有旧图或 bringup 成功文字都不够。新 Sensor 驱动、设备树与 SDK 编译接入另列工程任务。',
    '4. **采图并保存基线**：记录光照、距离、焦点、曝光、增益和自动模式；保存原配置与恢复版本。采 RAW 时核对真实 Bayer、位深、packing、stride 和字节数；PNG/JPEG 视频帧单独归档。',
    '5. **一次有限调整**：使用当前适配器公开且已具备回读资格的字段；先确认自动模式与手动项 active 状态，再写入。保存参数变化理由、请求值、实际回读和新采图；不要给旧队列帧换上新 tuningHash。',
    '6. **受控比较**：设备支持时用同一 RAW、相同基线和 SDK 处理候选；实拍则尽量固定场景与照明，记录无法固定的变化。分别观察曝光、颜色、暗部和彩噪、雾感、边缘细节和运动退化。',
    '7. **交给测试**：按验收计划逐条复测并记录实测值、方法、人员、版本和样本；明确通过、失败、未执行与不适用。PNG 码值统计、离线标定与模型选择均不能替代校准 SNR、MTF、色差或动态稳定性测试。',
    '8. **恢复并复现**：应用或恢复后重新独立回读，再采一张终态图；确认测试设备最终保留哪一版。在约定环境复跑所交付版本，停止自己启动的预览，保留失败与未确认状态。', '',
    '## 同场景图像、配置与版本绑定', '',
    '交付比较至少关联：实验 ID、设备/Sensor/SDK/模式、场景条件、原始样本 ID 与 SHA-256、基线与候选 ID/哈希、处理或采集图像 ID/哈希，以及真实应用/回读回执。',
    '同 RAW 比较绑定同一原始字节与基础版本。两个独立视频帧即使尺寸相同也可能受自动曝光、运动或照明影响；须标注这些混杂因素，不能称为严格同输入 ISP 比较。',
    '最终图像必须属于当前确认的参数版本。哈希、模式、时间或来源不匹配时保留记录并重新采集，不能补填一次成功回执。', '',
    '## 交付文件角色与复现边界', '',
    '| 文件或记录 | 用途与限制 |', '| --- | --- |',
    '| manifest.json 与原始基线 | 实验资产、原始参数版本、SHA-256 与设备回执的索引；用于追溯和恢复，不是新调优效果库 |',
    '| candidate_tuning.json | 选定的参数候选；只有已选择时才进入包。格式由适配器决定，使用前核对 Sensor、SDK、模式与回读 |',
    '| ai-debug/ 下的 original_tuning.json、best_tuning.json 与 report.json | AI 运行前参数、曾推荐配置、图像/回读与决策来源；best 不等于客户签收，设备可能已经恢复原始配置 |',
    '| SDK 效果库归档 | tuning_export 可返回已归档的原 SDK 输入字节及哈希，并附公开模块的独立回读；不能据此声称文件包含本轮所有模块修改或未公开字段已完整回读 |',
    '| vendorCandidate 厂商效果库候选 | 仅在可信 SDK/profile/layout、模板、原始模块基线与全部变更字段映射齐备时生成；artifactRole=vendor_effect_library_candidate。blocked 没有候选字节；generated_requires_target_validation 仍须目标环境验证 |',
    '| vendor-tuning/<id>.json | 实验归档的厂商候选原字节；核对清单中的文件 SHA-256、字节数、绑定与源配置，交付目标要显式选定该版本。文件存在不代表已重新加载或质量达标 |',
    '| native 模块候选与 snapshotId | 模块配置可能依赖适配器持久化的私有快照、ABI/layout、SDK 与模式；普通候选 JSON 不应直接交给厂商原生效果库加载器 |',
    '| 可独立部署候选 | 必须由实际实现支持的交付格式携带所需依赖、格式/版本/哈希及装载约束；只有独立加载、回读和恢复证据齐备后才按其适用范围交付。未提供或未复测时列为未交付/待验证 |',
    '| calibration/ 下的任务与结果 | SDK 中立的 CPU 标定计算及原始结果字节/哈希；应用需匹配的 SDK 私有映射，计算完成不等于设备应用或画质合格 |',
    '| handbook.md 与 delivery.json | 操作指南、实际记录及交付/验收状态；未知或未执行项保留原状态，不补写通过 |', '',
    '厂商候选库的显式 tuning_load 必须校验私有生成回执，再执行实际 SDK 加载、独立模块回读和新帧检查。target_reload_recorded 只记录该次装载；还须检查真实原生来源、freshSessionObserved、模式资格、恢复与画质证据，不能把同会话或合成后端成功当作独立部署验收。普通无 artifactRole 加载不补授厂商候选证明。', '',
    '共享手册与成果包不包含模型密钥、设备令牌或 SSH 凭据。适配器私有快照与部署依赖由授权工程人员按交付格式单独管理；导出实验元数据不会自动形成完整、可移植的 MIPI 厂商 tuning 库。', '',
    '## 失败、未知与停止条件', '',
    '| 情况 | 处理与记录 |', '| --- | --- |',
    '| 缺版本、驱动、SDK、模式或适配器 | 停在预检，补齐匹配项；可转入明确标注的离线练习，不填写点亮成功 |',
    '| 黑屏、错色、无新帧或媒体链路失败 | 保存日志和真实检查项，核对接线与元数据；不盲目扫描 I²C、写寄存器或换示例图冒充采集 |',
    '| 写入超时、断连或回读不一致 | 先查设备执行账本和实际状态，不自动重放；恢复未确认时停止新调优并保留 unconfirmed |',
    '| 画面变暗、噪点增加或细节丢失 | 记录退化，恢复已验证基线并重新回读/采图；模型完成或单项统计改善不能抹去退化 |',
    '| 原始库/快照缺失或独立复现失败 | 不猜恢复值，不签收可部署；保留待恢复/待补依赖与负责人 |',
    '| 剩余时间不足 | 交付已经完成的记录与未完成清单，约定补测；不修改验收阈值来制造通过 |', '',
    '## 最终工程与测试签收清单', '',
    '- [ ] 设备、镜头/模组、OS/驱动/SDK、模式、场景与验收范围已记录并一致。',
    '- [ ] 原始图、候选图、配置与版本哈希可关联；实拍混杂因素已注明。',
    '- [ ] 最终参数已经实际加载并独立回读；恢复路径与设备最终状态已确认。',
    '- [ ] 验收计划逐项有实际测试记录；失败、未测与不适用项及理由均保留。',
    '- [ ] 目标、噪点/彩噪、颜色、细节、运动、帧率和稳定性按约定范围检查；无证据项不勾选。',
    '- [ ] 明确交付的是候选、归档 SDK 库还是已复测的独立部署产物；依赖、格式、适用版本与文件哈希已核对。',
    '- [ ] 原始配置、恢复记录、手册、delivery.json 和约定样本已由接收方核验。',
    '- [ ] 工程负责人、测试负责人、客户确认人、日期、剩余问题与补测责任已填写。', '',
    '以上复核框由实际责任人填写，手册生成不自动勾选；最终交付状态以实际验收计划、记录和回读证据为准。');
}

function snapshotReport(snapshot: VisionAiDebugSnapshot | undefined, file: string) {
  if (!snapshot) return undefined;
  return { tuningFile: file, tuningHash: snapshot.hash, controls: snapshot.controls, frameId: snapshot.frameId, frameHash: snapshot.frameHash,
    frameFile: snapshot.frameId ? '../../frames/' + snapshot.frameId + '.png' : undefined, iteration: snapshot.iteration, reason: snapshot.reason, assessment: snapshot.assessment };
}
function observationReport(observation: VisionAiDebugObservation | undefined) {
  if (!observation) return undefined;
  return { frameId: observation.frameId, frameHash: observation.frameHash, frameFile: '../../frames/' + observation.frameId + '.png', tuningHash: observation.tuningHash, controls: observation.controls, statistics: observation.statistics };
}

/** Public camera snapshots are exported verbatim; private adapter/model configuration and raw receipts are excluded. */
export function buildVisionAiDebugExport(experiment: Pick<VisionExperiment, 'aiDebugRuns'>): VisionArchiveEntry[] {
  const runs = experiment.aiDebugRuns || []; if (runs.length > 16) throw new Error('vision_ai_debug_export_run_limit');
  const names = new Set<string>(); const entries: VisionArchiveEntry[] = [];
  for (const run of runs) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run.id) || names.has(run.id)) throw new Error('vision_ai_debug_export_invalid_run');
    names.add(run.id); const prefix = 'ai-debug/' + run.id + '/';
    if (run.original) entries.push({ name: prefix + 'original_tuning.json', data: Buffer.from(JSON.stringify(run.original.tuning)) });
    if (run.best) entries.push({ name: prefix + 'best_tuning.json', data: Buffer.from(JSON.stringify(run.best.tuning)) });
    const report = {
      schemaVersion: 1, runId: run.id, source: 'model', tool: run.tool, modelInput: 'camera_images_controls_and_history', status: run.status, goal: run.goal,
      maxAdjustments: run.maxRounds, actualAdjustments: run.adjustmentCount, visualDecisions: run.iterations.length,
      goalSatisfied: run.goalSatisfied, visualVerification: 'unverified', humanEvaluation: 'not_recorded_by_ai_debug', cancelRequested: run.cancelRequested,
      stopReason: run.stopReason, error: run.error, restorationError: run.restorationError, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.completedAt,
      original: snapshotReport(run.original, 'original_tuning.json'), best: snapshotReport(run.best, 'best_tuning.json'),
      final: run.final ? { controls: run.final.controls, tuningHash: run.final.hash, restored: run.final.restored, reason: run.final.reason,
        frameId: run.final.frameId, frameHash: run.final.frameHash, frameFile: run.final.frameId ? '../../frames/' + run.final.frameId + '.png' : undefined,
        imageError: run.final.imageError, visualVerification: 'unverified' } : undefined,
      iterations: run.iterations.map(iteration => ({ index: iteration.index, source: 'model', model: iteration.model, tool: iteration.tool, modelInput: iteration.modelInput,
        action: iteration.action, notes: iteration.notes, assessment: iteration.assessment, validationWarnings: iteration.validationWarnings,
        before: observationReport(iteration.before), requestedValues: iteration.requestedValues, readback: iteration.readback, after: observationReport(iteration.after), createdAt: iteration.createdAt })),
      operations: run.operations.map(operation => ({ operationId: operation.operationId, jobId: operation.jobId, status: operation.status, error: operation.error, createdAt: operation.createdAt,
        appliedHash: typeof operation.receipt?.appliedHash === 'string' ? operation.receipt.appliedHash : undefined,
        readbackHash: typeof operation.receipt?.readbackHash === 'string' ? operation.receipt.readbackHash : undefined })),
      limitations: ['模型视觉判断不是人工评分或完整画质验收。', '独立视频采集帧不保证相同场景输入，不能作为同一 RAW 的校准 ISP 比较。', '参数应用/恢复与哈希回读一致不能证明图像质量达标。'],
    };
    entries.push({ name: prefix + 'report.json', data: Buffer.from(JSON.stringify(report, null, 2)) });
  }
  return entries;
}

function appendAiDebugHandbook(lines: string[], runs: VisionAiDebugRun[]): void {
  if (!runs.length) return;
  lines.push('', '## AI 自主看图调试', '', '来源：source:model；真实图像函数调用工具 camera_debug_decision。以下 AI 视觉判断不计作人工评分；视觉验收状态均为 unverified。参数回读一致不能证明画质达标。');
  for (const run of runs) {
    const prefix = 'ai-debug/' + run.id + '/';
    lines.push('', '### 运行 ' + inline(run.id), '', '目标：' + inline(run.goal), '',
      '运行状态：' + inline(run.status) + '；实际调整 ' + run.adjustmentCount + ' 次 / 最多 ' + run.maxRounds + ' 次；实际图像模型判断 ' + run.iterations.length + ' 次。', '',
      '模型判断的目标状态：' + (run.goalSatisfied === true ? '模型认为目标已达到，仍需人工及项目验收。' : run.goalSatisfied === false ? '目标尚未达到，不作为画质验收通过。' : '尚未完成目标判断。'), '',
      '停止原因：' + inline(run.stopReason || '未记录') + '；错误：' + inline(run.error || '无记录') + '；恢复错误：' + inline(run.restorationError || '无记录'), '',
      '详细报告：' + prefix + 'report.json');
    if (run.original) lines.push('', '运行前参数：' + prefix + 'original_tuning.json；配置 SHA-256：' + run.original.hash + '；实际图像：' + inline(run.original.frameId || '未采集') + '；图像 SHA-256：' + inline(run.original.frameHash || '未采集'));
    if (run.best) lines.push('', (run.final?.restored ? 'AI 曾推荐的历史参数（当前设备已恢复原始参数）：' : 'AI 推荐的观察参数（未完成画质验收）：') + prefix + 'best_tuning.json；配置 SHA-256：' + run.best.hash + '；实际图像：' + inline(run.best.frameId || '未采集') + '；图像 SHA-256：' + inline(run.best.frameHash || '未采集'), '', 'AI 选择理由：' + inline(run.best.reason || '未记录'));
    if (run.final) lines.push('', '最终设备状态：' + (run.final.restored ? '恢复原始参数' : '保留选定参数') + '；实际回读版本：' + inline(run.final.hash || '未记录') + '；原因：' + inline(run.final.reason), '',
      '最终现场图像：' + inline(run.final.frameId || '未获得新图像') + '；图像 SHA-256：' + inline(run.final.frameHash || '未获得新图像') + '；图像采集错误：' + inline(run.final.imageError || '无记录') + '；视觉验收：unverified。');
    else lines.push('', '最终设备回读尚未确认，不能声称恢复或参数应用已经完成。');
    lines.push('', '| 模型判断轮次 | 动作 | 模型 | AI 观察与决定依据 | AI 观察到的画质回退 | 请求变化 / 实际回读 | 实际图像哈希（前 / 后） |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const iteration of run.iterations) {
      const readback = iteration.readback || iteration.after?.controls;
      const values = Object.entries(iteration.requestedValues || {}).map(([key, value]) => key + '=' + value + ' / ' + (readback?.[key]?.value ?? '未回读')).join('; ') || '没有新参数写入';
      const names = { noise: '噪点/颗粒', detail: '文字/边缘细节', color: '颜色', exposure: '曝光' }; const regressions = (iteration.assessment.regressions || []).map(item => names[item]).join('、') || '没有记录';
      lines.push('| ' + iteration.index + ' | ' + inline(iteration.action) + ' | ' + inline(iteration.model) + ' | ' + inline(iteration.notes) + '；' + inline(iteration.assessment.reason) + ' | ' + regressions + ' | ' + inline(values) + ' | ' + iteration.before.frameHash + ' / ' + inline(iteration.after?.frameHash || '没有新采集') + ' |');
    }
    lines.push('', '复现或恢复请核对原设备、模式和实际控制范围，使用保存的完整 tuning 配置与 SHA-256。UVC 配置通过对应驱动控制接口使用，不是 MIPI ISP 全模块参数。');
  }
}
export function renderVisionHandbook(data: VisionHandbookData, manifest: VisionExportManifest): string {
  const selected = data.selectedCandidate;
  const delivery = buildVisionWorkshopDelivery(manifest.experiment);
  const vendorTarget = delivery.targets.find(target => target.id === delivery.selectedTargetId && target.source === 'vendor-library');
  const lines = ['# ' + inline(data.title) + ' · 调优手册', '',
    '实验目标：' + inline(data.goal), '',
    '平台：' + inline(data.board || '待记录') + '；相机厂商：' + inline(data.sensorVendor || '待记录') + '；型号：' + inline(data.sensorModel || '待记录') + '；SDK：' + inline(data.sdkVersion || '待记录'), '',
    '相机接口：' + inline(data.cameraInterface || '待记录') + '；工作模式：' + inline(data.cameraMode || '待记录'), '',
    '**验证状态：本实验未获得完整的动态画质验收。设备回执、模型判断、导入结果和人工评分按实际来源分别记录。**', '',
    '## 实验步骤', '', ...data.stages.map((stage, i) => String(i + 1) + '. ' + inline(stage.title) + '（' + stage.status + '）：' + inline(stage.detail)), '',
    '## Raw 样本', '', '| 样本 ID | 场景 | 格式 | 曝光 / 增益 | SHA-256 |', '| --- | --- | --- | --- | --- |'];
  for (const sample of data.samples) lines.push('| ' + sample.id + ' | ' + inline(sample.metadata.scene) + ' | ' + sample.metadata.width + '×' + sample.metadata.height + ', ' + sample.metadata.bitDepth + ' bit, ' + sample.metadata.bayer + ', ' + sample.metadata.packing + ', stride=' + sample.metadata.stride + ' | ' + inline(sample.metadata.exposureUs ?? '未记录') + ' µs / ' + inline(sample.metadata.gain ?? '未记录') + ' | ' + sample.hash + ' |');
  lines.push('', '## 相机视频画面', '', '以下为设备实际采集的 PNG/JPEG，属于处理后的视频画面，不能替代 Bayer RAW。独立采集的两张画面可能受到场景、自动曝光与运动变化影响，不能作为同一 RAW 的 ISP 参数对比。', '', '| 图像 ID | 场景 | 尺寸 / 时间 | 参数版本 | SHA-256 |', '| --- | --- | --- | --- | --- |');
  for (const frame of data.cameraFrames || []) {
    lines.push('| ' + frame.id + ' | ' + inline(frame.scene || '未记录') + ' | ' + frame.width + '×' + frame.height + ' / ' + inline(frame.capturedAt || frame.createdAt) + ' | ' + inline(frame.tuningHash || '未记录') + ' | ' + frame.hash + ' |');
    if (frame.controls) lines.push('', '采集时参数回读（' + frame.id + '）：', '', '```json', JSON.stringify(frame.controls, null, 2), '```');
    for (const evaluation of data.evaluations.filter(entry => entry.imageId === frame.id)) lines.push('', '人工评价：' + evaluation.rating + '/5 · ' + inline(evaluation.notes));
  }
  lines.push('', '## 基础配置与设备执行记录', '', '| 基线版本 | SHA-256 | 保存时间 |', '| --- | --- | --- |');
  for (const baseline of manifest.experiment.baselineHistory) lines.push('| ' + baseline.id + ' | ' + baseline.hash + ' | ' + inline(baseline.createdAt) + ' |');
  lines.push('', '| 操作 | 状态 | 时间 | 适配器 | 关联候选 / 样本 |', '| --- | --- | --- | --- | --- |');
  for (const run of manifest.experiment.deviceRuns) lines.push('| ' + inline(run.operation) + ' | ' + inline(run.status) + ' | ' + inline(run.createdAt) + ' | ' + inline(run.adapterId) + ' | ' + inline(run.candidateId || run.sampleId || '未关联') + ' |');
  lines.push('', '设备回执详情位于 manifest.json 的 deviceRuns。failed 表示失败或写入结果未确认；必须读取实际状态后再决定是否重试。参数应用或恢复要求应用哈希与实际回读哈希一致，仍不等于完整画质验收。');
  lines.push('', '## 选定参数候选', '');
  if (selected) {
    lines.push('候选：' + selected.id, '', '来源：' + selected.source + (selected.model ? ' / ' + inline(selected.model) : '') + '；状态：' + selected.verification, '',
      '模型输入：' + inline(selected.modelInput || (selected.frameIds?.length ? '处理后相机画面统计与基础参数' : 'RAW 统计与基础参数')), '',
      '基础配置 SHA-256：' + selected.baselineHash, '', '候选配置 SHA-256：' + selected.hash, '', '| 参数路径 | 候选值 | 调整理由 |', '| --- | --- | --- |');
    for (const patch of selected.patches) lines.push('| ' + inline(patch.path) + ' | ' + patch.value + ' | ' + inline(patch.reason) + ' |');
  } else if (vendorTarget) lines.push('本次选定厂商效果库交付目标：' + inline(vendorTarget.id) + '；实际候选原字节见 vendor-tuning/ 与下方交付证据表。没有手动 candidate_tuning.json 不代表缺少厂商候选文件；装载与质量状态按实际证据分别记录。');
  else lines.push(manifest.experiment.aiDebugRuns?.length ? '没有手动选定的 candidate_tuning.json；AI 自主运行的原始与最佳配置分别保存在 ai-debug/<runId>/，见下文。' : '尚未选定候选；交付包中没有最终 tuning 文件。');
  appendAiDebugHandbook(lines, manifest.experiment.aiDebugRuns || []);
  lines.push('', '## 图像与人工评价', '', '| 图像 ID | Raw 样本 | 参数候选 | 评分 | 评价 |', '| --- | --- | --- | --- | --- |');
  for (const image of data.processedImages) {
    const evaluations = data.evaluations.filter((evaluation) => evaluation.imageId === image.id);
    if (!evaluations.length) lines.push('| ' + image.id + ' | ' + image.sampleId + ' | ' + (image.candidateId || '基础配置') + ' | 未评价 | ' + (image.source === 'runner' ? 'SDK 执行器归档，完整画质待验收' : '外部导入，参数应用未经平台确认') + ' |');
    for (const evaluation of evaluations) lines.push('| ' + image.id + ' | ' + image.sampleId + ' | ' + (image.candidateId || '基础配置') + ' | ' + evaluation.rating + '/5 | ' + inline(evaluation.notes) + ' |');
  }
  lines.push('', '## 客观图像对比', '', '以下为同一 Raw、相同基础参数版本下的 PNG 输出统计，不是校准噪声、MTF、色差或画质总分。');
  for (const comparison of data.comparisons) {
    lines.push('', '### 对比 ' + comparison.id, '',
      '基础图像：' + comparison.baselineImageId + '；候选图像：' + comparison.candidateImageId + '；Raw：' + comparison.sampleId, '',
      '基础配置 SHA-256：' + comparison.baselineTuningHash + '；候选配置 SHA-256：' + comparison.candidateTuningHash, '',
      '```json', JSON.stringify(comparison.metrics, null, 2), '```');
  }
  if (manifest.experiment.baseline?.tuning.kind === 'uvc-controls-v1') lines.push('', '## UVC 参数复现', '',
    '1. 连接匹配的 USB 相机和工作模式，先探测并回读支持范围。',
    '2. 使用 apply_tuning 应用选定候选，或 restore_tuning 恢复保存的基础参数版本。',
    '3. 核对设备实际回读，再重新采集画面并记录场景和曝光条件。',
    '4. 人工比较细节、颜色和曝光，补充运动、帧率及长时间稳定性检查。',
    'UVC 控制配置只适用于对应相机的驱动控制接口，不是厂商 MIPI ISP 全模块 tuning 文件。');
  lines.push('', '## RAW / ISP 复现与验证', '',
    '1. 核对设备、Sensor 模式、SDK、Raw Bayer/位深/stride 与清单一致。',
    '2. 根据 manifest.json 的 SHA-256 核对原始样本与参数版本。',
    '3. 通过匹配适配器应用 candidate_tuning.json 并独立回读；含 snapshotId 的配置不是可直接送入厂商库加载器的文件。厂商候选库须按实际 artifactRole、生成回执、SDK 与模式约束另行加载验证。',
    '4. 用同一 Raw 样本处理基础配置与候选配置，比较相同区域。',
    '5. 上板采集视频，补充曝光稳定性、运动效果、帧率和丢帧验证。',
    '6. 记录测试条件、验收目标、通过项与剩余问题后，决定是否用于项目。', '',
    'Raw 预览只用于查看输入数据，不能作为实际 ISP 调优后的输出。', '',
    ...data.cautions.map((caution) => '- ' + inline(caution)));
  appendWorkshopGuide(lines, manifest.experiment);
  appendDeliveryHandbook(lines, delivery);
  lines.push('', '导出时间：' + manifest.exportedAt, '');
  return lines.join('\n');
}
