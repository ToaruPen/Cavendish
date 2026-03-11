/**
 * Process-level lock to prevent multiple cavendish processes from
 * running simultaneously and interfering with the shared CDP context.
 *
 * Uses an exclusive-create lock file (`~/.cavendish/cavendish.lock`)
 * with the owning PID written inside.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CAVENDISH_DIR } from './browser-manager.js';
import { CavendishError } from './errors.js';

const LOCK_FILE = join(CAVENDISH_DIR, 'cavendish.lock');

/** Type guard for Node.js system errors that carry an `errno` code. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Check whether a process with the given PID is still running.
 *
 * `process.kill(pid, 0)` sends no signal but checks for existence:
 * - Returns normally → process is alive and owned by current user
 * - Throws EPERM → process is alive but owned by another user
 * - Throws ESRCH → process does not exist
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return isErrnoException(err) && err.code === 'EPERM';
  }
}

/**
 * Read the PID from an existing lock file.
 * Returns null if the file cannot be read or parsed.
 */
function readLockPid(): number | null {
  try {
    const content = readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

/**
 * Attempt to create the lock file atomically.
 * Returns true on success, false if the file already exists.
 *
 * @throws {Error} on unexpected filesystem errors (not EEXIST).
 */
function tryCreateLockFile(): boolean {
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

/**
 * Atomically claim a stale lock by writing our PID to a temporary file
 * and renaming it over the lock file.
 *
 * `rename()` is atomic on POSIX — it replaces the lock file in a single
 * syscall, eliminating the TOCTOU gap between a separate `unlink()` and
 * `writeFileSync(..., 'wx')`.  If another process races us, exactly one
 * rename will take effect last.  We then verify we won by re-reading
 * the lock file.
 *
 * Returns true if this process successfully claimed the lock.
 */
function tryClaimStaleLock(): boolean {
  const tmpFile = `${LOCK_FILE}.${String(process.pid)}`;
  try {
    writeFileSync(tmpFile, String(process.pid), { mode: 0o600 });
    renameSync(tmpFile, LOCK_FILE);
    // Verify that our PID is actually in the lock file.
    // Another process may have renamed over it after us.
    const winner = readLockPid();
    return winner === process.pid;
  } catch (err: unknown) {
    // Clean up the temp file on any error
    try {
      unlinkSync(tmpFile);
    } catch {
      // Temp file may not exist — safe to ignore
    }
    // Propagate filesystem errors (EACCES, EROFS, ENOSPC) so the caller
    // can report the real cause instead of misclassifying as a race loss.
    if (isErrnoException(err) && err.code !== 'ENOENT') {
      throw err;
    }
    return false;
  }
}

/**
 * Acquire the process lock.
 *
 * - Attempts exclusive creation of the lock file.
 * - If the file exists, checks whether the owning process is alive.
 * - Stale locks (dead process) are removed and retried once.
 * - If the owning process is alive, throws with an actionable error.
 *
 * @throws {CavendishError} when another cavendish process is running.
 */
export function acquireLock(): void {
  // Ensure ~/.cavendish/ exists before attempting to create the lock file.
  // This is needed because acquireLock() runs before BrowserManager.launch()
  // which normally creates the directory via ensureProfileDirectories().
  mkdirSync(CAVENDISH_DIR, { recursive: true });

  if (tryCreateLockFile()) {
    return;
  }

  // Lock file exists — check if the owning process is still alive
  const existingPid = readLockPid();

  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new CavendishError(
      `Another cavendish process (PID: ${String(existingPid)}) is running. Wait for it to finish or kill it manually.`,
      'cdp_unavailable',
      `Wait for PID ${String(existingPid)} to finish, or run "kill ${String(existingPid)}" to terminate it.`,
    );
  }

  // Stale lock from a dead process — atomically claim it via rename.
  if (tryClaimStaleLock()) {
    return;
  }

  // Another process won the rename race
  const racePid = readLockPid();
  const pidInfo = racePid !== null ? ` (PID: ${String(racePid)})` : '';
  throw new CavendishError(
    `Another cavendish process${pidInfo} acquired the lock. Wait for it to finish or kill it manually.`,
    'cdp_unavailable',
    'Wait for the other cavendish process to finish and retry.',
  );
}

/**
 * Release the process lock.
 *
 * Only removes the lock file if it was created by this process
 * (guards against accidentally releasing another process's lock).
 * Silently succeeds if the lock file does not exist.
 */
export function releaseLock(): void {
  const pid = readLockPid();
  if (pid !== process.pid) {
    return;
  }
  try {
    unlinkSync(LOCK_FILE);
  } catch (err: unknown) {
    // ENOENT is expected (file already removed) — anything else
    // (EACCES, EPERM, EROFS) indicates a real problem that could
    // leave a stale lock and block future invocations.
    if (isErrnoException(err) && err.code !== 'ENOENT') {
      process.stderr.write(
        `[cavendish] Warning: failed to release lock file: ${err.message}\n`,
      );
    }
  }
}

/**
 * The lock file path, exported for test verification.
 */
export const LOCK_FILE_PATH = LOCK_FILE;
