import type { PlatformAssistantWorkContext } from '../observability/platform-assistant-context.js';
import type { PlatformAssistantTaskService } from './platform-assistant-tasks.js';
import type { PluginAssistantFragment } from './plugin-assistant-context.js';

/** Human feedback can suggest a tool sequence; it never supplies current facts or execution authority. */
export async function platformAssistantExperience(
  service: PlatformAssistantTaskService, scope: string, context: PlatformAssistantWorkContext = {}, excludeTaskId?: string,
): Promise<PluginAssistantFragment[]> {
  if (!context.view) return [];
  const exported = await service.exportCases(scope);
  return exported.cases.filter((item) => item.id !== excludeTaskId && item.feedback?.label === 'helpful'
    && item.status === 'completed' && item.context.view === context.view && item.context.environment === context.environment)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3).map((item) => ({
      pluginId: 'assistant-experience', promptId: item.id, version: String(item.revision),
      text: JSON.stringify({ kind: 'operator_labeled_workflow_hint', currentEvidence: false, authorization: 'none', verification: 'not_evaluated',
        goal: item.goal.slice(0, 1_000), toolSequence: item.response?.operations.map((operation) => ({ operationId: operation.id, httpStatus: operation.status, ok: operation.ok })) ?? [],
        guidance: '仅参考工具步骤。标记有用是操作者评价，不证明诊断正确；使用当前选中对象和本轮真实查询结果，不能复用旧对象、旧参数或旧结论。',
      }),
    }));
}
