/**
 * Process-level lock to prevent multiple cavendish processes from
 * running simultaneously and interfering with the shared CDP context.
 *
 * Uses an exclusive-create lock file (`~/.cavendish/cavendish.lock`)
 * with the owning PID written inside.  Stale-lock takeover is
 * serialised through a sibling "replacement gate" file so concurrent
 * claimers cannot accidentally destroy a freshly acquired lock.
 * The gate itself is recoverable: if its holder dies mid-takeover,
 * the next claimer detects the dead holder and reclaims the gate.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CAVENDISH_DIR } from './browser-manager.js';
import { CavendishError } from './errors.js';
import { isErrnoException } from './jobs/pid-utils.js';

const LOCK_FILE = join(CAVENDISH_DIR, 'cavendish.lock');
const LOCK_REPLACEMENT_GATE = `${LOCK_FILE}.gate`;
const GATE_RECLAIM_ATTEMPTS = 2;

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

/** Read a PID from the file at `path`.  Null when missing/unparseable. */
function readPidFile(path: string): number | null {
  try {
    const content = readFileSync(path, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

/** Read the PID of the canonical lock file's owner. */
function readLockPid(): number | null {
  return readPidFile(LOCK_FILE);
}

/** Unlink `path`, ignoring ENOENT.  Other errors propagate. */
function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err: unknown) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Attempt to create the lock file atomically with the given pid.
 * Returns true on success, false if the file already exists.
 *
 * @throws {Error} on unexpected filesystem errors (not EEXIST).
 */
function tryCreateLockFile(currentPid: number): boolean {
  try {
    writeFileSync(LOCK_FILE, String(currentPid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

/**
 * Try to acquire the replacement gate exclusively.
 *
 * The gate is a `wx`-created file containing the holder's pid.  Two
 * concurrent claimers cannot both create it; the loser inspects the
 * recorded pid and either bails out (if the holder is alive) or
 * reclaims the gate (if the holder is dead).
 *
 * Returns true when this caller now owns the gate; false otherwise.
 */
function tryAcquireReplacementGate(currentPid: number): boolean {
  for (let attempt = 0; attempt < GATE_RECLAIM_ATTEMPTS; attempt++) {
    try {
      writeFileSync(LOCK_REPLACEMENT_GATE, String(currentPid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err: unknown) {
      if (!isErrnoException(err) || err.code !== 'EEXIST') {
        throw err;
      }
    }

    const holderPid = readPidFile(LOCK_REPLACEMENT_GATE);
    if (holderPid !== null && isProcessAlive(holderPid)) {
      return false;
    }
    // Holder is dead or the gate file is corrupt — reclaim and retry.
    unlinkIfPresent(LOCK_REPLACEMENT_GATE);
  }
  return false;
}

/**
 * Release the replacement gate.
 *
 * Only called from the `finally` of {@link tryClaimStaleLock} after
 * `tryAcquireReplacementGate` returned true, so within this synchronous
 * frame we are guaranteed to be the gate's holder.
 */
function releaseReplacementGate(): void {
  try {
    unlinkIfPresent(LOCK_REPLACEMENT_GATE);
  } catch (err: unknown) {
    process.stderr.write(
      `[cavendish] Warning: failed to release replacement gate "${LOCK_REPLACEMENT_GATE}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Atomically take over a stale lock.
 *
 * Stale-lock takeover requires three logical steps that are not
 * individually atomic on POSIX (verify content → remove → recreate).
 * Two concurrent claimers that both observe the same stale pid can
 * race so that the slower one ends up destroying the faster one's
 * freshly created lock.
 *
 * To prevent that, we serialise the takeover through an exclusive
 * replacement gate.  Inside the gate we re-verify the stale pid,
 * unlink the stale lock, and `wx`-create the new one — none of
 * which can race against another stale-takeover, because the gate
 * holder has exclusive access until it releases the gate.
 *
 * Concurrent fresh acquirers (`tryCreateLockFile` only, no takeover)
 * still race normally against the `wx`-create inside the gate; the
 * `wx` flag's atomic EEXIST guarantees at most one writer wins.
 *
 * Returns true only when this caller actually installed a lock holding
 * its own pid.
 */
function tryClaimStaleLock(stalePid: number | null, currentPid: number): boolean {
  if (!tryAcquireReplacementGate(currentPid)) {
    return false;
  }
  try {
    if (readLockPid() !== stalePid) {
      return false;
    }
    unlinkIfPresent(LOCK_FILE);
    return tryCreateLockFile(currentPid);
  } finally {
    releaseReplacementGate();
  }
}

/**
 * Acquire the process lock.
 *
 * - Attempts exclusive creation of the lock file.
 * - If the file exists, checks whether the owning process is alive.
 * - Stale locks (dead process or unparseable content) are taken over
 *   atomically through a replacement gate.
 * - If the owning process is alive, throws with an actionable error.
 *
 * @throws {CavendishError} when another cavendish process is running.
 */
export function acquireLock(): void {
  // Ensure ~/.cavendish/ exists before attempting to create the lock file.
  // This is needed because acquireLock() runs before BrowserManager.launch()
  // which normally creates the directory via ensureProfileDirectories().
  mkdirSync(CAVENDISH_DIR, { recursive: true });

  if (tryCreateLockFile(process.pid)) {
    return;
  }

  // Lock file exists — check if the owning process is still alive.
  const existingPid = readLockPid();

  // Re-entrancy guard: if this process already holds the lock, return early.
  // This prevents false "another process is running" errors when the same
  // process calls acquireLock() more than once (e.g. nested call paths).
  if (existingPid === process.pid) {
    return;
  }

  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new CavendishError(
      `Another cavendish process (PID: ${String(existingPid)}) is running. Wait for it to finish or kill it manually.`,
      'cdp_unavailable',
      `Wait for PID ${String(existingPid)} to finish, or run "kill ${String(existingPid)}" to terminate it.`,
    );
  }

  if (tryClaimStaleLock(existingPid, process.pid)) {
    return;
  }

  // Either another process took over the stale lock first, or holds the
  // replacement gate.  Surface whichever owner the next reader sees.
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
  if (readLockPid() !== process.pid) {
    return;
  }
  try {
    unlinkSync(LOCK_FILE);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code !== 'ENOENT') {
      process.stderr.write(
        `[cavendish] Warning: failed to release lock file: ${err.message}\n`,
      );
    }
  }
}

/** The lock file path, exported for test verification. */
export const LOCK_FILE_PATH = LOCK_FILE;

/** The replacement gate path, exported for test verification. */
export const LOCK_REPLACEMENT_GATE_PATH = LOCK_REPLACEMENT_GATE;

/**
 * Test-only export of the internal `tryClaimStaleLock` helper.
 *
 * Production code MUST NOT call this directly — `acquireLock` is the
 * only supported entry point.  This export takes an explicit
 * `currentPid` so {@link tests/process-lock-race.test.ts} can simulate
 * two concurrent claimers in a single process without forking.
 */
export const _tryClaimStaleLockForTests = tryClaimStaleLock;
