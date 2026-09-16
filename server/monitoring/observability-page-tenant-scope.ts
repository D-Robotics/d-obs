/**
 * 页面脚本共享的「归属」派生片段。
 *
 * 单独成一个模块是为了让**同一份实现**既进页面内联脚本、又能被 Node 侧直接
 * 求值做单元测试（页面脚本是巨型模版字符串，没有别的办法对它做真实断言）。
 * 约定与服务端 `tenantScopeFromAlertKey` 一致：`t.<tenantId>.<checkKey>`，
 * 点为分隔符，租户 id 不含点（见 tenant-store.ts 的 TENANT_ID_PATTERN）。
 */
export const OPS_TENANT_SCOPE_JS = `      function alertKeyTenant(key){const parts=String(key||'').split('.');return parts.length>=3&&parts[0]==='t'&&/^[a-z][a-z0-9-]{1,39}$/.test(parts[1])?parts[1]:''}
      function alertKeyScopeLabel(key){const tenant=alertKeyTenant(key);return tenant?('租户 '+tenant+' · '):'平台 · '}
`;
