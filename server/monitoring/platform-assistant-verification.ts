import type { PlatformAssistantArgs, PlatformAssistantOperation, PlatformAssistantOperationResult } from '../observability/platform-assistant.js';

/** Plan a read of the exact changed resource, without inventing a verification endpoint. */
export function platformAssistantReadback(
  mutation: PlatformAssistantOperation, args: PlatformAssistantArgs, receipt: PlatformAssistantOperationResult,
  catalog: PlatformAssistantOperation[],
): { id: string; args: PlatformAssistantArgs } | undefined {
  if (!receipt.ok || !mutation.mutating || mutation.method === 'DELETE') return undefined;
  const find = (path: string) => catalog.find((item) => item.method === 'GET' && !item.mutating && item.path === path);
  const scoped = (operation: PlatformAssistantOperation, params?: Record<string, string>): { id: string; args: PlatformAssistantArgs } => {
    const guidance = operation.parameters?.query;
    const query = Object.fromEntries(Object.entries(args.query ?? {}).filter(([key]) => guidance && Object.hasOwn(guidance, key)));
    return { id: operation.id, args: { ...(params && Object.keys(params).length ? { params } : {}), ...(Object.keys(query).length ? { query } : {}) } };
  };
  // A POST collection prefers the returned object's detail. An exact parameterized path can be read directly.
  let operation = mutation.method === 'POST' && !mutation.path.includes('/:') ? undefined : find(mutation.path);
  if (!operation && /\/(?:execute|verify|decision|complete|status|role)$/.test(mutation.path)) {
    operation = find(mutation.path.replace(/\/[^/]+$/, ''));
  }
  if (operation) {
    const params = Object.fromEntries([...operation.path.matchAll(/:([A-Za-z0-9_]+)/g)]
      .map((item) => [item[1], args.params?.[item[1]]]).filter((item): item is [string, string] => typeof item[1] === 'string' && !!item[1]));
    const required = [...operation.path.matchAll(/:([A-Za-z0-9_]+)/g)];
    if (required.every((item) => params[item[1]])) return scoped(operation, params);
  }
  // Collection creates return server-issued IDs. A list result is insufficient to identify a new object.
  const data = receipt.data && typeof receipt.data === 'object' && !Array.isArray(receipt.data) ? receipt.data as Record<string, unknown> : {};
  const collections: Array<[string, string, string]> = [
    ['/api/ops/observability/boards', 'board', 'boardId'],
    ['/api/ops/observability/tenants', 'tenant', 'tenantId'],
    ['/api/ops/observability/actions', 'action', 'id'],
    ['/api/ops/observability/strategies', 'strategy', 'strategyId'],
    ['/api/ops/observability/devices', 'device', 'deviceId'],
  ];
  for (const [path, key, parameter] of collections) {
    if (mutation.path !== path || mutation.method !== 'POST') continue;
    operation = find(`${path}/:${parameter}`);
    const resource = data[key];
    const id = resource && typeof resource === 'object' && !Array.isArray(resource) ? (resource as Record<string, unknown>).id : undefined;
    if (operation && typeof id === 'string' && id && id.length <= 4_096) return scoped(operation, { [parameter]: id });
  }
  for (const [path] of collections) {
    if (mutation.path === path || mutation.path === `${path}/:boardId` || mutation.path === `${path}/:strategyId`
      || mutation.path === `${path}/:tenantId` || mutation.path === `${path}/:deviceId`) {
      const list = find(path);
      if (list) return scoped(list);
    }
  }
  return undefined;
}
