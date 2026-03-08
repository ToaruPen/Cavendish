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

/**
 * Register process-level signal handlers for graceful shutdown.
 * Must be called exactly once (Node does NOT deduplicate listeners).
 *
 * The handlers log a shutdown message to stderr and exit with the
 * POSIX-conventional exit code. `BrowserManager.close()` runs via
 * the try/finally in `withDriver()` when the process receives a signal
 * during a command, so no explicit cleanup is needed here.
 */
export function registerSignalHandlers(): void {
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
}

function handleSigint(): void {
  process.stderr.write('\n[cavendish] Shutting down (SIGINT)...\n');
  process.exit(SIGINT_EXIT_CODE);
}

function handleSigterm(): void {
  process.stderr.write('[cavendish] Shutting down (SIGTERM)...\n');
  process.exit(SIGTERM_EXIT_CODE);
}
