/**
 * SSO 中继回归测试：登录转发契约、会话校验（sessionId 必须回显一致）、
 * 60s 正负缓存、网络错误不缓存、未配置中继 fail-closed、登录限流。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Request } from 'express';

import {
  SSO_RELAY_SESSION_HEADER,
  SsoRelayError,
  forgetSsoRelaySession,
  getSsoRelaySessionUser,
  loginViaSsoRelay,
  logoutViaSsoRelay,
  normalizeSsoRelaySessionId,
  resetSsoRelayLoginRateForTest,
  resetSsoRelaySessionCacheForTest,
  ssoRelayConfigured,
  ssoRelayLoginRateAllow,
  ssoRelayLoginRateDefaultMaxForTest,
  verifySsoRelaySession,
} from './sso-relay.js';

const SID = 'a'.repeat(64);
const ENV = { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' } as Record<
  string,
  string | undefined
>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  resetSsoRelaySessionCacheForTest();
  resetSsoRelayLoginRateForTest();
});

afterEach(() => {
  resetSsoRelaySessionCacheForTest();
  resetSsoRelayLoginRateForTest();
});

test('配置判定与 sessionId 规范化', () => {
  assert.equal(ssoRelayConfigured(ENV), true);
  assert.equal(ssoRelayConfigured({}), false);
  assert.equal(ssoRelayConfigured({ RDK_SSO_RELAY_BASE_URL: 'ftp://x' }), false);
  assert.equal(normalizeSsoRelaySessionId(SID), SID);
  assert.equal(normalizeSsoRelaySessionId(SID.toUpperCase()), SID);
  assert.equal(normalizeSsoRelaySessionId('short'), '');
  assert.equal(normalizeSsoRelaySessionId('z'.repeat(64)), '');
  assert.equal(normalizeSsoRelaySessionId(undefined), '');
});

test('会话校验：/api/sso/me 回显同一 sessionId 且 user.id 非空才有效', async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return jsonResponse(200, {
      user: { id: 'u-1', name: 'Alice', email: 'a@example.com' },
      sessionId: SID,
    });
  }) as unknown as typeof fetch;
  const user = await verifySsoRelaySession(SID, { fetchImpl, env: ENV });
  assert.ok(user);
  assert.equal(user.id, 'u-1');
  assert.equal(user.email, 'a@example.com');
  assert.ok(calls[0].url.endsWith('/api/sso/me'));
  assert.equal(calls[0].headers.get(SSO_RELAY_SESSION_HEADER), SID);
});

test('会话校验拒绝：sessionId 不回显 / user 为空 / HTTP 非 200', async () => {
  for (const body of [
    { user: { id: 'u-1' }, sessionId: 'b'.repeat(64) },
    { user: null, sessionId: SID },
    { user: { id: '' }, sessionId: SID },
  ]) {
    const user = await verifySsoRelaySession(SID, {
      fetchImpl: (async () => jsonResponse(200, body)) as unknown as typeof fetch,
      env: ENV,
    });
    assert.equal(user, null, JSON.stringify(body));
  }
  const notOk = await verifySsoRelaySession(SID, {
    fetchImpl: (async () => jsonResponse(401, { user: null })) as unknown as typeof fetch,
    env: ENV,
  });
  assert.equal(notOk, null);
});

test('正/负结果缓存 60s；网络错误不缓存', async () => {
  let count = 0;
  const fetchImpl = (async () => {
    count += 1;
    return jsonResponse(200, { user: { id: 'u-1' }, sessionId: SID });
  }) as unknown as typeof fetch;
  await verifySsoRelaySession(SID, { fetchImpl, env: ENV });
  await verifySsoRelaySession(SID, { fetchImpl, env: ENV });
  assert.equal(count, 1);
  assert.ok(getSsoRelaySessionUser(SID));

  forgetSsoRelaySession(SID);
  const failing = (async () => jsonResponse(200, { user: null })) as unknown as typeof fetch;
  await verifySsoRelaySession(SID, { fetchImpl: failing, env: ENV });
  assert.equal(getSsoRelaySessionUser(SID), null);
  // 负结果也在缓存内：再查一次不打网络。
  let negativeCalls = 0;
  await verifySsoRelaySession(SID, {
    fetchImpl: (async () => {
      negativeCalls += 1;
      return jsonResponse(200, { user: { id: 'u-1' }, sessionId: SID });
    }) as unknown as typeof fetch,
    env: ENV,
  });
  assert.equal(negativeCalls, 0);
  // 缓存过期后重新放行：手动清缓存模拟 TTL 到期。
  forgetSsoRelaySession(SID);
  let fresh = 0;
  await verifySsoRelaySession(SID, {
    fetchImpl: (async () => {
      fresh += 1;
      return jsonResponse(200, { user: { id: 'u-1' }, sessionId: SID });
    }) as unknown as typeof fetch,
    env: ENV,
  });
  assert.equal(fresh, 1);

  // 网络错误：不缓存负结果，下一次调用仍会发起请求（先清掉 fresh 段的正缓存）。
  forgetSsoRelaySession(SID);
  const unreachable = (async () => {
    throw new Error('fetch failed');
  }) as unknown as typeof fetch;
  assert.equal(await verifySsoRelaySession(SID, { fetchImpl: unreachable, env: ENV }), null);
  // 失败未写入缓存：紧接着的成功校验真实打网一次。
  let retryCalls = 0;
  await verifySsoRelaySession(SID, {
    fetchImpl: (async () => {
      retryCalls += 1;
      return jsonResponse(200, { user: { id: 'u-1' }, sessionId: SID });
    }) as unknown as typeof fetch,
    env: ENV,
  });
  assert.equal(retryCalls, 1);
});

test('登录中继：成功转发凭据并写缓存；失败透传状态与错误码', async () => {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), method: String(init?.method), body: init?.body });
    return jsonResponse(200, {
      ok: true,
      user: { id: 'u-1', name: 'Alice' },
      sessionId: SID,
    });
  }) as unknown as typeof fetch;
  const { user, sessionId } = await loginViaSsoRelay(
    { userName: 'alice', password: 'secret' },
    { fetchImpl, env: ENV },
  );
  assert.equal(user.id, 'u-1');
  assert.equal(sessionId, SID);
  assert.equal(seen[0].url, 'http://127.0.0.1:18090/api/sso/direct/login');
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(JSON.parse(String(seen[0].body)), {
    method: 'account',
    userName: 'alice',
    password: 'secret',
  });
  // 登录即写缓存：紧跟的同步读取能拿到用户。
  assert.equal(getSsoRelaySessionUser(SID)?.id, 'u-1');

  await assert.rejects(
    () =>
      loginViaSsoRelay(
        { userName: 'alice', password: 'wrong' },
        {
          fetchImpl: (async () =>
            jsonResponse(401, { ok: false, error: 'bad credentials' })) as unknown as typeof fetch,
          env: ENV,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof SsoRelayError);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'bad credentials');
      return true;
    },
  );

  // 429 透传且无 error 字段时给出机器码。
  await assert.rejects(
    () =>
      loginViaSsoRelay(
        { userName: 'alice', password: 'x' },
        {
          fetchImpl: (async () => jsonResponse(429, {})) as unknown as typeof fetch,
          env: ENV,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof SsoRelayError);
      assert.equal(error.status, 429);
      assert.equal(error.code, 'login_rate_limited');
      return true;
    },
  );
});

test('未配置中继：登录 503 fail-closed；会话校验返回 null 不打网络', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => loginViaSsoRelay({ userName: 'a', password: 'b' }, { fetchImpl, env: {} }),
    (error: unknown) => {
      assert.ok(error instanceof SsoRelayError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'sso_relay_disabled');
      return true;
    },
  );
  assert.equal(await verifySsoRelaySession(SID, { fetchImpl, env: {} }), null);
  assert.equal(await logoutViaSsoRelay(SID, { fetchImpl, env: {} }), undefined);
  assert.equal(calls, 0);
});

test('登出：吊销请求带会话头，网络失败不影响本地缓存清理', async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  await verifySsoRelaySession(SID, {
    fetchImpl: (async () => jsonResponse(200, { user: { id: 'u-1' }, sessionId: SID })) as unknown as typeof fetch,
    env: ENV,
  });
  assert.ok(getSsoRelaySessionUser(SID));
  await logoutViaSsoRelay(SID, {
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      throw new Error('network down');
    }) as unknown as typeof fetch,
    env: ENV,
  });
  assert.ok(seen[0].url.endsWith('/api/sso/logout'));
  assert.equal(seen[0].headers.get(SSO_RELAY_SESSION_HEADER), SID);
  assert.equal(getSsoRelaySessionUser(SID), null);
});

test('登录限流：窗口内超限拒绝，窗口滑动后重置', () => {
  const max = ssoRelayLoginRateDefaultMaxForTest();
  const env = {} as Record<string, string | undefined>;
  for (let i = 0; i < max; i += 1) {
    assert.equal(ssoRelayLoginRateAllow('10.0.0.1', { env }), true, `attempt ${i + 1}`);
  }
  assert.equal(ssoRelayLoginRateAllow('10.0.0.1', { env }), false);
  // 不同地址互不影响。
  assert.equal(ssoRelayLoginRateAllow('10.0.0.2', { env }), true);
  // 自定义上限生效。
  const smallEnv = { RDK_SSO_RELAY_LOGIN_RATE_MAX: '2' } as Record<string, string | undefined>;
  assert.equal(ssoRelayLoginRateAllow('10.9.9.9', { env: smallEnv }), true);
  assert.equal(ssoRelayLoginRateAllow('10.9.9.9', { env: smallEnv }), true);
  assert.equal(ssoRelayLoginRateAllow('10.9.9.9', { env: smallEnv }), false);
  // 窗口滑动（now 由测试注入 16 分钟后）重置计数。
  assert.equal(
    ssoRelayLoginRateAllow('10.0.0.1', {
      env,
      now: () => Date.now() + 16 * 60_000,
    }),
    true,
  );
});

test('请求水合入口：normalize 拒绝的头不打网络（同步快路径）', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return jsonResponse(200, {});
  }) as unknown as typeof fetch;
  assert.equal(await verifySsoRelaySession('not-a-sid', { fetchImpl, env: ENV }), null);
  assert.equal(calls, 0);
});
