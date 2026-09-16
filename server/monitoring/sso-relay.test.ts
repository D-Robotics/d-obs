/**
 * SSO 中继回归测试：登录转发契约、会话校验（sessionId 必须回显一致）、
 * 60s 正负缓存、网络错误不缓存、未配置中继 fail-closed、登录限流。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Request } from 'express';

import {
  SSO_RELAY_CLOUD_SESSION_HEADER,
  SSO_RELAY_SESSION_COOKIE,
  SSO_RELAY_SESSION_HEADER,
  SsoRelayError,
  forgetSsoRelaySession,
  getSsoRelaySessionUser,
  hydrateSsoRelaySession,
  loginViaSsoRelay,
  logoutViaSsoRelay,
  normalizeSsoRelaySessionId,
  recoverSsoRelayCloudSession,
  resetSsoRelayLoginRateForTest,
  resetSsoRelaySessionCacheForTest,
  resolveSsoRelaySessionUser,
  ssoRelayConfigured,
  ssoRelayForwardedClientIp,
  ssoRelayLoginAccountRateDefaultMaxForTest,
  ssoRelayLoginRateAllow,
  ssoRelayLoginRateDefaultMaxForTest,
  ssoRelayRequestUser,
  ssoRelayRequestSessionId,
  ssoRelaySessionCandidates,
  ssoRelayUpstreamCookieHeader,
  verifySsoRelaySession,
} from './sso-relay.js';

const SID = 'a'.repeat(64);
const SID_COOKIE = 'c'.repeat(64);
const SID_HEADER_EXTRA = 'd'.repeat(64);
const SID_RECOVERED = 'e'.repeat(64);
const ENV = { RDK_SSO_RELAY_BASE_URL: 'http://127.0.0.1:18090' } as Record<
  string,
  string | undefined
>;

function fakeRequest(headers: Record<string, string>): Request {
  return {
    headers,
    header(name: string): string | undefined {
      return headers[name] ?? headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

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

// ---- 免登通道：同源 HttpOnly Cookie ----

test('会话候选链：Cookie 是合法候选，头优先于 Cookie', () => {
  assert.deepEqual(
    ssoRelaySessionCandidates(fakeRequest({ [SSO_RELAY_SESSION_HEADER]: SID })),
    [SID],
  );
  // 只有 Cookie（用户在业务站登录过、d-obs 从未登录）——免登场景。
  assert.deepEqual(
    ssoRelaySessionCandidates(fakeRequest({ cookie: `other=1; ${SSO_RELAY_SESSION_COOKIE}=${SID_COOKIE}; x=2` })),
    [SID_COOKIE],
  );
  assert.deepEqual(
    ssoRelaySessionCandidates(
      fakeRequest({ [SSO_RELAY_SESSION_HEADER]: SID, cookie: `${SSO_RELAY_SESSION_COOKIE}=${SID_COOKIE}` }),
    ),
    [SID, SID_COOKIE],
  );
  // Cookie 值经 URL 编码（主站可能编码）时能解码。
  assert.deepEqual(
    ssoRelaySessionCandidates(fakeRequest({ cookie: `${SSO_RELAY_SESSION_COOKIE}=${SID_COOKIE}%20` })),
    [SID_COOKIE],
  );
  assert.deepEqual(ssoRelaySessionCandidates(fakeRequest({ cookie: `${SSO_RELAY_SESSION_COOKIE}=short` })), []);
  assert.deepEqual(ssoRelaySessionCandidates(fakeRequest({})), []);
});

test('重复大小写会话头（逗号合并值）不被采信，退回 Cookie 通道', () => {
  // 前端曾把镜像会话与本次登录会话写成两个大小写不同的头，fetch 会合并成一个
  // 逗号值；猜任意一个都可能把别人的会话当成自己的登录态，因此整条头作废。
  const merged = `${SID}, ${SID_HEADER_EXTRA}`;
  assert.deepEqual(ssoRelaySessionCandidates(fakeRequest({ [SSO_RELAY_SESSION_HEADER]: merged })), []);
  assert.deepEqual(
    ssoRelaySessionCandidates(
      fakeRequest({ [SSO_RELAY_SESSION_HEADER]: merged, cookie: `${SSO_RELAY_SESSION_COOKIE}=${SID_COOKIE}` }),
    ),
    [SID_COOKIE],
  );
});

test('只转发 SSO 白名单 Cookie，不把同源其它 Cookie 带给主站', () => {
  const cookie = `rdk_sso_web_session=enc; rdk_sso_session=${SID_COOKIE}; other_secret=leak`;
  assert.equal(
    ssoRelayUpstreamCookieHeader(fakeRequest({ cookie })),
    `rdk_sso_session=${SID_COOKIE}; rdk_sso_web_session=enc`,
  );
  assert.equal(ssoRelayUpstreamCookieHeader(fakeRequest({ cookie: 'other=1' })), '');
  assert.equal(ssoRelayUpstreamCookieHeader(fakeRequest({})), '');
});

test('免登：仅凭 Cookie 即可解析身份，并把 Cookie 转发给主站校验', async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    const sid = new Headers(init?.headers).get(SSO_RELAY_SESSION_HEADER) ?? '';
    if (sid === SID_COOKIE) return jsonResponse(200, { user: { id: 'u-cookie' }, sessionId: SID_COOKIE });
    return jsonResponse(200, { user: null });
  }) as unknown as typeof fetch;
  const req = fakeRequest({ cookie: `${SSO_RELAY_SESSION_COOKIE}=${SID_COOKIE}` });
  const resolved = await resolveSsoRelaySessionUser(req, { fetchImpl, env: ENV });
  assert.equal(resolved?.user.id, 'u-cookie');
  assert.equal(resolved?.sessionId, SID_COOKIE);
  assert.equal(seen[0].url, 'http://127.0.0.1:18090/api/sso/me');
  assert.equal(seen[0].headers.get(SSO_RELAY_SESSION_HEADER), SID_COOKIE);
  assert.equal(seen[0].headers.get('cookie'), `${SSO_RELAY_SESSION_COOKIE}=${SID_COOKIE}`);
});

test('水合把头/ Cookie 解析出的身份挂到 req，供同步守卫读取', async () => {
  const savedEnv = process.env.RDK_SSO_RELAY_BASE_URL;
  const savedFetch = globalThis.fetch;
  process.env.RDK_SSO_RELAY_BASE_URL = 'http://127.0.0.1:18090';
  (globalThis as { fetch: unknown }).fetch = (async () =>
    jsonResponse(200, { user: { id: 'u-hydrated' }, sessionId: SID })) as unknown as typeof fetch;
  try {
    const req = fakeRequest({ [SSO_RELAY_SESSION_HEADER]: SID });
    assert.equal(ssoRelayRequestUser(req), null);
    await hydrateSsoRelaySession(req);
    assert.equal(ssoRelayRequestUser(req)?.id, 'u-hydrated');
    assert.equal(ssoRelayRequestSessionId(req), SID);

    // 无任何候选：不打网络，且明确标记「已水合 = 未登录」。
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = (async () => {
      calls += 1;
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
    const anon = fakeRequest({});
    await hydrateSsoRelaySession(anon);
    assert.equal(ssoRelayRequestUser(anon), null);
    assert.equal(calls, 0);
  } finally {
    if (savedEnv === undefined) delete process.env.RDK_SSO_RELAY_BASE_URL;
    else process.env.RDK_SSO_RELAY_BASE_URL = savedEnv;
    (globalThis as { fetch: unknown }).fetch = savedFetch;
  }
});

test('云镜像懒恢复：主站回显新 sessionId 时接受并写缓存', async () => {
  const cloud = 'f'.repeat(64);
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    // 本地会话头是云会话 id（本次入参），主站按云凭据恢复出本地会话。
    assert.equal(headers.get(SSO_RELAY_CLOUD_SESSION_HEADER), cloud);
    return jsonResponse(200, { user: { id: 'u-cloud' }, sessionId: SID_RECOVERED });
  }) as unknown as typeof fetch;
  const recovered = await recoverSsoRelayCloudSession(cloud, { fetchImpl, env: ENV });
  assert.equal(recovered?.sessionId, SID_RECOVERED);
  assert.equal(recovered?.user.id, 'u-cloud');
  // 恢复结果进缓存：后续按本地会话同步可读。
  assert.equal(getSsoRelaySessionUser(SID_RECOVERED)?.id, 'u-cloud');

  const req = fakeRequest({ [SSO_RELAY_CLOUD_SESSION_HEADER]: cloud });
  const viaRequest = await resolveSsoRelaySessionUser(req, { fetchImpl, env: ENV });
  assert.equal(viaRequest?.user.id, 'u-cloud');

  // 主站没回显合法会话 id → 拒绝（不能凭空认一个身份）。
  const noEcho = (async () =>
    jsonResponse(200, { user: { id: 'u-cloud' } })) as unknown as typeof fetch;
  assert.equal(await recoverSsoRelayCloudSession(cloud, { fetchImpl: noEcho, env: ENV }), null);
  // 非 64-hex 的云凭据不发起请求。
  let cloudCalls = 0;
  assert.equal(
    await recoverSsoRelayCloudSession('not-a-session', {
      fetchImpl: (async () => {
        cloudCalls += 1;
        return jsonResponse(200, {});
      }) as unknown as typeof fetch,
      env: ENV,
    }),
    null,
  );
  assert.equal(cloudCalls, 0);
});

test('登录成功透传白名单 Set-Cookie（含 web-cloud 加密 Cookie），过滤其它 Cookie', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: true, user: { id: 'u-1' }, sessionId: SID }), {
      status: 200,
      headers: [
        ['content-type', 'application/json'],
        ['set-cookie', `${SSO_RELAY_SESSION_COOKIE}=${SID}; Path=/; HttpOnly; SameSite=Lax`],
        ['set-cookie', 'rdk_sso_web_session=enc; Path=/; HttpOnly; SameSite=Lax'],
        ['set-cookie', 'unrelated=1; Path=/'],
      ],
    })) as unknown as typeof fetch;
  const result = await loginViaSsoRelay(
    { userName: 'alice', password: 'secret' },
    { fetchImpl, env: ENV },
  );
  assert.equal(result.sessionId, SID);
  assert.deepEqual(result.setCookies, [
    `${SSO_RELAY_SESSION_COOKIE}=${SID}; Path=/; HttpOnly; SameSite=Lax`,
    'rdk_sso_web_session=enc; Path=/; HttpOnly; SameSite=Lax',
  ]);
});

test('登出：一并带上 Cookie 通道，让主站围栏所有候选会话', async () => {
  const seen: Array<Headers> = [];
  await logoutViaSsoRelay(SID, {
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch,
    env: ENV,
    cookieHeader: `${SSO_RELAY_SESSION_COOKIE}=${SID_COOKIE}`,
  });
  assert.equal(seen[0].get(SSO_RELAY_SESSION_HEADER), SID);
  assert.equal(seen[0].get('cookie'), `${SSO_RELAY_SESSION_COOKIE}=${SID_COOKIE}`);
});

test('登录限流账号维度：换 IP 也挡得住同一账号，不同账号互不影响', () => {
  const env = {} as Record<string, string | undefined>;
  const accountMax = ssoRelayLoginAccountRateDefaultMaxForTest();
  // 每个请求都换一个地址：地址桶永远不超限，账号桶负责兜住。
  for (let i = 0; i < accountMax; i += 1) {
    assert.equal(
      ssoRelayLoginRateAllow(`10.0.0.${i + 1}`, { env, userName: 'victim' }),
      true,
      `attempt ${i + 1}`,
    );
  }
  assert.equal(ssoRelayLoginRateAllow('10.9.9.9', { env, userName: 'victim' }), false);
  // 其它账号不受影响（不会因为他人的失败尝试被连坐）。
  assert.equal(ssoRelayLoginRateAllow('10.9.9.9', { env, userName: 'someone-else' }), true);
  // 账号大小写/空格归一化后仍算同一个账号。
  assert.equal(ssoRelayLoginRateAllow('10.9.9.9', { env, userName: ' Victim ' }), false);
  // 账号维度上限可配（账号桶跨地址共享，所以换地址也照样拦）。
  const custom = { RDK_SSO_RELAY_LOGIN_ACCOUNT_RATE_MAX: '1' } as Record<string, string | undefined>;
  assert.equal(ssoRelayLoginRateAllow('10.1.1.1', { env: custom, userName: 'a' }), true);
  assert.equal(ssoRelayLoginRateAllow('10.1.1.2', { env: custom, userName: 'a' }), false);
  // 其它账号仍可登录：针对性爆破不应连坐无关用户。
  assert.equal(ssoRelayLoginRateAllow('10.1.1.3', { env: custom, userName: 'b' }), true);
});

test('登录限流地址维度：同一地址的失败尝试仍然受限', () => {
  const env = { RDK_SSO_RELAY_LOGIN_RATE_MAX: '3' } as Record<string, string | undefined>;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(ssoRelayLoginRateAllow('10.2.2.2', { env, userName: `u${i}` }), true);
  }
  assert.equal(ssoRelayLoginRateAllow('10.2.2.2', { env, userName: 'u9' }), false);
  // 另一个地址不受影响（这就是「按真实客户端 IP 计数」的意义）。
  assert.equal(ssoRelayLoginRateAllow('10.2.2.3', { env, userName: 'u9' }), true);
});

test('登录限流：窗口滑动后账号维度重置', () => {
  const env = { RDK_SSO_RELAY_LOGIN_ACCOUNT_RATE_MAX: '1' } as Record<string, string | undefined>;
  assert.equal(ssoRelayLoginRateAllow('10.3.3.1', { env, userName: 'bob' }), true);
  assert.equal(ssoRelayLoginRateAllow('10.3.3.2', { env, userName: 'bob' }), false);
  assert.equal(
    ssoRelayLoginRateAllow('10.3.3.3', {
      env,
      userName: 'bob',
      now: () => Date.now() + 16 * 60_000,
    }),
    true,
  );
});

test('中继转发真实客户端地址：仅转发合法 IP 字面量，避免污染代理头', () => {
  assert.equal(ssoRelayForwardedClientIp('203.0.113.7'), '203.0.113.7');
  assert.equal(ssoRelayForwardedClientIp('::ffff:127.0.0.1'), '::ffff:127.0.0.1');
  assert.equal(ssoRelayForwardedClientIp('2001:db8::1'), '2001:db8::1');
  assert.equal(ssoRelayForwardedClientIp('  203.0.113.7  '), '203.0.113.7');
  // 非 IP 一律不转发：'unknown'（无地址时的兜底）、注入尝试、空值。
  for (const bad of ['unknown', '', '   ', 'not-an-ip', '127.0.0.1, 10.0.0.1', '127.0.0.1\r\nX-Evil: 1', undefined, null]) {
    assert.equal(ssoRelayForwardedClientIp(bad), '', String(bad));
  }
});

test('登录与 /sso/me 中继都把客户端地址带给主站（供其按来源限流）', async () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    if (String(url).endsWith('/api/sso/direct/login')) {
      return jsonResponse(200, { ok: true, user: { id: 'u-1' }, sessionId: SID });
    }
    return jsonResponse(200, { user: { id: 'u-1' }, sessionId: SID });
  }) as unknown as typeof fetch;

  await loginViaSsoRelay(
    { userName: 'alice', password: 'secret' },
    { fetchImpl, env: ENV, clientIp: '203.0.113.9' },
  );
  await verifySsoRelaySession(SID, { fetchImpl, env: ENV });
  const login = seen.find((entry) => entry.url.endsWith('/api/sso/direct/login'));
  assert.equal(login?.headers.get('x-forwarded-for'), '203.0.113.9');
  assert.equal(login?.headers.get('x-real-ip'), '203.0.113.9');

  // 未提供或非法地址时不带头（行为与改动前一致，主站按回环地址计数）。
  const withoutIp: Array<Headers> = [];
  await loginViaSsoRelay(
    { userName: 'alice', password: 'secret' },
    {
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        withoutIp.push(new Headers(init?.headers));
        return jsonResponse(200, { ok: true, user: { id: 'u-1' }, sessionId: SID });
      }) as unknown as typeof fetch,
      env: ENV,
      clientIp: 'unknown',
    },
  );
  assert.equal(withoutIp[0].get('x-forwarded-for'), null);
});
