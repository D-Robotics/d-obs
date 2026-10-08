import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveStudioCollectorScopeRef } from './collector-relay-forwarder.js';
import { resolveStudioTraceStoreEnvironment } from './studio-trace-store.js';
import { createScopeRefResolver } from './scope-ref-resolver.js';

const KEY = 'unit-test-scope-hash-key-0123456789abcdef';
const KEY_FILE = '/test/scope-hash-key';

function makeDeps(overrides: {
  accounts?: () => string[];
  accountsError?: Error;
  keyFileContent?: string;
  env?: Record<string, string | undefined>;
} = {}) {
  const calls = { accounts: 0, keyReads: 0 };
  let clock = 1_000_000;
  const env: Record<string, string | undefined> = {
    RDK_OBS_SCOPE_REF_HASH_KEY_FILE: KEY_FILE,
    ...overrides.env,
  };
  const resolver = createScopeRefResolver({
    env: env as unknown as NodeJS.ProcessEnv,
    readTextFile: async () => {
      calls.keyReads += 1;
      return overrides.keyFileContent ?? KEY;
    },
    listAccountScopeIds: async () => {
      calls.accounts += 1;
      if (overrides.accountsError) throw overrides.accountsError;
      return overrides.accounts ? overrides.accounts() : [];
    },
    now: () => clock,
  });
  return {
    calls,
    advanceClock: (milliseconds: number) => {
      clock += milliseconds;
    },
    resolver,
  };
}

function deriveFor(account: string): string {
  return deriveStudioCollectorScopeRef({
    accountScopeId: account,
    environment: resolveStudioTraceStoreEnvironment(),
    key: KEY,
  });
}

test('resolves a derived scope ref back to the account scope id', async () => {
  const { resolver } = makeDeps({ accounts: () => ['account-alpha', 'account-beta'] });
  assert.equal(await resolver.resolve(deriveFor('account-alpha')), 'account-alpha');
  assert.equal(await resolver.resolve(deriveFor('account-beta')), 'account-beta');
});

test('returns null for malformed or unknown references', async () => {
  const { resolver } = makeDeps({ accounts: () => ['account-alpha'] });
  assert.equal(await resolver.resolve('scope-v1:zzzz'), null);
  assert.equal(await resolver.resolve('scope-v1:00000000000000000000000000000000'), null);
  assert.equal(await resolver.resolve('scope-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), null);
  assert.equal(await resolver.resolve(deriveFor('nobody')), null);
});

test('resolution stays disabled without the hash key file env', async () => {
  const { resolver, calls } = makeDeps({
    accounts: () => ['account-alpha'],
    env: { RDK_OBS_SCOPE_REF_HASH_KEY_FILE: undefined },
  });
  assert.equal(await resolver.resolve(deriveFor('account-alpha')), null);
  assert.equal(calls.accounts, 0);
  assert.equal(calls.keyReads, 0);
});

test('resolution follows account list refreshes after the TTL window', async () => {
  const accounts: string[] = ['account-alpha'];
  const deps = makeDeps({ accounts: () => accounts });
  assert.equal(await deps.resolver.resolve(deriveFor('account-alpha')), 'account-alpha');
  assert.equal(await deps.resolver.resolve(deriveFor('account-late')), null);
  assert.equal(deps.calls.accounts, 1);

  accounts.push('account-late');
  deps.advanceClock(11 * 60_000);
  assert.equal(await deps.resolver.resolve(deriveFor('account-alpha')), 'account-alpha');
  assert.equal(await deps.resolver.resolve(deriveFor('account-late')), 'account-late');
  assert.equal(deps.calls.accounts, 2);
});

test('account listing failures degrade to null attribution without throwing', async () => {
  const { resolver } = makeDeps({
    accountsError: new Error('registry unavailable'),
  });
  const ref = deriveFor('account-alpha');
  assert.equal(await resolver.resolve(ref), null);
  assert.equal(await resolver.resolve(ref), null);
});

test('a short hash key degrades instead of deriving with a weak key', async () => {
  const { resolver } = makeDeps({ keyFileContent: 'short', accounts: () => ['account-alpha'] });
  assert.equal(await resolver.resolve(deriveFor('account-alpha')), null);
});
