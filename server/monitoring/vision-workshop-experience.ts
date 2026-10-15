/** Keep the UI's admission checks aligned with the actual AI executor. */
export const VISION_AI_DEBUG_REQUIRED_OPERATIONS = ['probe', 'controls_get', 'controls_set', 'capture_frame', 'restore_tuning'] as const;

/** Runs inside the authenticated workshop closure; rendering never executes hardware. */
export const VISION_WORKSHOP_EXPERIENCE_SCRIPT = String.raw`
  function readinessReason(reason) {
    const messages = {
      vision_ai_debug_recovery_required: '参数恢复尚未确认；先核对恢复错误与实际回读，再开始新调试。',
      vision_ai_debug_stream_recovery_required: 'SDK 取帧失败，设备流恢复尚未确认；先检查错误与实际状态，再由操作者确认恢复并采集新帧。',
      camera_stream_cleanup_required: '已保存的设备探测回执要求清理采集流；先显式停止并核对清理，再确认原参数恢复与新帧，最后重新检查设备连接。该回执不代表实时状态，不自动重试。',
      isp_write_unconfirmed_restore_required: '已保存的设备探测回执显示 ISP 写入结果未确认；核对实际状态，必要时先显式停止清理，再恢复原版并回读、采集新帧，最后重新检查设备连接。不会重放失败写入。',
      native_sdk_runtime_unavailable: '原生 SDK 当前不可用；核对板端库、ABI 与实际 SDK 版本，配置登记不能证明运行兼容。',
      camera_stream_validation_failed: '媒体链路检查未通过，尚无本次有效新帧；查看 SDK 与相机执行记录，确认实际状态后再操作。',
      camera_stream_capture_failed: '实际取帧失败；查看 SDK 错误与设备流状态，不自动重启或重放失败操作。',
      vision_device_profile_mismatch: '实验与设备的 SDK 或相机模式不匹配；核对实际版本并绑定匹配的设备实验。',
      vision_device_adapter_required: '尚未绑定可用设备适配器；先检查设备登记。',
      vision_ai_debug_atomic_unavailable: '当前设备缺少采图、控制或恢复操作；先核对适配器实际能力。',
      vision_model_disabled: '看图模型尚未配置；先检查模型服务。',
      vision_device_busy: '设备正在执行已有任务；等待最终回读与恢复回执。',
      saved_operation_failed: '最近设备操作失败；查看 SDK 错误及实际参数与流状态，结果未确认时不要重复重放。',
      device_service_probe_saved_camera_unverified: '已保存设备服务探测回执；SDK 兼容性、当前出图与画质尚未通过验收。',
      pipeline_receipt_saved_live_state_unverified: '已有链路执行回执；当前流状态与画质仍需现场核对。',
      native_isp_runtime_qualification_required: '原生 ISP 运行尚未确认；需要对应接口，并核对实际 SDK 编译、运行与回读资格。',
      device_connection_requires_probe: '设备连接尚未探测；由操作者检查实际服务与连接。',
      camera_stream_requires_execution: '尚无实际出图回执；核对驱动与模式后，再由操作者执行设备检查。',
      baseline_saved_sdk_load_unverified: '已保存基础参数；SDK 加载与可恢复性仍需实际核对。',
      restorable_baseline_required: '尚无可恢复原始版本；任何调参前先保存实际回读。',
      raw_assets_saved_acquisition_and_quality_unverified: '已有 RAW 资产记录；实采来源与画质仍待核对。',
      video_frames_saved_not_bayer_raw: '已保存视频画面；这些记录不代表 Bayer RAW。',
      actual_sample_required: '尚无本实验真实样本；需要实采或导入可核对的图像。',
      sdk_readback_saved_scope_and_quality_unverified: '已保存 SDK 读回；只确认公开读回范围，画质仍待验收。',
      cpu_calibration_computed_sdk_application_unverified: '离线标定已计算；尚不能确认板端应用与画质。',
      saved_calibration_failed: '离线标定执行失败；检查材料、采集条件与计算错误。',
      recorded_calibration_inputs_required: '尚缺已记录的标定材料与采集条件。',
      evaluation_saved_full_quality_acceptance_unverified: '已有图像评价；完整项目画质验收仍待完成。',
      actual_image_evaluation_required: '尚无实际图像评价；需结合新图核对细节、噪声、颜色与曝光。',
      experiment_export_available_assets_verified_on_download: '可导出实验记录；下载时核验资产，导出不代表验收通过。'
    };
    return messages[reason] || clean(reason);
  }
  function cameraAdmission() {
    const selected = profile(); const configured = state.capabilities && state.capabilities.aiDebug;
    const missing = VISION_AI_DEBUG_REQUIRED_OPERATIONS.filter(operation => operation === 'controls_set'
      ? !supports('controls_set') && !supports('apply_tuning') : !supports(operation));
    const failedProbe = latestRun('probe') && latestRun('probe').status !== 'completed';
    const recovery = state.engineering.readiness && state.engineering.readiness.recovery;
    const streamFailed = Boolean(state.debug.run && state.debug.run.final && state.debug.run.final.streamVerification === 'failed' || recovery && recovery.streamVerification === 'failed');
    const recoveryUnconfirmed = Boolean(state.debug.run && state.debug.run.restorationError || streamFailed || recovery && recovery.status === 'unconfirmed');
    const identity = Boolean(selected && state.experiment.board && state.experiment.sensorModel && state.experiment.sdkVersion &&
      ['board', 'sensorModel', 'sdkVersion', 'sensorVendor', 'cameraInterface', 'cameraMode'].every(key => !state.experiment[key] || state.experiment[key] === selected[key]));
    return { selected, missing, identity, recoveryUnconfirmed, streamFailed, recoveryReason: recovery && recovery.reason, ready: Boolean(identity && state.engineering.readiness && !(state.engineering.readiness.aiDebug && state.engineering.readiness.aiDebug.canStart === false) && !failedProbe && !recoveryUnconfirmed && !missing.length && configured && configured.status === 'available') };
  }
  function openConnectionTools() { state.manualOpen = true; setStep(0); }
  function openCameraKnowledge() {
    const node = $('cameraKnowledge'); if (node) { node.open = true; node.scrollIntoView && node.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  function connectionPreparation(parent) {
    const detail = make('details', 'advanced'); detail.appendChild(make('summary', '', '首次接入需要准备什么？'));
    const list = make('ol', 'checklist');
    ['核对相机与开发板的排线、引脚和电压兼容性，完成实际连接。',
      '在板端准备匹配的驱动、SDK 和采集模式；需要原生服务时，用该板 SDK 编译并安装。',
      '配置设备服务和平台连接，再登记相机。连接凭据由服务端保存。',
      '创建设备实验，点击检查连接，再启动已有驱动并查看真实画面。'].forEach(text => list.appendChild(make('li', '', text)));
    append(detail, list, make('p', 'hint', '尚未支持的新相机需要先开发并验证驱动。插件当前可核对接入资料，尚未提供自动生成驱动、编译部署的流程。'));
    parent.appendChild(detail);
  }
  function renderCameraReadiness(root) {
    const admission = cameraAdmission(); const selected = admission.selected;
    const node = panel('接入检查 · 现在能做什么', '点亮使用已适配的驱动与模式。检查结果和实际出图分别确认。'); node.id = 'cameraReadiness';
    const configured = state.capabilities && state.capabilities.aiDebug;
    const operationNames = { probe: '设备探测', controls_get: '参数回读', controls_set: '参数设置', capture_frame: '实际采图', restore_tuning: '原参数恢复' };
    const latestProbe = latestRun('probe'); const probeFailed = latestProbe && latestProbe.status !== 'completed';
    let title, next;
    if (!state.capabilities) { title = '接入状态尚未确认'; next = '刷新页面重新读取能力目录，再确认设备连接。'; }
    else if (!state.experiment.targetId) { title = '当前是文件导入实验'; next = '操作真实相机需要新建设备实验并选择已登记相机；当前实验可继续导入样本。'; }
    else if (!selected) { title = '绑定的相机连接已不可用'; next = '检查服务端设备登记，恢复该连接，或新建实验绑定当前可用相机。'; }
    else if (!admission.identity) { title = '实验与设备信息不匹配'; next = '新建实验并选择实际相机，系统会填入对应的板型、型号和 SDK。'; }
    else if (probeFailed) { title = '最近设备连接检查失败'; next = '打开设备日志检查服务、连接和驱动；写入结果不明确时，先核对实际状态。'; }
    else if (admission.recoveryUnconfirmed) { title = admission.streamFailed ? 'SDK 取帧失败，设备流恢复未确认' : admission.recoveryReason === 'camera_stream_cleanup_required' ? '保存的探测回执要求清理采集流' : admission.recoveryReason === 'isp_write_unconfirmed_restore_required' ? '保存的 ISP 写入结果未确认' : '原参数恢复尚未确认'; next = readinessReason(admission.streamFailed ? 'vision_ai_debug_stream_recovery_required' : admission.recoveryReason || 'vision_ai_debug_recovery_required'); }
    else if (!state.engineering.readiness) { title = '调试与恢复条件尚未读取'; next = '刷新实验确认就绪与恢复状态；读取失败时不会开始设备执行。'; }
    else if (state.engineering.readiness.aiDebug && state.engineering.readiness.aiDebug.canStart === false && state.engineering.readiness.aiDebug.reason) { title = '设备调试的运行条件未通过'; next = readinessReason(state.engineering.readiness.aiDebug.reason); }
    else if (!admission.ready) { title = '相机已登记，AI 调试条件尚未齐备'; next = admission.missing.length ? '补齐当前相机的' + admission.missing.map(key => operationNames[key]).join('、') + '能力，再开始 AI 调试。' : '启用看图模型服务后，再开始 AI 调试。'; }
    else { title = latestProbe ? '已保存设备探测回执，可尝试 AI 调试' : '操作能力已配置，设备在线与出图待检查'; next = latestProbe ? '连接探测已完成。若尚未出图，进入设备工具启动已有驱动，再检查媒体链路与实际画面。' : '先检查设备连接；MIPI 相机未开流时，进入设备工具启动已有驱动，再查看真实画面。'; }
    const notice = make('div', 'notice' + (probeFailed ? ' bad' : '')); append(notice, make('strong', '', title), make('span', '', '下一步：' + next)); node.appendChild(notice);
    const items = make('div', 'receipt-summary');
    append(items, meta('实际采图', selected ? supports('capture_frame') ? '已配置 · 待实采' : '未提供' : '未绑定设备'),
      meta('参数读写与恢复', selected ? ['controls_get', 'controls_set', 'restore_tuning'].every(supports) ? '已配置 · 待回读验证' : '能力未齐备' : '未绑定设备'),
      meta('看图模型', configured && configured.status === 'available' ? '已配置 · 执行仍需验证' : '尚未就绪'),
      meta('RAW 与原生 ISP', selected ? supports('capture_raw') && supports('process_raw') && supports('tuning_get') ? '接口已配置 · 待专项验收' : '未提供完整链路' : '未绑定设备'));
    node.appendChild(items);
    if (configured && configured.status !== 'available' && configured.reason) node.appendChild(make('p', 'hint', '模型状态：' + configured.reason));
    if (probeFailed) node.appendChild(make('p', 'hint', '实际错误：' + clean(latestProbe.evidence && (latestProbe.evidence.code || latestProbe.evidence.error) || '请查看设备执行记录')));
    const actions = make('div', 'actions');
    append(actions, button('检查设备连接', () => mutation(() => deviceRequest('probe'), '设备探测回执已保存；请继续验证实际画面。'), true, !supports('probe') || !admission.identity || debugActive(state.debug.run)),
      button('查看设备与预览', openConnectionTools), button('查看接入资料', openCameraKnowledge));
    if (!selected) actions.appendChild(button('新建设备实验', openCreate));
    node.appendChild(actions); connectionPreparation(node); root.appendChild(node);
  }
  function debugOutcome(run) {
    const active = debugActive(run); const final = run.final;
    const streamVerification = final && final.streamVerification || 'unverified';
    const expectedHash = final && (final.restored ? run.original && run.original.hash : run.best && run.best.hash);
    const confirmed = Boolean(!active && !run.restorationError && streamVerification !== 'failed' && final && typeof final.restored === 'boolean' && /^[a-f0-9]{64}$/.test(final.hash || '') && final.hash === expectedHash);
    const snapshot = confirmed ? final.restored ? run.original : run.best : null;
    const assessment = snapshot && snapshot.hash === final.hash ? snapshot.assessment : null;
    const regressions = arr(assessment && assessment.regressions);
    const goalSatisfied = assessment && typeof assessment.goalSatisfied === 'boolean' ? assessment.goalSatisfied : run.goalSatisfied;
    let title = '调试已结束，效果尚未确认', tone = '', next = '查看实际画面与本轮观察，再决定是否保留参数。';
    if (active) { title = run.cancelRequested ? '已请求停止 · 等待恢复回执' : '正在执行，效果待判断'; next = '等待当前操作和最终回读完成。'; }
    else if (streamVerification === 'failed') { title = 'SDK 取帧失败，设备流恢复未确认'; tone = ' bad'; next = readinessReason('vision_ai_debug_stream_recovery_required'); }
    else if (run.restorationError || !confirmed) { title = '设备最终状态未确认'; tone = ' bad'; next = '查看失败记录，核对设备实际参数并恢复原始配置。'; }
    else if (run.status === 'failed' || run.status === 'interrupted') { title = '执行未完成，参数状态已记录'; tone = ' bad'; next = '根据实际错误排查后重新运行。'; }
    else if (run.status === 'canceled') { title = '已停止，参数状态已记录'; }
    else if (regressions.length) { title = 'AI 观察到画质退化，请复核'; tone = ' bad'; next = '检查退化项，必要时恢复原始参数。'; }
    else if (goalSatisfied === false) { title = '本次目标未达成'; next = '检查取景、光照和对焦；结合实际图像调整目标或继续调试。'; }
    else if (goalSatisfied === true) { title = 'AI 判断目标达到，画质待验收'; next = '核对噪点、颜色和目标细节，并在实际使用场景中验收。'; }
    const regressionNames = { noise: '噪点增加', detail: '细节损失', color: '颜色退化', exposure: '曝光退化' };
    return { title, tone, next, confirmed, streamVerification, observation: assessment && assessment.reason || '未记录最终配置的可靠视觉判断，请结合实际画面复核。',
      effects: assessment ? regressions.length ? regressions.map(key => regressionNames[key] || clean(key)).join('、') : 'AI 未报告退化，仍需实际验收' : '尚未确认',
      device: confirmed ? final.restored ? '已恢复原始参数' : '保留本次选定参数' : active ? '运行中，等待最终回读' : '当前参数未确认',
      image: active ? '等待终态新帧' : streamVerification === 'failed' ? 'SDK 取帧失败 · 流恢复未确认' : !confirmed ? '当前设备画面未确认' : final.imageError ? '终态采图失败' : final.frameId ? streamVerification === 'verified' ? '已保存并核验终态新帧' : '已有终态图记录 · 流核验未记录' : '尚无终态画面' };
  }
`;
