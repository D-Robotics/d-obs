/**
 * Durable desktop outbox for conversation/run telemetry.
 *
 * The desktop server can be offline or exit between a run finishing and the
 * HTTPS report completing. Persisting before network I/O closes that gap. The
 * central source_id makes a crash after upload but before local removal safe:
 * the next flush may replay the item, but cannot create a second row.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDataDir } from './storage.js';
const OUTBOX_SCHEMA_VERSION = 1;
const MAX_OUTBOX_ITEMS = 200;
const MAX_FLUSH_ITEMS = 20;
const MAX_OUTBOX_BYTES = 16 * 1024 * 1024;
let mutationTail = Promise.resolve();
let flushPromise = null;
function outboxPath() {
    return path.join(resolveDataDir(), 'central-telemetry-outbox.json');
}
function itemId(kind, ssoUserId, payload) {
    return createHash('sha256')
        .update(`${kind}\0${ssoUserId}\0${JSON.stringify(payload)}`)
        .digest('hex');
}
function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const value = raw;
    const kind = value.kind === 'conversation' || value.kind === 'run' ? value.kind : null;
    const ssoUserId = String(value.ssoUserId ?? '').trim().slice(0, 256);
    const payload = value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
        ? value.payload
        : null;
    if (!kind || !ssoUserId || !payload)
        return null;
    return {
        id: itemId(kind, ssoUserId, payload),
        kind,
        ssoUserId,
        payload,
        createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
        attempts: Math.max(0, Math.trunc(Number(value.attempts) || 0)),
        lastAttemptAt: Number.isFinite(Number(value.lastAttemptAt))
            ? Number(value.lastAttemptAt)
            : null,
    };
}
async function readOutbox() {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(outboxPath(), 'utf8'));
        if (parsed.schemaVersion !== OUTBOX_SCHEMA_VERSION || !Array.isArray(parsed.items)) {
            return { schemaVersion: OUTBOX_SCHEMA_VERSION, items: [] };
        }
        return {
            schemaVersion: OUTBOX_SCHEMA_VERSION,
            items: parsed.items
                .map(normalizeItem)
                .filter((item) => Boolean(item))
                .slice(-MAX_OUTBOX_ITEMS),
        };
    }
    catch {
        return { schemaVersion: OUTBOX_SCHEMA_VERSION, items: [] };
    }
}
async function writeOutbox(value) {
    const filePath = outboxPath();
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const content = `${JSON.stringify(value, null, 2)}\n`;
    await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32')
        await fs.promises.chmod(tmpPath, 0o600).catch(() => undefined);
    await fs.promises.rename(tmpPath, filePath);
}
async function withMutationLock(work) {
    const previous = mutationTail;
    let release;
    mutationTail = new Promise((resolve) => {
        release = resolve;
    });
    await previous.catch(() => undefined);
    try {
        return await work();
    }
    finally {
        release();
    }
}
function trimToDiskBudget(items) {
    let kept = items.slice(-MAX_OUTBOX_ITEMS);
    while (kept.length > 1 && Buffer.byteLength(JSON.stringify({ schemaVersion: 1, items: kept })) > MAX_OUTBOX_BYTES) {
        kept = kept.slice(1);
    }
    return kept;
}
export async function enqueueCentralTelemetry(input) {
    const ssoUserId = String(input.ssoUserId ?? '').trim().slice(0, 256);
    if (!ssoUserId || !input.payload || typeof input.payload !== 'object') {
        return { queued: false, pending: 0 };
    }
    const item = normalizeItem({
        kind: input.kind,
        ssoUserId,
        payload: input.payload,
        createdAt: input.createdAt ?? Date.now(),
        attempts: 0,
        lastAttemptAt: null,
    });
    if (!item)
        return { queued: false, pending: 0 };
    return withMutationLock(async () => {
        const outbox = await readOutbox();
        if (!outbox.items.some((existing) => existing.id === item.id)) {
            outbox.items = trimToDiskBudget([...outbox.items, item]);
            await writeOutbox(outbox);
        }
        return { queued: true, pending: outbox.items.length };
    });
}
export async function flushCentralTelemetryOutbox(upload) {
    if (flushPromise)
        return flushPromise;
    flushPromise = withMutationLock(async () => {
        const outbox = await readOutbox();
        if (outbox.items.length === 0)
            return { uploaded: 0, pending: 0 };
        let uploaded = 0;
        const retained = [];
        for (const [index, item] of outbox.items.entries()) {
            if (index >= MAX_FLUSH_ITEMS) {
                retained.push(item);
                continue;
            }
            let ok = false;
            try {
                ok = await upload(item);
            }
            catch {
                ok = false;
            }
            if (ok) {
                uploaded += 1;
            }
            else {
                retained.push({ ...item, attempts: item.attempts + 1, lastAttemptAt: Date.now() });
            }
        }
        await writeOutbox({ schemaVersion: OUTBOX_SCHEMA_VERSION, items: retained });
        return { uploaded, pending: retained.length };
    }).finally(() => {
        flushPromise = null;
    });
    return flushPromise;
}
export function centralTelemetryOutboxPathForTest() {
    return outboxPath();
}
