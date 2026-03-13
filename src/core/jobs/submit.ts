import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

import { CavendishError } from '../errors.js';

import { createJob, updateJob, writeJobError } from './store.js';
import type { DetachedJobRequest, JobRecord } from './types.js';

function resolveCliEntrypoint(): string {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new CavendishError(
      'Cannot resolve cavendish CLI entrypoint from process.argv[1]',
      'unknown',
      'Run the command via the Cavendish CLI entrypoint and retry.',
    );
  }
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new CavendishError(
      `Cavendish CLI entrypoint not found: ${entry}`,
      'unknown',
      'Reinstall Cavendish or run the command through the packaged CLI binary.',
    );
  }
  return entry;
}

export function submitDetachedJob(request: DetachedJobRequest): JobRecord {
  const record = createJob(request);
  const markLaunchFailed = (error: unknown): void => {
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
  };
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
    child.once('error', (error: unknown): void => {
      markLaunchFailed(error);
    });
    child.unref();
  } catch (error: unknown) {
    markLaunchFailed(error);
    throw error;
  }
  return record;
}
