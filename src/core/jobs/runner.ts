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

function readLockPid(): number | null {
  try {
    const content = readFileSync(RUNNER_LOCK_FILE, 'utf8').trim();
    const pid = Number.parseInt(content, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `Failed to read runner lock file "${RUNNER_LOCK_FILE}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

function tryClaimStaleLock(stalePid: number | null): boolean {
  if (stalePid === null) {
    return false;
  }
  const tmpFile = `${RUNNER_LOCK_FILE}.${String(process.pid)}`;
  try {
    if (readLockPid() !== stalePid) {
      return false;
    }
    writeFileSync(tmpFile, String(process.pid), { mode: 0o600 });
    renameSync(tmpFile, RUNNER_LOCK_FILE);
    return readLockPid() === process.pid;
  } catch (error: unknown) {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Temp file may already have been renamed or removed.
    }
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
  if (readLockPid() !== process.pid) {
    return;
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
  return false;
}

export async function runJobRunner(): Promise<void> {
  const acquired = await acquireRunnerLock();
  if (!acquired) {
    return;
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
          progress(
            `Retrying detached job ${nextJob.jobId} after lock contention (${String(result.record?.retryCount ?? 0)})`,
            false,
          );
          await sleep(JOB_RETRY_DELAY_MS);
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

export async function runJobRunnerOrExit(): Promise<void> {
  try {
    await runJobRunner();
  } catch (error: unknown) {
    progress(`Detached runner failed: ${error instanceof Error ? error.message : String(error)}`, false);
    process.exitCode = 1;
  }
}
