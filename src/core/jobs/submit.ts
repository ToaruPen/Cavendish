import { spawn, type ChildProcess } from 'node:child_process';

import { CavendishError } from '../errors.js';

import { createJob, updateJob, writeJobError } from './store.js';
import type { DetachedJobRequest, JobRecord } from './types.js';

const STARTUP_OBSERVE_MS = 500;

function resolveCliEntrypoint(): string {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new CavendishError(
      'Cannot resolve cavendish CLI entrypoint from process.argv[1]',
      'unknown',
      'Run the command via the Cavendish CLI entrypoint and retry.',
    );
  }
  return entry;
}

function waitForRunnerSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function observeEarlyRunnerExit(
  child: ChildProcess,
  markLaunchFailed: (error: unknown) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, STARTUP_OBSERVE_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if ((code ?? 0) !== 0 || signal !== null) {
        markLaunchFailed(
          new Error(`Detached runner exited during startup (code: ${String(code)}, signal: ${String(signal)})`),
        );
      }
      resolve();
    });
  });
}

export async function submitDetachedJob(request: DetachedJobRequest): Promise<JobRecord> {
  const record = createJob(request);
  const markLaunchFailed = (error: unknown): void => {
    const payload = {
      error: true as const,
      category: 'unknown' as const,
      message: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      action: 'Fix the detached runner launch failure and retry the command.',
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
      [resolveCliEntrypoint(), 'jobs', 'run-runner'],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    const earlyExitPromise = observeEarlyRunnerExit(child, markLaunchFailed);
    await waitForRunnerSpawn(child);
    await earlyExitPromise;
    child.unref();
  } catch (error: unknown) {
    markLaunchFailed(error);
    throw error;
  }
  return record;
}
