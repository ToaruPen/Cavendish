import { existsSync, statSync } from 'node:fs';

import type { JobRecord } from './types.js';

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function isWorkerPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (!isErrnoException(error)) {
      return true;
    }
    return error.code !== 'ESRCH';
  }
}

export function latestJobProgressMs(job: JobRecord): number | undefined {
  const timestamps = [Date.parse(job.updatedAt)].filter((value) => Number.isFinite(value));
  if (typeof job.eventsPath === 'string' && existsSync(job.eventsPath)) {
    timestamps.push(statSync(job.eventsPath).mtimeMs);
  }
  if (timestamps.length === 0) {
    return undefined;
  }
  return Math.max(...timestamps);
}
