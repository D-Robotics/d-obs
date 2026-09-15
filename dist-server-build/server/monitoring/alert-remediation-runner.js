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
import { claimRemediationRun, deliverRemediationNotice, ensureRemediationSchema, finishRemediationRun, gateRemediation, getRemediationPlaybook, assertProductionRemediationEnvironment, startRemediationRun, } from './alert-remediation.js';
import { recordOpsEvent, sanitizeOpsSummary } from './ops-event-store.js';
const execFileAsync = promisify(execFile);
async function createPool() {
    const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
    if (!connectionString)
        throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
    const pgMod = (await import('pg'));
    return new pgMod.default.Pool({ connectionString, max: 2 });
}
async function runFixed(steps, name, command, args, timeoutMs = 90_000) {
    try {
        const { stdout, stderr } = await execFileAsync(command, args, {
            timeout: timeoutMs,
            maxBuffer: 2_000_000,
        });
        const detail = sanitizeOpsSummary(`${stdout} ${stderr}`.trim() || 'ok', 240);
        steps.push({ name, ok: true, detail });
        return true;
    }
    catch (error) {
        // execFile 超时只会杀掉 systemctl 客户端，PID 1 的任务可能仍在进行，需要在审计里注明。
        const killedNote = error?.killed
            ? '（超时中止，底层系统任务可能仍在进行）'
            : '';
        steps.push({ name, ok: false, detail: sanitizeOpsSummary(error, 200) + killedNote });
        return false;
    }
}
async function systemctlIsActive(unit) {
    try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', unit], {
            timeout: 8_000,
            maxBuffer: 64_000,
        });
        return stdout.trim() === 'active';
    }
    catch {
        return false;
    }
}
async function probeHealth(url) {
    const startedAt = Date.now();
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'user-agent': 'rdstudio-remediation/1' },
            signal: AbortSignal.timeout(5_000),
        });
        const elapsedMs = Date.now() - startedAt;
        if (!response.ok)
            return { ok: false, detail: `HTTP ${response.status}，${elapsedMs}ms` };
        const body = (await response.json().catch(() => null));
        if (body?.ok !== true)
            return { ok: false, detail: `健康响应无 ok=true，${elapsedMs}ms` };
        return { ok: true, detail: `HTTP ${response.status}，${elapsedMs}ms` };
    }
    catch (error) {
        return { ok: false, detail: sanitizeOpsSummary(error, 240) };
    }
}
async function pollHealth(steps, name, url, attempts = 10, intervalMs = 3_000) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const probe = await probeHealth(url);
        if (probe.ok) {
            steps.push({ name, ok: true, detail: `第 ${attempt} 次拨测通过：${probe.detail}` });
            return true;
        }
        if (attempt < attempts)
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    steps.push({ name, ok: false, detail: `${attempts} 次拨测仍未恢复` });
    return false;
}
const INTERNAL_HEALTH_URL = 'http://127.0.0.1:18090/api/health';
const STANDBY_HEALTH_URL = 'http://127.0.0.1:18091/api/health';
const PUBLIC_HEALTH_URL = 'https://rdkstudio.d-robotics.cc/rdkstudio/api/health';
async function executePlaybook(playbookId, steps) {
    if (playbookId === 'restart-app') {
        // 零停机前提：standby 必须 active，nginx 才能在重启窗口 failover。
        if (!(await systemctlIsActive('rdstudio-web-opt-standby.service'))) {
            steps.push({
                name: '前置检查：standby active',
                ok: false,
                detail: 'rdstudio-web-opt-standby 不 active，拒绝重启主服务',
            });
            return { ok: false, summary: 'standby 不 active，安全闸门拒绝重启主服务' };
        }
        steps.push({ name: '前置检查：standby active', ok: true, detail: 'failover 能力就绪' });
        if (!(await runFixed(steps, '重启主服务', 'systemctl', ['restart', 'rdstudio-web-opt.service']))) {
            return { ok: false, summary: 'systemctl restart rdstudio-web-opt 失败' };
        }
        const internal = await pollHealth(steps, '验证：本机健康', INTERNAL_HEALTH_URL);
        const publicOk = internal
            ? await pollHealth(steps, '验证：公网健康', PUBLIC_HEALTH_URL, 5, 2_000)
            : false;
        return internal && publicOk
            ? { ok: true, summary: '主服务已重启，本机与公网健康检查通过' }
            : { ok: false, summary: '主服务已重启，但健康验证未通过' };
    }
    if (playbookId === 'restart-standby') {
        if (!(await systemctlIsActive('rdstudio-web-opt.service'))) {
            steps.push({
                name: '前置检查：主服务 active',
                ok: false,
                detail: 'rdstudio-web-opt 不 active，拒绝重启 standby',
            });
            return { ok: false, summary: '主服务不 active，安全闸门拒绝重启 standby' };
        }
        steps.push({ name: '前置检查：主服务 active', ok: true, detail: '重启 standby 不影响流量' });
        if (!(await runFixed(steps, '重启 standby', 'systemctl', [
            'restart',
            'rdstudio-web-opt-standby.service',
        ]))) {
            return { ok: false, summary: 'systemctl restart rdstudio-web-opt-standby 失败' };
        }
        const ok = await pollHealth(steps, '验证：standby 健康', STANDBY_HEALTH_URL);
        return ok
            ? { ok: true, summary: 'standby 已重启并恢复健康，failover 能力恢复' }
            : { ok: false, summary: 'standby 已重启，但 18091 健康验证未通过' };
    }
    if (playbookId === 'reload-nginx') {
        if (!(await runFixed(steps, '配置校验 nginx -t', 'nginx', ['-t'], 15_000))) {
            return { ok: false, summary: 'nginx -t 未通过，拒绝 reload' };
        }
        if (!(await runFixed(steps, '重载 nginx', 'systemctl', ['reload', 'nginx.service'], 30_000))) {
            return { ok: false, summary: 'systemctl reload nginx 失败' };
        }
        const ok = await pollHealth(steps, '验证：公网健康', PUBLIC_HEALTH_URL, 5, 2_000);
        return ok
            ? { ok: true, summary: 'nginx 已 reload，公网健康检查通过' }
            : { ok: false, summary: 'nginx 已 reload，但公网健康验证未通过' };
    }
    if (playbookId === 'run-evolution') {
        steps.push({
            name: '剧本校验：进化 worker',
            ok: false,
            detail: '进化 worker 使用独立 DSH host，当前不允许从 remediation/action 路径触发',
        });
        return { ok: false, summary: '进化 worker 直达触发已关闭' };
    }
    steps.push({ name: '剧本校验', ok: false, detail: `未知剧本 ${playbookId}` });
    return { ok: false, summary: 'unknown_remediation_playbook' };
}
async function run(playbookId, trigger, triggeredBy) {
    // The systemd template below is production-specific (units, ports and
    // public health URL).  Refuse before opening the DB or running any command
    // when an environment override points at staging/dev/test.
    try {
        assertProductionRemediationEnvironment();
    }
    catch (error) {
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
    let p = null;
    try {
        p = await createPool();
        await ensureRemediationSchema(p);
        const steps = [];
        // 认领请求方（路由 / alert-worker）原子写入的预约行：闸门已过，
        // trigger/triggered_by 归属以预约行为准；无可认领行（手工 CLI 直跑）
        // 才自行闸门复核并建行。
        let id;
        let effectiveTrigger = trigger;
        let effectiveTriggeredBy = triggeredBy;
        const claimed = await claimRemediationRun(p, playbookId);
        if (claimed) {
            id = claimed.id;
            effectiveTrigger = claimed.trigger;
            effectiveTriggeredBy = claimed.triggeredBy;
        }
        else {
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
        }).catch(() => { });
        // 立即触发一轮评估：指标转绿后恢复通知能在下一分钟闭环。
        await execFileAsync('systemctl', ['start', 'rdstudio-alert-worker.service'], {
            timeout: 15_000,
            maxBuffer: 200_000,
        }).catch(() => { });
        await deliverRemediationNotice(config, {
            playbookTitle: playbook.title,
            statusLabel: result.ok ? '成功' : '失败',
            summary: `${result.summary}；已触发即时评估，恢复后将推送恢复通知`,
            trigger: effectiveTrigger,
            triggeredBy: effectiveTriggeredBy,
        }).catch(() => { });
        console.log(`[remediation] ${status} playbook=${playbookId}: ${result.summary}`);
        process.exitCode = result.ok ? 0 : 1;
    }
    catch (error) {
        console.error('[remediation] fatal:', sanitizeOpsSummary(error, 500));
        process.exitCode = 1;
    }
    finally {
        await p?.end().catch(() => { });
    }
}
const invokedAsScript = (() => {
    const entry = process.argv[1];
    if (!entry)
        return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
    }
})();
if (invokedAsScript) {
    const [playbookId, triggerRaw, triggeredBy] = process.argv.slice(2);
    const trigger = triggerRaw === 'auto' ? 'auto' : 'manual';
    if (!playbookId) {
        console.error('[remediation] usage: alert-remediation-runner.js <playbookId> [manual|auto] [triggeredBy]');
        process.exitCode = 2;
    }
    else {
        run(playbookId, trigger, String(triggeredBy ?? '').slice(0, 160) || 'systemd').catch((error) => {
            console.error('[remediation] fatal:', sanitizeOpsSummary(error, 500));
            process.exitCode = 1;
        });
    }
}
