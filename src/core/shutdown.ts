import { writeSync } from 'node:fs';

import { releaseLock } from './process-lock.js';

/**
 * Graceful shutdown handling for SIGINT and SIGTERM.
 *
 * Chrome is NOT killed — it persists as a detached process by design.
 * The signal handler ensures the CLI process exits cleanly with the
 * correct exit code (130 for SIGINT, 143 for SIGTERM).
 */

/** SIGINT exit code per POSIX convention (128 + 2). */
const SIGINT_EXIT_CODE = 130;

/** SIGTERM exit code per POSIX convention (128 + 15). */
const SIGTERM_EXIT_CODE = 143;

/** Maximum time to wait for cleanup callbacks before forcing exit. */
export const CLEANUP_TIMEOUT_MS = 3_000;

/** Guard against duplicate registration (Node does NOT deduplicate listeners). */
let registered = false;

/** Set of active cleanup callbacks to run before process.exit(). */
const cleanupCallbacks = new Set<() => void | Promise<void>>();

/** Shared cleanup promise so re-entrant calls await the same in-flight cleanup. */
let cleanupPromise: Promise<void> | null = null;

/**
 * Register a cleanup callback that will run before process.exit() on
 * SIGINT/SIGTERM. Returns an unregister function to remove the callback.
 *
 * Cleanup callbacks are intended for restoring transient external state
 * (e.g. clipboard contents) that would otherwise be lost when the
 * process exits abruptly. They run with a hard timeout to prevent
 * hanging the shutdown sequence.
 *
 * @example
 * ```ts
 * const unregister = registerCleanup(() => restoreClipboard());
 * try {
 *   // ... do work that modifies clipboard ...
 * } finally {
 *   unregister(); // normal path handles its own cleanup
 * }
 * ```
 */
export function registerCleanup(fn: () => void | Promise<void>): () => void {
  cleanupCallbacks.add(fn);
  return (): void => {
    cleanupCallbacks.delete(fn);
  };
}

/**
 * Run all registered cleanup callbacks with a hard timeout.
 * Uses Promise.allSettled so one failing callback does not block others.
 * Re-entrant safe — if both SIGINT and SIGTERM fire before process.exit(),
 * the second call awaits the same in-flight cleanup promise instead of
 * skipping it.
 */
async function runCleanupCallbacks(): Promise<void> {
  if (cleanupCallbacks.size === 0) {
    return;
  }
  if (cleanupPromise) {
    return cleanupPromise;
  }
  cleanupPromise = (async (): Promise<void> => {
    const promises = [...cleanupCallbacks].map((fn) => {
      try {
        return Promise.resolve(fn());
      } catch (e: unknown) {
        // Synchronous throw — log and treat as settled (rejected).
        const msg = e instanceof Error ? e.message : String(e);
        writeSync(2, `[cavendish] cleanup callback threw synchronously: ${msg}\n`);
        const error = e instanceof Error ? e : new Error(String(e));
        return Promise.reject(error);
      }
    });
    const results = await Promise.race([
      Promise.allSettled(promises),
      new Promise<PromiseSettledResult<void>[]>((resolve) => {
        setTimeout(resolve, CLEANUP_TIMEOUT_MS, []);
      }),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        writeSync(2, `[cavendish] cleanup callback failed: ${String(result.reason)}\n`);
      }
    }
  })();
  return cleanupPromise;
}

/**
 * Register process-level signal handlers for graceful shutdown.
 * Idempotent — safe to call more than once; subsequent calls are no-ops.
 *
 * The handlers log a shutdown message to stderr, run any registered
 * cleanup callbacks (with a timeout), and exit with the POSIX-conventional
 * exit code. `process.exit()` bypasses any pending async finally blocks
 * (e.g. `withDriver()`'s `browser.close()`), but this is acceptable:
 * `close()` only tears down the Playwright CDP websocket — Chrome
 * persists as a detached process by design, and the OS reclaims the
 * socket on process exit.
 */
export function registerSignalHandlers(): void {
  if (registered) {
    return;
  }
  registered = true;
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
}

function handleSigint(): void {
  // Use writeSync so the message is guaranteed to flush even when stderr
  // is piped (process.stderr.write is async on POSIX pipes).
  writeSync(2, '\n[cavendish] Shutting down (SIGINT)...\n');
  releaseLock();
  void runCleanupCallbacks().finally(() => {
    process.exit(SIGINT_EXIT_CODE);
  });
}

function handleSigterm(): void {
  writeSync(2, '[cavendish] Shutting down (SIGTERM)...\n');
  releaseLock();
  void runCleanupCallbacks().finally(() => {
    process.exit(SIGTERM_EXIT_CODE);
  });
}
