import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CAVENDISH_DIR } from '../browser-manager.js';
import { progress } from '../output-handler.js';

import { readNextQueuedJob } from './store.js';
import { markUnexpectedJobFailure, runJobWorker } from './worker.js';

const RUNNER_LOCK_FILE = join(CAVENDISH_DIR, 'jobs-runner.lock');
const RUNNER_LOCK_MAX_ATTEMPTS = 3;
const RUNNER_LOCK_RETRY_MS = 200;
const JOB_RETRY_DELAY_MS = 2_000;
let runnerPromise: Promise<void> | null = null;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}

function readLockPidFromPath(path: string): number | null {
  try {
    const content = readFileSync(path, 'utf8').trim();
    if (!/^[1-9]\d*$/.test(content)) {
      throw new Error(
        `Runner lock file is corrupt: ${JSON.stringify(content)}. Remove "${path}" and retry.`,
      );
    }
    return Number.parseInt(content, 10);
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `Failed to read runner lock file "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readLockPid(): number | null {
  return readLockPidFromPath(RUNNER_LOCK_FILE);
}

function tryCreateLockFile(): boolean {
  try {
    writeFileSync(RUNNER_LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function cleanupStaleLockFile(staleFile: string): void {
  try {
    unlinkSync(staleFile);
  } catch (cleanupError: unknown) {
    if (!isErrnoException(cleanupError) || cleanupError.code !== 'ENOENT') {
      process.stderr.write(
        `[cavendish:jobs] failed to clean up stale runner lock "${staleFile}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
      );
    }
  }
}

function restoreRunnerLockIfMissing(staleFile: string): void {
  if (readLockPid() !== null) {
    return;
  }
  renameSync(staleFile, RUNNER_LOCK_FILE);
}

function tryClaimStaleLock(stalePid: number | null): boolean {
  if (stalePid === null) {
    return false;
  }
  const staleFile = `${RUNNER_LOCK_FILE}.stale.${String(process.pid)}`;
  try {
    if (readLockPid() !== stalePid) {
      return false;
    }
    renameSync(RUNNER_LOCK_FILE, staleFile);
    const movedPid = readLockPidFromPath(staleFile);
    if (movedPid !== stalePid) {
      restoreRunnerLockIfMissing(staleFile);
      return false;
    }
    const claimed = tryCreateLockFile();
    cleanupStaleLockFile(staleFile);
    return claimed;
  } catch (error: unknown) {
    cleanupStaleLockFile(staleFile);
    if (isErrnoException(error) && error.code !== 'ENOENT') {
      throw error;
    }
    return false;
  }
}

function tryAcquireRunnerLock(): boolean {
  mkdirSync(CAVENDISH_DIR, { recursive: true });

  if (tryCreateLockFile()) {
    return true;
  }

  const existingPid = readLockPid();
  if (existingPid === process.pid) {
    return true;
  }
  if (existingPid !== null && isProcessAlive(existingPid)) {
    return false;
  }
  if (tryClaimStaleLock(existingPid)) {
    return true;
  }
  return false;
}

function releaseRunnerLock(): void {
  try {
    const lockPid = readLockPid();
    if (lockPid !== null && lockPid !== process.pid) {
      return;
    }
  } catch (error: unknown) {
    process.stderr.write(
      `[cavendish:jobs] failed to inspect runner lock before release: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  try {
    unlinkSync(RUNNER_LOCK_FILE);
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code !== 'ENOENT') {
      process.stderr.write(
        `[cavendish:jobs] failed to release runner lock: ${error.message}\n`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function acquireRunnerLock(): Promise<boolean> {
  for (let attempt = 1; attempt <= RUNNER_LOCK_MAX_ATTEMPTS; attempt += 1) {
    if (tryAcquireRunnerLock()) {
      if (attempt > 1) {
        progress(`Detached runner lock acquired on attempt ${String(attempt)}`, false);
      }
      return true;
    }
    progress(
      `Detached runner lock busy (attempt ${String(attempt)}/${String(RUNNER_LOCK_MAX_ATTEMPTS)})`,
      false,
    );
    if (attempt < RUNNER_LOCK_MAX_ATTEMPTS) {
      await sleep(RUNNER_LOCK_RETRY_MS);
    }
  }
  progress(
    `Detached runner lock unavailable after ${String(RUNNER_LOCK_MAX_ATTEMPTS)} attempts`,
    false,
  );
  return false;
}

async function runJobRunnerOnce(): Promise<void> {
  const acquired = await acquireRunnerLock();
  if (!acquired) {
    throw new Error(
      `Detached runner could not acquire queue lock after ${String(RUNNER_LOCK_MAX_ATTEMPTS)} attempts. Inspect "${RUNNER_LOCK_FILE}" and retry.`,
    );
  }

  try {
    for (;;) {
      const nextJob = readNextQueuedJob();
      if (nextJob === undefined) {
        return;
      }
      try {
        const result = await runJobWorker(nextJob.jobId);
        if (result.outcome === 'retry') {
          const retryCount = result.record?.retryCount ?? 0;
          progress(
            `Retrying detached job ${nextJob.jobId} after lock contention (${String(retryCount)})`,
            false,
          );
          await sleep(JOB_RETRY_DELAY_MS);
          continue;
        }
      } catch (error: unknown) {
        markUnexpectedJobFailure(nextJob.jobId, error, 'Detached runner job failed');
        continue;
      }
    }
  } finally {
    releaseRunnerLock();
  }
}

export async function runJobRunner(): Promise<void> {
  if (runnerPromise !== null) {
    return runnerPromise;
  }
  runnerPromise = (async (): Promise<void> => {
    try {
      await runJobRunnerOnce();
    } finally {
      runnerPromise = null;
    }
  })();
  return runnerPromise;
}

export async function runJobRunnerOrExit(): Promise<void> {
  try {
    await runJobRunner();
  } catch (error: unknown) {
    progress(`Detached runner failed: ${error instanceof Error ? error.message : String(error)}`, false);
    process.exitCode = 1;
  }
}
