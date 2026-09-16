/**
 * 反向代理信任配置（`app.set('trust proxy', …)` 的取值解析）。
 *
 * 生产是 nginx 前缀代理到 `127.0.0.1:18093`，因此**不配 trust proxy 时**
 * `req.socket.remoteAddress` 恒为回环地址：所有基于客户端地址的判定（登录
 * 限流）会退化成全平台共享一个桶——一个攻击者用 20 次错误密码就能把所有人
 * 挡在门外。
 *
 * 默认值 `'loopback'` 的语义是「只有当直连对端是回环地址时才相信
 * X-Forwarded-For」。这样同机反代能拿到真实客户端 IP，而一旦进程被意外暴露
 * 到公网，外部攻击者伪造的 XFF 不会被采信（对端不是回环），限流仍然生效。
 *
 * `RDK_TRUST_PROXY`：
 *   - 未设置 / `loopback`：只信任回环对端（默认，匹配同机 nginx）；
 *   - `0` / `false` / `off` / `none` / `no`：完全不信任代理头；
 *   - 其它取值：原样交给 express / proxy-addr 解析（IP、CIDR 列表、
 *     `uniquelocal` 等），供反向代理不在本机时使用。
 */
export function resolveTrustProxySetting(env: Record<string, string | undefined> = process.env): string | false {
  const raw = String(env.RDK_TRUST_PROXY ?? '').trim();
  if (!raw) return 'loopback';
  if (['0', 'false', 'off', 'none', 'no'].includes(raw.toLowerCase())) return false;
  return raw;
}

/**
 * 请求的客户端地址（用于限流分桶）。
 *
 * `req.ip` 在配置了 trust proxy 后会解析 XFF 得到真实客户端地址；未配置时
 * 与 `req.socket.remoteAddress` 等价。两者都取不到时返回 `'unknown'`，让所有
 * 这类请求落进同一个桶（fail-closed 方向：宁可共享额度也不放行无限尝试）。
 */
export function clientAddress(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}
