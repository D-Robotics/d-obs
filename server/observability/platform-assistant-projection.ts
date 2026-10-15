/** Keep structured evidence across large API results, rather than a JSON prefix. */
function size(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 4; } catch { return Infinity; }
}

function weight(key: string): number {
  if (/^(serviceLevels|errorBudget|objectives|evidenceProof)$/i.test(key)) return 10;
  if (/^(summary|policy|config|modelMapping|fallbackPolicy|health|sourceAvailability|timeWindow|dataCompleteness|warnings|registrationScope)$/i.test(key)) return 6;
  if (/^(incidents|alerts|status|state|total|count|.*Cursor|.*Id)$/i.test(key)) return 3;
  return 1;
}

/** Input is redacted before projection. A sampled array explicitly retains its counts. */
export function projectPlatformAssistantData(value: unknown, budget = 12_000): unknown {
  const limit = Math.max(32, Math.min(12_000, Math.floor(budget)));
  function project(item: unknown, available: number, depth: number): unknown {
    if (size(item) <= available) return item ?? null;
    if (available < 100 || depth >= 12) return { truncated: true };
    if (typeof item === 'string') {
      let lo = 0; let hi = item.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (size(item.slice(0, mid) + '…[截断]') <= available) lo = mid;
        else hi = mid - 1;
      }
      return item.slice(0, lo) + '…[截断]';
    }
    if (Array.isArray(item)) {
      const result = { items: [] as unknown[], totalItems: item.length, includedItems: 0, truncated: true };
      const count = Math.min(item.length, 8, Math.max(1, Math.floor((available - 100) / 500)));
      let remaining = available - size(result) - count;
      for (let index = 0; index < count; index++) {
        const allocation = Math.max(24, Math.floor(remaining / (count - index)));
        const entry = project(item[index], allocation, depth + 1);
        result.items.push(entry); remaining -= size(entry);
      }
      result.includedItems = result.items.length;
      while (size(result) > available && result.items.length) {
        result.items.pop(); result.includedItems = result.items.length;
      }
      return result;
    }
    if (item && typeof item === 'object') {
      const original = Object.entries(item);
      const entries = original.slice(0, 128).sort(([a], [b]) => weight(b) - weight(a));
      const result: Record<string, unknown> = Object.create(null);
      result._assistantProjection = { truncated: true, totalEntries: original.length, omittedEntries: original.length - entries.length };
      const overhead = entries.reduce((sum, [key]) => sum + size(key) + 2, size(result));
      let remaining = available - overhead;
      const large: Array<[string, unknown]> = [];
      for (const [key, child] of entries) {
        const childSize = size(child);
        if (childSize <= 180 && remaining - childSize >= (entries.length - Object.keys(result).length) * 24) {
          result[key] = child; remaining -= childSize;
        } else large.push([key, child]);
      }
      let weights = large.reduce((sum, [key]) => sum + weight(key), 0);
      for (const [key, child] of large) {
        const allocation = Math.max(24, Math.floor(Math.max(0, remaining) * weight(key) / weights));
        result[key] = project(child, allocation, depth + 1);
        remaining -= size(result[key]); weights -= weight(key);
      }
      const keys = entries.map(([key]) => key);
      while (size(result) > available && keys.length) {
        const key = keys.pop()!;
        delete result[key];
        (result._assistantProjection as { omittedEntries: number }).omittedEntries++;
      }
      return size(result) <= available ? result : { truncated: true };
    }
    return null;
  }
  return project(value, limit, 0);
}

