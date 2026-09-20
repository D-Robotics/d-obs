/** 租户域路由：租户生命周期、探针 token 轮换、组员管理（admin / 本租户 SSO owner）。 */
import { type Request, type Response, type Router } from 'express';
import {
  clientErrorCode,
  requireObservabilityAccess,
  requireObservabilityAccessTenantAware,
  requireOpsMutationGuard,
  resolveOpsActor,
  tenantScopeGate,
} from './observability-route-kit.js';
import { isOpsAdminRequest, resolveTenantMemberAccess } from './observability-access.js';
import { recordOpsConfigurationAudit } from './observability-store.js';
export function registerTenantRoutes(router: Router): void {
  // ---- 租户管理（平台管理员；组员域部分对 SSO owner 开放） ----

  /**
   * 租户变更权限：平台管理员放行；SSO 组员仅 owner 且限本租户（探针 token
   * 通道只读，始终 403）。返回 null = 无权限（调用方 403）。
   */
  const resolveTenantMutationActor = async (
    req: Request,
    tenantId: string,
  ): Promise<'admin' | 'owner' | null> => {
    if (isOpsAdminRequest(req)) return 'admin';
    const membership = await resolveTenantMemberAccess(req).catch(() => null);
    if (membership && membership.tenantId === tenantId && membership.role === 'owner') {
      return 'owner';
    }
    return null;
  };

  router.get('/api/ops/observability/tenants', requireObservabilityAccess, async (_req, res) => {
    try {
      const { listTenants } = await import('./tenant-store.js');
      const tenants = await listTenants();
      let memberCounts: Record<string, number> = {};
      try {
        const { countMembersByTenant } = await import('./tenant-members-store.js');
        memberCounts = await countMembersByTenant();
      } catch {
        /* 组员计数失败不阻塞列表（fail-open 只影响这一列） */
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        tenants: tenants.map((tenant) => ({
          ...tenant,
          memberCount: memberCounts[tenant.tenantId] ?? 0,
        })),
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: clientErrorCode(error, 'tenant_list_unavailable'),
      });
    }
  });

  // ---- 租户组员（admin 或本租户 owner 可管理；SSO member 只读本租户名单） ----

  router.get(
    '/api/ops/observability/tenants/:tenantId/members',
    tenantScopeGate,
    requireObservabilityAccessTenantAware,
    async (req: Request, res: Response) => {
      const tenantId = String(req.params.tenantId ?? '').trim();
      const tenantAccess = req.opsTenantAccess ?? null;
      // SSO member（组员通道）只允许查看本租户名单；探针 token 通道 403。
      if (tenantAccess && tenantAccess.source === 'token') {
        res.status(403).json({ ok: false, error: 'tenant_read_only' });
        return;
      }
      if (
        tenantAccess &&
        tenantAccess.source === 'member' &&
        tenantAccess.tenantId !== tenantId
      ) {
        res.status(403).json({ ok: false, error: 'not_a_member' });
        return;
      }
      const mutationActor = tenantAccess ? 'member-view' : await resolveTenantMutationActor(req, tenantId);
      if (!tenantAccess && !mutationActor) {
        res.status(403).json({ ok: false, error: 'not_authorized' });
        return;
      }
      try {
        const { listMembers } = await import('./tenant-members-store.js');
        const members = await listMembers(tenantId);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, members });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: clientErrorCode(error, 'tenant_members_unavailable'),
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/tenants/:tenantId/members',
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const tenantId = String(req.params.tenantId ?? '').trim();
      const actor = await resolveTenantMutationActor(req, tenantId);
      if (!actor) {
        res.status(403).json({ ok: false, error: 'not_authorized' });
        return;
      }
      const role = String(req.body?.role ?? 'member').trim();
      if (role !== 'owner' && role !== 'member') {
        res.status(400).json({ ok: false, error: 'invalid_member_role' });
        return;
      }
      try {
        const { addMember } = await import('./tenant-members-store.js');
        const member = await addMember({
          tenantId,
          ssoUserId: req.body?.ssoUserId,
          displayName: req.body?.displayName,
          role,
          addedBy: resolveOpsActor(req),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'tenant_member_add',
          summary: `租户 ${tenantId} 添加组员 ${member.ssoUserId}（${role}）`,
        });
        res.status(201).json({ ok: true, member });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'tenant_disabled') {
          res.status(400).json({ ok: false, error: 'tenant_disabled' });
          return;
        }
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'tenant_member_add_failed'),
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/tenants/:tenantId/members/:ssoUserId/role',
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const tenantId = String(req.params.tenantId ?? '').trim();
      const ssoUserId = String(req.params.ssoUserId ?? '').trim();
      const role = String(req.body?.role ?? '').trim();
      const actor = await resolveTenantMutationActor(req, tenantId);
      if (!actor) {
        res.status(403).json({ ok: false, error: 'not_authorized' });
        return;
      }
      if (role !== 'owner' && role !== 'member') {
        res.status(400).json({ ok: false, error: 'invalid_member_role' });
        return;
      }
      try {
        // 「最后一个 owner 不可降级」由 store 在每租户临界区内判定（并发安全），
        // 路由层不再先查后写。
        const { setMemberRole } = await import('./tenant-members-store.js');
        const member = await setMemberRole(tenantId, ssoUserId, role);
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'tenant_member_role',
          summary: `租户 ${tenantId} 组员 ${ssoUserId} 角色改为 ${role}`,
        });
        res.json({ ok: true, member });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'member_not_found') {
          res.status(404).json({ ok: false, error: 'member_not_found' });
          return;
        }
        if (message === 'last_owner_role_required') {
          res.status(400).json({ ok: false, error: 'last_owner_role_required' });
          return;
        }
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'tenant_member_role_failed'),
        });
      }
    },
  );

  router.delete(
    '/api/ops/observability/tenants/:tenantId/members/:ssoUserId',
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const tenantId = String(req.params.tenantId ?? '').trim();
      const ssoUserId = String(req.params.ssoUserId ?? '').trim();
      const actor = await resolveTenantMutationActor(req, tenantId);
      if (!actor) {
        res.status(403).json({ ok: false, error: 'not_authorized' });
        return;
      }
      try {
        // 「最后一个 owner 不可移除」同样由 store 在临界区内判定。
        const { removeMember } = await import('./tenant-members-store.js');
        await removeMember(tenantId, ssoUserId);
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'tenant_member_remove',
          summary: `租户 ${tenantId} 移除组员 ${ssoUserId}`,
        });
        res.json({ ok: true });
      } catch (error) {
        const message = String((error as Error)?.message ?? '');
        if (message === 'member_not_found') {
          res.status(404).json({ ok: false, error: 'member_not_found' });
          return;
        }
        if (message === 'last_owner_required') {
          res.status(400).json({ ok: false, error: 'last_owner_required' });
          return;
        }
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'tenant_member_remove_failed'),
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/tenants',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      try {
        const { createTenant } = await import('./tenant-store.js');
        const { tenant, token } = await createTenant({
          tenantId: req.body?.tenantId,
          displayName: req.body?.displayName,
          createdBy: resolveOpsActor(req),
        });
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'tenant_create',
          summary: `创建租户 ${tenant.tenantId}（${tenant.displayName}）`,
        });
        // token 明文只在创建响应里返回一次；库里只存哈希。
        res.status(201).json({ ok: true, tenant, probeToken: token });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'tenant_create_failed'),
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/tenants/:tenantId/token',
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const tenantId = String(req.params.tenantId ?? '');
      const actor = await resolveTenantMutationActor(req, tenantId);
      if (!actor) {
        res.status(403).json({ ok: false, error: 'not_authorized' });
        return;
      }
      try {
        const { rotateTenantToken } = await import('./tenant-store.js');
        const token = await rotateTenantToken(tenantId);
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'tenant_token_rotate',
          summary: `轮换租户探针 token：${tenantId}`,
        });
        res.json({ ok: true, probeToken: token });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'tenant_token_rotate_failed'),
        });
      }
    },
  );

  router.post(
    '/api/ops/observability/tenants/:tenantId/status',
    requireObservabilityAccess,
    requireOpsMutationGuard,
    async (req: Request, res: Response) => {
      const status = String(req.body?.status ?? '').trim();
      if (status !== 'active' && status !== 'disabled') {
        res.status(400).json({ ok: false, error: 'invalid_tenant_status' });
        return;
      }
      try {
        const { setTenantStatus } = await import('./tenant-store.js');
        await setTenantStatus(String(req.params.tenantId ?? ''), status);
        await recordOpsConfigurationAudit({
          actor: resolveOpsActor(req),
          action: 'tenant_status',
          summary: `租户 ${String(req.params.tenantId ?? '')} 状态改为 ${status}`,
        });
        res.json({ ok: true });
      } catch (error) {
        res.status(400).json({
          ok: false,
          error: clientErrorCode(error, 'tenant_status_failed'),
        });
      }
    },
  );
}
