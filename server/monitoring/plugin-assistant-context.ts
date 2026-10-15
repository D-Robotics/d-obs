import type { PluginRuntime } from '../plugins/plugin-runtime.js';
import { redactPlatformAssistantText } from '../observability/platform-assistant-redaction.js';
import { getConfiguredPluginRuntime } from './plugin-routes.js';

export type PluginAssistantFragment = { pluginId: string; promptId: string; version: string; text: string };
/** Published business prompts remain untrusted context; API authorization stays in the host. */
export async function loadPluginAssistantContext(owner: string, runtime: PluginRuntime = getConfiguredPluginRuntime()): Promise<PluginAssistantFragment[]> {
  if (!owner || owner === 'ops-admin') return [];
  const result: PluginAssistantFragment[] = [];
  let remaining = 12_000;
  try {
    const catalog = await runtime.catalog(owner);
    for (const summary of catalog.plugins.filter(item => item.enabled && item.version)) {
      const detail = await runtime.detail(owner, summary.id);
      if (!detail.enabled || !detail.published) continue;
      for (const prompt of detail.published.manifest.prompts) {
        if (remaining <= 0 || result.length >= 24) return result;
        const text = redactPlatformAssistantText(prompt.text).slice(0, remaining);
        result.push({ pluginId: detail.id, promptId: prompt.id, version: detail.published.manifest.version, text });
        remaining -= text.length;
      }
    }
    return result;
  } catch {
    // A unavailable extension never disables the existing assistant or invents its configuration.
    return [{ pluginId: 'plugin-host', promptId: 'availability', version: '1.0.0', text: '本轮已安装插件的业务说明未能完整读取，不能声称插件已启用或查询成功；原平台 API 仍按能力目录执行。' }];
  }
}
