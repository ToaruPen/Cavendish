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

/** Guard against duplicate registration (Node does NOT deduplicate listeners). */
let registered = false;

/**
 * Register process-level signal handlers for graceful shutdown.
 * Idempotent — safe to call more than once; subsequent calls are no-ops.
 *
 * The handlers log a shutdown message to stderr and exit with the
 * POSIX-conventional exit code. `process.exit()` bypasses any pending
 * async finally blocks (e.g. `withDriver()`'s `browser.close()`), but
 * this is acceptable: `close()` only tears down the Playwright CDP
 * websocket — Chrome persists as a detached process by design, and
 * the OS reclaims the socket on process exit.
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
  process.exit(SIGINT_EXIT_CODE);
}

function handleSigterm(): void {
  writeSync(2, '[cavendish] Shutting down (SIGTERM)...\n');
  releaseLock();
  process.exit(SIGTERM_EXIT_CODE);
}
