import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'express';
import { configureObservabilityAccess, resetObservabilityAccessAdapter, type ObservabilitySessionUser } from './observability-access-adapter.js';
import { configureDashboardPoolForTest, listBoards, updateBoard, deleteBoard } from './dashboard-boards-store.js';
import { resolveDashboardOwner } from './dashboard-owner.js';

test('stable dashboard owners survive display-name changes and collisions, with trusted legacy id/email migration only', async () => {
  const users: Record<string, ObservabilitySessionUser> = {
    alice: { id: 'alice', email: 'alice@example.test', name: 'Repeated name' },
    bob: { id: 'bob', name: 'Repeated name' },
  };
  const rows: Array<Record<string, unknown>> = [
    { id: 'legacy-id', owner: 'alice', name: 'Id legacy', visibility: 'private', spec: {} },
    { id: 'legacy-email', owner: 'alice@example.test', name: 'Email legacy', visibility: 'private', spec: {} },
    { id: 'ambiguous-name', owner: 'Repeated name', name: 'Name legacy', visibility: 'private', spec: {} },
    { id: 'shared', owner: 'sso:alice', name: 'Shared', visibility: 'team', spec: {} },
    { id: 'token-owned', owner: 'admin-token', name: 'Token', visibility: 'private', spec: {} },
  ];
  const libraries: Array<Record<string, unknown>> = [{ owner: 'alice@example.test' }, { owner: 'Repeated name' }];
  const migrations: unknown[][] = [];
  configureDashboardPoolForTest({ query: async (sql, params = []) => {
    if (/where owner = any/.test(sql)) {
      migrations.push(params);
      const aliases = params[1] as string[];
      for (const row of sql.includes('studio_obs_library_panels') ? libraries : rows) if (aliases.includes(String(row.owner))) row.owner = params[0];
      return { rows: [] };
    }
    if (sql.startsWith('select *')) return { rows: rows.filter((row) => row.owner === params[0] || sql.includes("visibility = 'team'") && row.visibility === 'team') };
    if (sql.startsWith('update public.studio_obs_dashboards set')) {
      assert.match(sql, /where owner = \$\d+ and id = \$\d+/);
      const row = rows.find((row) => row.owner === params.at(-2) && row.id === params.at(-1));
      if (row) row.name = params[0];
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('delete from public.studio_obs_dashboards')) {
      const index = rows.findIndex((row) => row.owner === params[0] && row.id === params[1]);
      if (index < 0) return { rows: [], rowCount: 0 }; rows.splice(index, 1); return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  } });
  configureObservabilityAccess({ getSessionSsoUser: (req) => users[req.header('fixture-actor')!] ?? null, isMultiUserWebDeployment: () => true, allowsAnonymousLocalOperator: () => false, resolveChatPrincipalAccountId: () => '' });
  const request = (actor: string) => ({ header: (name: string) => name === 'fixture-actor' ? actor : undefined }) as Request;
  try {
    const alice = await resolveDashboardOwner(request('alice'));
    assert.equal(alice, 'sso:alice');
    assert.deepEqual((await listBoards(alice)).map((board) => board.id), ['legacy-id', 'legacy-email', 'shared']);
    assert.equal(libraries[0].owner, 'sso:alice'); assert.equal(libraries[1].owner, 'Repeated name');
    assert.ok(migrations.every((params) => !(params[1] as string[]).includes('Repeated name')));
    const bob = await resolveDashboardOwner(request('bob')); assert.equal(bob, 'sso:bob');
    const visible = await listBoards(bob); assert.equal(visible.length, 1); assert.equal(visible[0].id, 'shared'); assert.equal(visible[0].editable, false);
    assert.equal(await updateBoard(bob, 'shared', { name: 'Takeover' }), null); assert.equal(await deleteBoard(bob, 'shared'), false);
    users.alice.name = 'Changed name';
    const renamed = await resolveDashboardOwner(request('alice')); assert.equal(renamed, alice);
    assert.equal((await updateBoard(renamed, 'shared', { name: 'Still mine' }))?.editable, true);
    const before = migrations.length; await resolveDashboardOwner(request('anonymous')); assert.equal(migrations.length, before);
    assert.equal(rows.find((row) => row.id === 'ambiguous-name')?.owner, 'Repeated name');
  } finally { configureDashboardPoolForTest(null); resetObservabilityAccessAdapter(); }
});
