/**
 * 多 key 管理:一个用户可有多把 key(默认 + 自建,上限 MAX_USER_KEYS),都归属同一 sso_user_id
 * (网关按 owner 计量 → 共用一份每日额度)。默认 key 首次登录自动发、自动配进 Studio 托管模型条目。
 *
 * 每把 key 在网关里是一个独立 userId(= keyId),data.owner=sso_user_id。计数走中心库 per-owner
 * (见 /api/credits/consume + consumeDaily),不依赖网关自带 per-key 计数。
 *
 * 仅共享服务器侧使用(需 GATEWAY_ADMIN_KEY + RDK_CHAT_CREDITS_DB_URL)。
 */
import { randomBytes } from 'node:crypto';
import {
  isGatewayAdminConfigured,
  createUserKey,
  deleteUser,
  rotateUserKey,
  userExists,
} from './gateway-admin-client.js';
import { createOwnerSingleFlight } from './provisioning-concurrency.js';
import {
  defaultGatewayKeyProvisionIdentity,
  summarizeGatewayProvisionError,
} from './gateway-key-intent.js';
import {
  beginGatewayKeyProvisionIntent,
  clearGatewayKeyProvisionIntent,
  ensureAccount,
  insertUserKey,
  listUserKeys,
  countUserKeys,
  getDefaultUserKey,
  deleteUserKey,
  recordGatewayKeyProvisionFailure,
  recordGatewayKeyProvisioned,
  updateUserKeyGatewayKey,
  type UserKeyRecord,
} from './central-credit-store.js';

export const MAX_USER_KEYS = 5;

function genKeyId(): string {
  return `k_${randomBytes(9).toString('hex')}`;
}

/** 在网关创建一把新 key(标 owner=该用户)并落中心库。 */
export async function provisionNamedUserKey(
  ssoUserId: string,
  name: string,
  isDefault = false,
): Promise<UserKeyRecord> {
  const id = String(ssoUserId ?? '').trim();
  if (!id) throw new Error('provisionNamedUserKey: ssoUserId 不能为空');
  if (!isGatewayAdminConfigured()) throw new Error('GATEWAY_ADMIN_KEY 未配置');
  // 先确保账户行存在:一旦有 per-user key 就一定有对应 credit_account,运营后台可见、可设限、my-status 可查。
  // (否则 default-key 自动发放链路只建 key 不建账户,新用户在运营侧全程隐身,直到首次 consumeDaily 才补建。)
  await ensureAccount(id, null);
  const keyId = genKeyId();
  const label = (name || 'API Key').slice(0, 64);
  const r = await createUserKey(keyId, {
    label,
    owner: id,
    // Gateways that implement idempotency can safely replay this create after
    // a response timeout. Gateways that do not understand the header ignore it
    // and retain the existing behavior; no unsafe client-side retry is added.
    idempotencyKey: `rdk-studio:create:${keyId}`,
  });
  try {
    return await insertUserKey({ keyId, ssoUserId: id, name: label, gatewayKey: r.key, isDefault });
  } catch (e) {
    // 落库失败(DB 抖动,或并发首登撞默认 key 的部分唯一索引)→ 回滚网关里这把孤儿 key,best-effort,
    // 避免网关侧累积永不回收的孤儿 key(GET 取不回完整 key,落不了库就永久丢失)。
    try {
      await deleteUser(keyId);
    } catch {
      /* 网关回滚失败不影响:把原始落库错误抛给上层处理 */
    }
    throw e;
  }
}

/** 单次默认 key 流程；外层 single-flight 合并同进程重复登录/恢复回调。 */
async function ensureDefaultUserKeyOnce(ssoUserId: string): Promise<UserKeyRecord> {
  const existing = await getDefaultUserKey(ssoUserId);
  if (existing) return existing;
  const id = String(ssoUserId ?? '').trim();
  if (!id) throw new Error('ensureDefaultUserKey: ssoUserId 不能为空');
  try {
    return await provisionDefaultUserKeyDurably(id);
  } catch (e) {
    // 多进程并发首登:另一个请求可能已抢先写入默认 key → 回查返回胜出者。
    const winner = await getDefaultUserKey(id);
    if (winner) return winner;
    throw e;
  }
}

/**
 * Durable two-phase default-key provisioning.
 *
 * The intent is written before the gateway call and is only deleted after the
 * gateway credential is present in credit_user_key. If the DB write times out,
 * the next login reuses the same key/idempotency key instead of creating an
 * untracked gateway user. This intentionally does not delete the gateway user
 * on local persistence failure: recovery is safer than losing a one-time key.
 */
