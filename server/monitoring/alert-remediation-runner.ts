/**
 * 自愈执行器：由 rdstudio-remediation@<playbook>.service oneshot 单元拉起。
 *
 * 只执行白名单剧本的固定命令序列（execFile 固定 argv，不经过 shell），每个剧本带
 * 前置安全检查（例如重启主服务前必须确认 standby active），执行过程逐步落库审计，
 * 结束后触发一轮告警评估，让恢复通知尽快闭环，并按原渠道回投自愈结果。
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadAlertConfig } from './alert-config.js';
import {
  claimRemediationRun,
  deliverRemediationNotice,
  ensureRemediationSchema,
  finishRemediationRun,
  gateRemediation,
  getRemediationPlaybook,
  assertProductionRemediationEnvironment,
  startRemediationRun,
  type RemediationStep,
  type RemediationTrigger,
} from './alert-remediation.js';
import { recordOpsEvent, sanitizeOpsSummary } from './ops-event-store.js';

const execFileAsync = promisify(execFile);

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  end: () => Promise<void>;
};

async function createPool(): Promise<Pool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  const pgMod = (await import('pg' as string)) as {
    default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
  };
  return new pgMod.default.Pool({ connectionString, max: 2 });
}

async function runFixed(
  steps: RemediationStep[],
  name: string,
  command: string,
  args: string[],
  timeoutMs = 90_000,
): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
    });
    const detail = sanitizeOpsSummary(`${stdout} ${stderr}`.trim() || 'ok', 240);
    steps.push({ name, ok: true, detail });
    return true;
  } catch (error) {
    // execFile 超时只会杀掉 systemctl 客户端，PID 1 的任务可能仍在进行，需要在审计里注明。
    const killedNote = (error as { killed?: boolean } | null)?.killed
      ? '（超时中止，底层系统任务可能仍在进行）'
      : '';
    steps.push({ name, ok: false, detail: sanitizeOpsSummary(error, 200) + killedNote });
    return false;
  }
}

async function systemctlIsActive(unit: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', unit], {
      timeout: 8_000,
      maxBuffer: 64_000,
    });
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

async function probeHealth(url: string): Promise<{ ok: boolean; detail: string }> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'rdstudio-remediation/1' },
      signal: AbortSignal.timeout(5_000),
    });
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}，${elapsedMs}ms` };
    const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    if (body?.ok !== true) return { ok: false, detail: `健康响应无 ok=true，${elapsedMs}ms` };
    return { ok: true, detail: `HTTP ${response.status}，${elapsedMs}ms` };
  } catch (error) {
    return { ok: false, detail: sanitizeOpsSummary(error, 240) };
  }
}

async function pollHealth(
  steps: RemediationStep[],
  name: string,
  url: string,
  attempts = 10,
  intervalMs = 3_000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probe = await probeHealth(url);
    if (probe.ok) {
      steps.push({ name, ok: true, detail: `第 ${attempt} 次拨测通过：${probe.detail}` });
      return true;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  steps.push({ name, ok: false, detail: `${attempts} 次拨测仍未恢复` });
  return false;
}

/**
 * 泛化剧本解释器：按 REMEDIATION_PLAYBOOKS 里的声明式步骤执行（execFile 固定
 * argv，不经过 shell）。任一步失败即中止，失败摘要取该步骤的 failSummary；
 * 全部通过取剧本的 successSummary。新增剧本只改声明，不改本函数。
 */
async function executePlaybook(
  playbookId: string,
  steps: RemediationStep[],
): Promise<{ ok: boolean; summary: string }> {
  const playbook = getRemediationPlaybook(playbookId);
  if (!playbook) {
    steps.push({ name: '剧本校验', ok: false, detail: `未知剧本 ${playbookId}` });
    return { ok: false, summary: 'unknown_remediation_playbook' };
  }
  if (playbook.disabledReason) {
    steps.push({ name: '剧本校验', ok: false, detail: playbook.disabledReason });
    return { ok: false, summary: playbook.disabledReason };
  }
  if (playbook.target !== 'local-host') {
    // 本仓库附带的 systemd 模板只覆盖本机目标；其他目标形态（如 ssh:<device>）
    // 必须先在 runner 落地对应的执行器才允许声明。
    steps.push({ name: '剧本校验', ok: false, detail: `不支持的执行目标 ${playbook.target}` });
    return { ok: false, summary: 'unsupported_remediation_target' };
  }
  for (const step of playbook.steps) {
    if (step.kind === 'assert-active') {
      if (!(await systemctlIsActive(step.unit))) {
        steps.push({ name: step.name, ok: false, detail: step.failSummary });
        return { ok: false, summary: step.failSummary };
      }
      steps.push({ name: step.name, ok: true, detail: `${step.unit} active` });
      continue;
    }
    if (step.kind === 'exec') {
      if (!(await runFixed(steps, step.name, step.command, step.args, step.timeoutMs ?? 90_000))) {
        return { ok: false, summary: step.failSummary };
      }
      continue;
    }
    // poll-health：任何一步失败都会中止后续步骤（restart-app 的公网拨测
    // 只在本机健康通过后才执行，语义与原 if/else 实现一致）。
    const ok = await pollHealth(steps, step.name, step.url, step.attempts ?? 10, step.intervalMs ?? 3_000);
    if (!ok) return { ok: false, summary: step.failSummary };
  }
  return { ok: true, summary: playbook.successSummary };
}

