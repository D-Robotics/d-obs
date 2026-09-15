import { sanitizeOpsSummary } from './ops-event-store.js';
import { ensureServiceLevelSchema, getServiceLevelOverview, recordServiceLevelSamples, selectWorstServiceLevelBurn, } from './service-level-objectives.js';
function configuredObservation(config, input) {
    const rule = config.rules[input.key];
    return {
        ...input,
        enabled: rule.enabled,
        openAfter: rule.openAfter,
        resolveAfter: rule.resolveAfter,
    };
}
export async function collectServiceLevelBurnObservation(pool, config, observations) {
    try {
        await ensureServiceLevelSchema(pool);
        await recordServiceLevelSamples(pool, observations, new Date().toISOString());
        const serviceLevels = await getServiceLevelOverview(pool, { bypassCache: true });
        const worstBurn = selectWorstServiceLevelBurn(serviceLevels);
        const burnRule = config.rules['slo-error-budget-burn'];
        return worstBurn
            ? configuredObservation(config, {
                key: 'slo-error-budget-burn',
                title: 'SLO 错误预算燃烧过快',
                severity: worstBurn.burnRate >= burnRule.criticalThreshold ? 'critical' : 'warning',
                unhealthy: worstBurn.burnRate >= burnRule.threshold,
                summary: `${worstBurn.title} 最近 ${worstBurn.windowMinutes} 分钟燃烧率 ${worstBurn.burnRate.toFixed(2)}x（告警 ${burnRule.threshold}x / 严重 ${burnRule.criticalThreshold}x）`,
            })
            : configuredObservation(config, {
                key: 'slo-error-budget-burn',
                title: 'SLO 错误预算燃烧率',
                severity: 'warning',
                unhealthy: false,
                unknown: true,
                summary: 'SLO 样本尚不足，暂不触发错误预算告警',
            });
    }
    catch (error) {
        return configuredObservation(config, {
            key: 'slo-error-budget-burn',
            title: 'SLO 错误预算燃烧率',
            severity: 'warning',
            unhealthy: false,
            unknown: true,
            summary: `SLO 计算暂不可用：${sanitizeOpsSummary(error, 180) || 'unknown'}`,
        });
    }
}
