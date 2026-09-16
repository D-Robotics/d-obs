/**
 * 反代信任配置回归：默认只在直连对端是回环时采信 XFF、可显式关闭、
 * 客户端地址解析在缺失时 fail-closed 落进同一个桶。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clientAddress, resolveTrustProxySetting } from './trusted-proxy.js';

test('trust proxy 取值：默认 loopback，可显式关闭，其它原样透传', () => {
  // 默认（未配置）：只信任回环对端 —— 匹配同机 nginx 反代。
  assert.equal(resolveTrustProxySetting({}), 'loopback');
  assert.equal(resolveTrustProxySetting({ RDK_TRUST_PROXY: '   ' }), 'loopback');
  // 显式关闭：完全不采信代理头。
  for (const value of ['0', 'false', 'OFF', 'none', 'No']) {
    assert.equal(resolveTrustProxySetting({ RDK_TRUST_PROXY: value }), false, value);
  }
  // 其它取值交给 express/proxy-addr 解析（CIDR 列表 / uniquelocal 等）。
  assert.equal(resolveTrustProxySetting({ RDK_TRUST_PROXY: '10.0.0.0/8' }), '10.0.0.0/8');
  assert.equal(
    resolveTrustProxySetting({ RDK_TRUST_PROXY: 'loopback, 172.16.0.0/12' }),
    'loopback, 172.16.0.0/12',
  );
});

test('客户端地址：优先 req.ip（trust proxy 解析结果），缺失时收敛到 unknown', () => {
  assert.equal(clientAddress({ ip: '203.0.113.7', socket: { remoteAddress: '127.0.0.1' } }), '203.0.113.7');
  assert.equal(clientAddress({ socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(clientAddress({}), 'unknown');
  assert.equal(clientAddress({ ip: '' }), 'unknown');
  // 超长地址截断（防御性上限，避免异常头撑大内存键）。
  assert.equal(clientAddress({ ip: 'x'.repeat(200) }).length, 64);
});