async function provisionDefaultUserKeyDurably(ssoUserId: string): Promise<UserKeyRecord> {
  if (!isGatewayAdminConfigured()) throw new Error('GATEWAY_ADMIN_KEY 未配置');
  await ensureAccount(ssoUserId, null);
  const identity = defaultGatewayKeyProvisionIdentity(ssoUserId);
  const intent = await beginGatewayKeyProvisionIntent({
    ...identity,
    ssoUserId,
    name: 'RDK Studio',
    isDefault: true,
  });
  const label = intent.name.slice(0, 64);
  let gatewayKey = intent.gatewayKey;
  try {
    if (!gatewayKey) {
      // A previous request may have reached the gateway but lost its response.
      // If so, rotate the existing user to obtain a fresh one-time key instead
      // of calling create again (create resets credentials on legacy gateways).
      if (await userExists(intent.keyId)) {
        const rotated = await rotateUserKey(intent.keyId);
        gatewayKey = rotated.newKey;
      } else {
        const created = await createUserKey(intent.keyId, {
          label,
          owner: ssoUserId,
          idempotencyKey: intent.idempotencyKey,
        });
        gatewayKey = created.key;
      }
      // Persist the one-time response before touching the unique local default row.
      await recordGatewayKeyProvisioned(intent.intentId, gatewayKey);
    }
    try {
      const record = await insertUserKey({
        keyId: intent.keyId,
        ssoUserId,
        name: label,
        gatewayKey,
        isDefault: true,
      });
      await clearGatewayKeyProvisionIntent(intent.intentId);
      return record;
    } catch (error) {
      // If another process won the partial unique index, its default is the
      // canonical record. Clean up only our known key and finish the intent.
      const winner = await getDefaultUserKey(ssoUserId).catch(() => null);
      if (winner) {
        await deleteUser(intent.keyId).catch(() => {});
        await clearGatewayKeyProvisionIntent(intent.intentId).catch(() => {});
        return winner;
      }
      throw error;
    }
  } catch (error) {
    // Keep the intent row even when recording the gateway response itself
    // failed; a subsequent login can safely retry with the same idempotency key.
    await recordGatewayKeyProvisionFailure(intent.intentId, summarizeGatewayProvisionError(error)).catch(
      () => {},
    );
    throw error;
  }
}

/** 确保用户有一把默认 key(首次登录发);返回默认 key 记录。幂等 + 并发安全。 */
export const ensureDefaultUserKey = createOwnerSingleFlight(ensureDefaultUserKeyOnce);

export type CreateKeyResult = { ok: true; key: UserKeyRecord } | { ok: false; reason: 'limit' };

/** 用户自建一把 key(校验上限 MAX_USER_KEYS)。 */
export async function createNamedUserKey(
  ssoUserId: string,
  name: string,
): Promise<CreateKeyResult> {
  if ((await countUserKeys(ssoUserId)) >= MAX_USER_KEYS) return { ok: false, reason: 'limit' };
  return { ok: true, key: await provisionNamedUserKey(ssoUserId, name, false) };
}

/** 轮换该用户所有 credit_user_key(默认 + 自建):网关 rotate 每把 → 旧 key 立即失效 → 落新 gateway_key。
 *  best-effort:网关已无某把 key(rotate 抛错)则跳过,不阻断其余轮换(与 removeUserKey 容忍一致)。
 *  keyId/owner 不变,per-owner 计数与额度不受影响。 */
export async function rotateAllUserKeys(ssoUserId: string): Promise<void> {
  const keys = await listUserKeys(ssoUserId);
  for (const rec of keys) {
    try {
      const r = await rotateUserKey(rec.keyId); // 每把 key 在网关里是独立 userId = keyId
      await updateUserKeyGatewayKey(rec.keyId, r.newKey);
    } catch {
      /* 网关已无该 key 或暂时不可达:跳过,泄露自救以其余 key 成功轮换为准 */
    }
  }
}

/** 删一把(非默认)key:网关先删(立即失效)+ 中心库删。 */
export async function removeUserKey(ssoUserId: string, keyId: string): Promise<boolean> {
  const keys = await listUserKeys(ssoUserId);
  const rec = keys.find((k) => k.keyId === keyId && !k.isDefault);
  if (!rec) return false;
  try {
    await deleteUser(rec.keyId); // 网关删 → key 立即失效;容忍网关已无该 key。
  } catch {
    /* 网关删失败(如已不存在)不阻断中心库删除;计数按 owner,孤儿 key 仍归该用户、不影响额度正确性。 */
  }
  await deleteUserKey(ssoUserId, keyId);
  // 删除 key 后立即失效 owner-scoped credential 缓存。
  void import('./managed-agent-credential.js')
    .then((m) => m.invalidateRequestManagedAgentCredentialCache(ssoUserId))
    .catch(() => {});
  return true;
}