/** Human-readable fallback uses only the already redacted model-pool snapshot. */
export function formatModelPoolSnapshot(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, any>;
  const summary = data.health?.summary;
  const mappings = data.config?.modelMapping;
  if (!summary || typeof summary !== 'object' || !mappings || typeof mappings !== 'object') return null;
  const text = (item: unknown, max = 180) => typeof item === 'string' ? item.replace(/[\r\n\0]/g, ' ').slice(0, max) : '';
  const total = Number.isFinite(summary.totalTargets) ? summary.totalTargets : data.sourceCounts?.targets;
  const counts = [['healthy', '健康'], ['cooldown', '冷却'], ['halfOpen', '半开']] as const;
  const distribution = counts.filter(([key]) => Number.isFinite(summary[key])).map(([key, label]) => `${summary[key]} 个${label}`).join('、');
  const states: Record<string, string> = { healthy: '健康', cooldown: '冷却', half_open: '半开', unknown: '未知' };
  const lines = [
    '只读查询已完成。',
    `当前模型池${Number.isFinite(total) ? `有 ${total} 个目标` : '目标总数未提供'}${distribution ? `：${distribution}` : '，健康分布未提供'}${Number.isFinite(summary.degraded) ? `；其中 ${summary.degraded} 个处于降级状态` : ''}。`,
    '', '目标状态：',
  ];
  for (const target of Array.isArray(data.health?.targets) ? data.health.targets.slice(0, 20) : []) {
    if (!target || typeof target !== 'object') continue;
    const state = text(target.state, 40);
    lines.push(`- ${text(target.label) || text(target.model)}：${states[state] || state || '未提供状态'}${target.lastHealthError ? `，原因 ${text(target.lastHealthError)}` : ''}${target.disabledUntil ? `，冷却至 ${text(target.disabledUntil, 80)}` : ''}。`);
  }
  lines.push('', '前端路由与 fallback：');
  for (const [name, mapping] of Object.entries(mappings).slice(0, 20)) {
    if (!mapping || typeof mapping !== 'object') continue;
    const entry = mapping as Record<string, unknown>;
    const fallbacks = Array.isArray(entry.fallbacks) ? entry.fallbacks.filter((item) => typeof item === 'string').map((item) => text(item)).join(' → ') : '';
    lines.push(`- ${text(name)} → ${text(entry.model) || '未提供上游名称'}；fallback：${fallbacks || '未列出备援'}。`);
  }
  const policy = data.config?.fallbackPolicy;
  if (policy && typeof policy.enabled === 'boolean') {
    lines.push('', `降级策略当前${policy.enabled ? '处于启用状态' : '处于停用状态'}${Number.isFinite(policy.failureThreshold) ? `，连续失败阈值 ${policy.failureThreshold} 次` : ''}。`);
  }
  lines.push(text(data.protectedFrontendModel) ? `受保护主模型：${text(data.protectedFrontendModel)}。` : '后端当前未标出受保护的主模型名称。');
  if (data.health?.targets?.length > 20 || Object.keys(mappings).length > 20 || (data.sourceCounts && data.includedCounts && (data.sourceCounts.targets !== data.includedCounts.targets || data.sourceCounts.modelMappings !== data.includedCounts.modelMappings))) {
    lines.push('此摘要仅包含部分目标或路由，完整数据请查看操作回执。');
  } else if (data.compacted === true) {
    lines.push('此为压缩摘要，完整数据请查看操作回执。');
  }
  lines.push('', '以上来自本轮实际查询，本轮未修改模型池配置。');
  const reply = lines.join('\n');
  return reply.length <= 6_000 ? reply : reply.slice(0, 5_800) + '\n摘要已截断，完整数据请查看操作回执。';
}

