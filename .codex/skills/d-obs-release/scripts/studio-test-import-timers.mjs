/** Test-owned lifecycle for one known full-server import maintenance timer. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const nativeSetTimeout = globalThis.setTimeout, nativeSetInterval = globalThis.setInterval;
const nativeClearTimeout = globalThis.clearTimeout, nativeClearInterval = globalThis.clearInterval;
const timers = new Map();
function tracked(kind, original, callback, delay, args) {
  const stack = new Error('fixture timer creation').stack;
  let timer;
  const wrapped = kind === 'timeout' && typeof callback === 'function' ? function (...values) { timers.delete(timer); return Reflect.apply(callback, this, values); } : callback;
  timer = original(wrapped, delay, ...args); timers.set(timer, { kind, delay, stack }); return timer;
}
globalThis.setTimeout = (callback, delay, ...args) => tracked('timeout', nativeSetTimeout, callback, delay, args);
globalThis.setInterval = (callback, delay, ...args) => tracked('interval', nativeSetInterval, callback, delay, args);
globalThis.clearTimeout = timer => { timers.delete(timer); return nativeClearTimeout(timer); };
globalThis.clearInterval = timer => { timers.delete(timer); return nativeClearInterval(timer); };
function recognized(record) {
  if (record.kind !== 'interval' || record.delay !== 60000) return false;
  const line = record.stack?.split('\n').find(line => /^\s*at startSsoSessionExpirySweep \(/.test(line));
  const match = line?.match(/\((file:[^)]+\/server\/sso\.js):(\d+):(\d+)\)/);
  if (!match || !process.env.CAMERA_TEST_COMPILED_DIST || !process.env.CAMERA_TEST_SSO_SHA256) return false;
  const file = fileURLToPath(match[1]), expected = path.join(process.env.CAMERA_TEST_COMPILED_DIST, 'server/sso.js');
  if (fs.realpathSync(file) !== fs.realpathSync(expected)) return false;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === process.env.CAMERA_TEST_SSO_SHA256;
}
let finished = false;
async function finish() {
  if (finished) return; finished = true;
  const before = process.getActiveResourcesInfo?.() ?? [];
  const observed = [...timers].map(([timer, record]) => ({ kind: record.kind, delay: record.delay, referenced: timer.hasRef?.() === true, recognizedSsoExpiryMaintenance: recognized(record), creationStack: record.stack }));
  console.log('# camera-fixture-timers-before ' + JSON.stringify({ activeResources: before, timers: observed }));
  let cleared = 0;
  for (const [timer, record] of timers) if (recognized(record)) { nativeClearInterval(timer); timers.delete(timer); cleared++; }
  // Unknown timers are never cleared or unref'ed. The child must exit naturally.
  await new Promise(resolve => setImmediate(resolve));
  console.log('# camera-fixture-timers-after ' + JSON.stringify({ clearedExactSsoImportIntervals: cleared, activeResources: process.getActiveResourcesInfo?.() ?? [], unknownReferencedTimers: [...timers].filter(([timer, record]) => timer.hasRef?.() === true && !recognized(record)).length, forcedExit: false, broadlyClearedTimers: false }));
}
globalThis[Symbol.for('camera-workshop.test-timer-lifecycle')] = { finish };
