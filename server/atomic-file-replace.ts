const RETRYABLE_REPLACE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'UNKNOWN']);
const ASYNC_RETRY_DELAYS_MS = [0, 15, 50, 150, 300] as const;
const SYNC_RETRY_DELAYS_MS = [0, 10, 35, 100, 200] as const;

function isRetryableReplaceError(error: unknown): boolean {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code ?? '');
  return RETRYABLE_REPLACE_CODES.has(code);
}

function waitSync(delayMs: number): void {
  if (delayMs <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, delayMs);
}

/**
 * Atomically publishes a fully-written temporary file. Windows virus scanners
 * and indexers can briefly hold either path open, so retry only the transient
 * access/busy errors. Never unlink the destination: the old valid snapshot is
 * safer than a missing snapshot if replacement ultimately fails.
 */
export async function replaceFileWithRetry(
  temporaryPath: string,
  destinationPath: string,
  rename: (oldPath: string, newPath: string) => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (const delayMs of ASYNC_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      await rename(temporaryPath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableReplaceError(error)) throw error;
    }
  }
  throw lastError;
}

/** Synchronous companion for small credential snapshots used by sync readers. */
export function replaceFileSyncWithRetry(
  temporaryPath: string,
  destinationPath: string,
  renameSync: (oldPath: string, newPath: string) => void,
): void {
  let lastError: unknown;
  for (const delayMs of SYNC_RETRY_DELAYS_MS) {
    waitSync(delayMs);
    try {
      renameSync(temporaryPath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableReplaceError(error)) throw error;
    }
  }
  throw lastError;
}