async function run(playbookId: string, trigger: RemediationTrigger, triggeredBy: string): Promise<void> {
  // The systemd template below is production-specific (units, ports and
  // public health URL).  Refuse before opening the DB or running any command
  // when an environment override points at staging/dev/test.
  try {
    assertProductionRemediationEnvironment();
  } catch (error) {
    console.error(`[remediation] ${sanitizeOpsSummary(error, 240)}`);
    process.exitCode = 2;
    return;
  }
  const playbook = getRemediationPlaybook(playbookId);
  const config = await loadAlertConfig();
  if (!playbook) {
    console.error(`[remediation] unknown playbook: ${playbookId}`);
    process.exitCode = 2;
    return;
  }
  let p: Pool | null = null;
  try {
    p = await createPool();
    await ensureRemediationSchema(p);
    const steps: RemediationStep[] = [];
    // 认领请求方（路由 / alert-worker）原子写入的预约行：闸门已过，
    // trigger/triggered_by 归属以预约行为准；无可认领行（手工 CLI 直跑）
    // 才自行闸门复核并建行。
    let id: string;
    let effectiveTrigger: RemediationTrigger | string = trigger;
    let effectiveTriggeredBy = triggeredBy;
    const claimed = await claimRemediationRun(p, playbookId);
    if (claimed) {
      id = claimed.id;
      effectiveTrigger = claimed.trigger;
      effectiveTriggeredBy = claimed.triggeredBy;
    } else {
      const gate = await gateRemediation(p, config, playbookId);
      if (!gate.allowed) {
        id = await startRemediationRun(p, { playbookId, trigger, triggeredBy });
        await finishRemediationRun(p, id, {
          status: 'rejected',
          summary: `闸门拒绝：${gate.reason}`,
          steps,
        });
        console.log(`[remediation] rejected playbook=${playbookId} reason=${gate.reason}`);
        return;
      }
      id = await startRemediationRun(p, { playbookId, trigger, triggeredBy });
    }
    await deliverRemediationNotice(config, {
      playbookTitle: playbook.title,
      statusLabel: '执行中',
      summary: `${playbook.description}（安全闸门：${playbook.safety}）`,
      trigger: effectiveTrigger,
      triggeredBy: effectiveTriggeredBy,
    }).catch(() => undefined);
    const startedAt = Date.now();
    const result = await executePlaybook(playbookId, steps);
    const status = result.ok ? 'succeeded' : 'failed';
    await finishRemediationRun(p, id, {
      status,
      summary: result.summary,
      steps,
    });
    await recordOpsEvent({
      component: 'alert-remediation',
      eventCode: 'remediation_run',
      outcome: result.ok ? 'ok' : 'error',
      severityHint: result.ok ? 'info' : 'warning',
      safeSummary: `${playbookId}: ${result.summary}`,
      fingerprintParts: [playbookId, String(effectiveTrigger)],
      metadata: {
        trigger: effectiveTrigger,
        triggered_by: effectiveTriggeredBy,
        elapsed_ms: Date.now() - startedAt,
      },
    }).catch(() => {});
    // 立即触发一轮评估：指标转绿后恢复通知能在下一分钟闭环。
    await execFileAsync('systemctl', ['start', 'rdstudio-alert-worker.service'], {
      timeout: 15_000,
      maxBuffer: 200_000,
    }).catch(() => {});
    await deliverRemediationNotice(config, {
      playbookTitle: playbook.title,
      statusLabel: result.ok ? '成功' : '失败',
      summary: `${result.summary}；已触发即时评估，恢复后将推送恢复通知`,
      trigger: effectiveTrigger,
      triggeredBy: effectiveTriggeredBy,
    }).catch(() => {});
    console.log(`[remediation] ${status} playbook=${playbookId}: ${result.summary}`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error('[remediation] fatal:', sanitizeOpsSummary(error, 500));
    process.exitCode = 1;
  } finally {
    await p?.end().catch(() => {});
  }
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
})();

if (invokedAsScript) {
  const [playbookId, triggerRaw, triggeredBy] = process.argv.slice(2);
  const trigger: RemediationTrigger = triggerRaw === 'auto' ? 'auto' : 'manual';
  if (!playbookId) {
    console.error('[remediation] usage: alert-remediation-runner.js <playbookId> [manual|auto] [triggeredBy]');
    process.exitCode = 2;
  } else {
    run(playbookId, trigger, String(triggeredBy ?? '').slice(0, 160) || 'systemd').catch((error) => {
      console.error('[remediation] fatal:', sanitizeOpsSummary(error, 500));
      process.exitCode = 1;
    });
  }
}
