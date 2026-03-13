import { spawn } from 'node:child_process';

import { createJob, updateJob, writeJobError } from './store.js';
import type { DetachedJobRequest, JobRecord } from './types.js';

function resolveCliEntrypoint(): string {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('Cannot resolve cavendish CLI entrypoint from process.argv[1]');
  }
  return entry;
}

export function submitDetachedJob(request: DetachedJobRequest): JobRecord {
  const record = createJob(request);
  try {
    const child = spawn(
      process.execPath,
      [resolveCliEntrypoint(), 'jobs', 'run-worker', record.jobId],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          CAVENDISH_JOB_WORKER: '1',
        },
      },
    );
    child.unref();
  } catch (error: unknown) {
    const payload = {
      error: true as const,
      category: 'unknown' as const,
      message: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      action: 'Fix the detached worker launch failure and retry the command.',
    };
    writeJobError(record.jobId, payload);
    updateJob(record.jobId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: payload,
      exitCode: 1,
    });
    throw error;
  }
  return record;
}