/** Deterministic SLO answer uses only the actual overview.serviceLevels receipt. */
export function formatServiceLevelSnapshot(value: unknown): string | null {
  const record = (item: unknown): Record<string, unknown> | null =>
    item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
  const root = record(value);
  const overview = record(root?.overview);
  if (!overview) return null;
  const data = record(overview.serviceLevels);
  let truncated = root?.truncated === true || overview.truncated === true
    || record(root?._assistantProjection)?.truncated === true
    || record(overview._assistantProjection)?.truncated === true;
  const seen = new WeakSet<object>();
  const findTruncation = (item: unknown, depth = 0): void => {
    if (typeof item === 'string' && /\[截断\]|\[Truncated\]/.test(item)) truncated = true;
    if (!item || typeof item !== 'object' || seen.has(item) || depth > 12) return;
    seen.add(item);
    const object = record(item);
    if (object?.truncated === true || object?.compacted === true) truncated = true;
    for (const child of Object.values(item).slice(0, 128)) findTruncation(child, depth + 1);
  };
  findTruncation(data);
  const text = (item: unknown, max = 160): string => {
    if (typeof item !== 'string') return '';
    if (item.length > max) truncated = true;
    return item.replace(/[\r\n\0]/g, ' ').slice(0, max);
  };
  const number = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item);
  const count = (item: unknown): item is number => number(item) && Number.isSafeInteger(item) && item >= 0;
  const policy = record(data?.policy);
  const lines = [
    `SLO 与错误预算${number(policy?.windowDays) ? `（${policy.windowDays} 天滚动窗口）` : ''}：`,
  ];
  if (!data) {
    lines.push('本轮概览未提供 SLO 数据，错误预算暂不可用。');
  } else {
    if (text(data.generatedAt)) lines.push(`数据生成时间：${text(data.generatedAt)}。`);
    const summary = record(data.summary);
    const aggregates = [
      ['total', '目标'], ['healthy', '达标'], ['atRisk', '预算告急'],
      ['exhausted', 'SLO 未达标'], ['slaBreached', '低于 SLA 参考线'], ['noData', '样本不足'],
    ] as const;
    const distribution = aggregates.filter(([key]) => count(summary?.[key]))
      .map(([key, label]) => `${summary![key]} 项${label}`).join('、');
    if (distribution) lines.push(`平台汇总：${distribution}。`);
    const sampled = record(data.objectives);
    const objectives = Array.isArray(data.objectives) ? data.objectives
      : Array.isArray(sampled?.items) ? sampled.items : [];
    if (sampled?.truncated === true || (count(sampled?.totalItems) && sampled.totalItems > objectives.length)) truncated = true;
    if (objectives.length > 20) truncated = true;
    const states: Record<string, string> = {
      healthy: '达标', at_risk: '预算告急', budget_exhausted: 'SLO 未达标',
      sla_breached: '低于 SLA 参考线', no_data: '样本不足',
    };
    let included = 0;
    for (const entry of objectives.slice(0, 20)) {
      const item = record(entry);
      if (!item) continue;
      included++;
      const name = text(item.title) || text(item.key) || '未提供名称的目标';
      const status = text(item.status, 60);
      const target = number(item.targetPercent) ? `目标 ${item.targetPercent}%` : '目标百分比未提供';
      const samples = count(item.sampleCount) ? `样本 ${item.sampleCount}${count(item.minimumSamples) ? ` / 最少 ${item.minimumSamples}` : ''}` : '样本数未提供';
      lines.push('', `- ${name}：${states[status] || status || '状态未提供'}；SLO ${target}；${samples}。`);
      if (item.dataAvailable === false) {
        lines.push('  暂无有效样本，当前 SLI 与错误预算尚不可判定。');
        continue;
      }
      lines.push(`  当前 SLI：${number(item.compliancePercent) ? `${item.compliancePercent}%` : '未提供'}。`);
      if (item.status === 'no_data') lines.push('  样本不足，当前指标与错误预算仅供参考，尚不能确认 SLO 达标。');
      const budget = record(item.errorBudget);
      const amounts = [
        ['allowedBad', '允许坏事件'], ['consumedBad', '已消耗'], ['remainingBad', '剩余坏事件'],
      ] as const;
      const details = amounts.filter(([key]) => number(budget?.[key]))
        .map(([key, label]) => `${label} ${budget![key]} 次`);
      if (!budget || (!number(budget.remainingPercent) && !details.length)) {
        lines.push('  错误预算：未提供。');
      } else {
        lines.push(`  错误预算：${number(budget.remainingPercent) ? `剩余 ${budget.remainingPercent}%` : '剩余百分比未提供'}${details.length ? `；${details.join('、')}` : ''}。`);
      }
    }
    if (!included) lines.push('本轮未返回 SLO 目标明细，错误预算明细未提供。');
  }
  if (truncated) lines.push('', '此摘要包含压缩或截断数据，未列出的目标或字段无法确认，完整数据请查看操作回执。');
  lines.push('', '以上来自本轮实际只读查询。');
  const reply = lines.join('\n');
  return reply.length <= 6_000 ? reply : reply.slice(0, 5_800) + '\n摘要已截断，未列出的目标或字段无法确认，完整数据请查看操作回执。';
}
