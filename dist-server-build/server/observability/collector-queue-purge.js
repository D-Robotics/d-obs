import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { deriveStudioCollectorScopeRef } from './collector-relay-forwarder.js';
const execFileAsync = promisify(execFile);
const DEFAULT_HELPER = '/usr/local/libexec/rdstudio-otel-queue-purge';
const SCOPE_HASH_KEY_FILE_ENV = 'STUDIO_OTEL_SCOPE_HASH_KEY_FILE';
function unavailable(message) {
    return Object.assign(new Error(message), { code: 'unavailable' });
}
function boundedCount(value) {
    const count = Number(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
function parseReport(value, expectedScopeRef) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        throw unavailable('Collector queue purge returned invalid evidence');
    }
    if (parsed.schema !== 'rdk-studio.otel-queue-purge.v1' ||
        parsed.scopeRef !== expectedScopeRef ||
        boundedCount(parsed.queuesInspected) === null ||
        boundedCount(parsed.requestsDeleted) === null ||
        boundedCount(parsed.requestsRewritten) === null ||
        boundedCount(parsed.spansDeleted) === null) {
        throw unavailable('Collector queue purge evidence did not match the requested scope');
    }
    return parsed;
}
/**
 * Runs the root-owned stop/rewrite/start transaction with only an opaque HMAC
 * scope reference. Raw account identifiers never cross the process boundary.
 */
export function createCollectorQueuePurgeBoundary(dependencies = {}) {
    const environment = dependencies.environment ?? process.env;
    const keyFile = String(environment[SCOPE_HASH_KEY_FILE_ENV] ?? '').trim();
    const helperPath = dependencies.helperPath ?? DEFAULT_HELPER;
    const readKeyFile = dependencies.readKeyFile ?? ((path) => readFile(path, 'utf8'));
    const runHelper = dependencies.runHelper ??
        (async (helper, scopeRef) => {
            const result = await execFileAsync(helper, [scopeRef], {
                encoding: 'utf8',
                timeout: 55_000,
                maxBuffer: 64 * 1024,
                windowsHide: true,
            });
            return result.stdout;
        });
    return {
        purge: async (tombstone) => {
            if (!keyFile || !helperPath.startsWith('/')) {
                throw unavailable('Collector scoped queue deletion is not configured');
            }
            try {
                const key = (await readKeyFile(keyFile)).trim();
                const scopeRef = deriveStudioCollectorScopeRef({
                    accountScopeId: tombstone.accountScopeId,
                    environment: tombstone.environment,
                    key,
                });
                const output = await runHelper(helperPath, scopeRef);
                parseReport(output, scopeRef);
            }
            catch (error) {
                if (error && typeof error === 'object' && 'code' in error && error.code === 'unavailable') {
                    throw error;
                }
                throw unavailable('Collector scoped queue deletion failed');
            }
        },
    };
}
