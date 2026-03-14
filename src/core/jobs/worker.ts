import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { StructuredErrorPayload } from '../errors.js';
import { progress } from '../output-handler.js';
import type { NdjsonEvent } from '../output-handler.js';

import { notifyJobCompletion } from './notifier.js';
import { appendJobEvent, readJob, updateJob, writeJobError, writeJobResult } from './store.js';
import type { JobRecord, JobStatus } from './types.js';

export type JobRunOutcome = 'completed' | 'failed' | 'timed_out' | 'retry';

export interface JobRunResult {
  outcome: JobRunOutcome;
  record?: JobRecord;
  error?: StructuredErrorPayload;
}

function resolveCliEntrypoint(): string {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('Cannot resolve cavendish CLI entrypoint from process.argv[1]');
  }
  return entry;
}

export function appendJobState(jobId: string, state: string): void {
  appendJobEvent(jobId, JSON.stringify({
    type: 'state',
    state,
    content: '',
    timestamp: new Date().toISOString(),
  }));
}

function parseEvent(line: string): NdjsonEvent | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.type !== 'string' || typeof parsed.timestamp !== 'string') {
      return undefined;
    }
    return parsed as unknown as NdjsonEvent;
  } catch {
    return undefined;
  }
}

function parseStructuredError(line: string): StructuredErrorPayload | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.error === true && typeof parsed.message === 'string' && typeof parsed.category === 'string') {
      return parsed as unknown as StructuredErrorPayload;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function buildWorkerArgs(job: JobRecord): string[] {
  return [...job.argv, '--stream', '--format', 'json', '--quiet'];
}

function finalizeJobStatus(event: NdjsonEvent): Extract<JobStatus, 'completed' | 'timed_out'> {
  return event.partial === true ? 'timed_out' : 'completed';
}

function isLockContentionError(error: StructuredErrorPayload): boolean {
  return error.category === 'cdp_unavailable'
    && error.message.toLowerCase().includes('another cavendish process');
}

function terminalStatusFromError(error: StructuredErrorPayload): Extract<JobStatus, 'failed' | 'timed_out'> {
  return error.category === 'timeout' ? 'timed_out' : 'failed';
}

async function runWorkerAttempt(jobId: string, job: JobRecord): Promise<{
  exitCode: number;
  finalEvent?: NdjsonEvent;
  structuredError?: StructuredErrorPayload;
}> {
  const child = spawn(process.execPath, [resolveCliEntrypoint(), ...buildWorkerArgs(job)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CAVENDISH_ALLOW_PARTIAL: '1',
    },
  });
  child.stdin.end(job.stdinData ?? '');

  let finalEvent: NdjsonEvent | undefined;
  let structuredError: StructuredErrorPayload | undefined;

  const stdoutRl = createInterface({ input: child.stdout });
  stdoutRl.on('line', (line) => {
    appendJobEvent(jobId, line);
    const event = parseEvent(line);
    if (event?.type === 'final') {
      finalEvent = event;
    }
  });

  const stderrRl = createInterface({ input: child.stderr });
  stderrRl.on('line', (line) => {
    const parsed = parseStructuredError(line);
    if (parsed !== undefined) {
      structuredError = parsed;
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve(code ?? 1);
    });
  });

  stdoutRl.close();
  stderrRl.close();

  return {
    exitCode,
    finalEvent,
    structuredError,
  };
}

export async function runJobWorker(jobId: string): Promise<JobRunResult> {
  const current = readJob(jobId);
  if (current === undefined) {
    throw new Error(`Job not found: ${jobId}`);
  }
  let record = updateJob(jobId, {
    status: 'running',
    startedAt: current.startedAt ?? new Date().toISOString(),
  });
  appendJobState(jobId, 'job-running');

  const { exitCode, finalEvent, structuredError } = await runWorkerAttempt(jobId, record);

  if (finalEvent !== undefined) {
    writeJobResult(jobId, {
      event: finalEvent,
      savedAt: new Date().toISOString(),
    });
    const status = finalizeJobStatus(finalEvent);
    record = updateJob(jobId, {
      status,
      completedAt: new Date().toISOString(),
      chatId: finalEvent.chatId,
      url: finalEvent.url,
      partial: finalEvent.partial,
      exitCode,
    });
    appendJobState(jobId, `job-${status}`);
    notifyJobCompletion(record);
    return { outcome: status, record };
  }

  const errorPayload: StructuredErrorPayload = structuredError ?? {
    error: true,
    category: 'unknown',
    message: `Detached runner exited without a final event (exit code: ${String(exitCode)})`,
    exitCode,
    action: 'Inspect the job error output and retry the command.',
  };

  if (isLockContentionError(errorPayload)) {
    record = updateJob(jobId, {
      status: 'queued',
      retryCount: current.retryCount + 1,
      lastRetriedAt: new Date().toISOString(),
      lastRetryError: errorPayload.message,
    });
    appendJobState(jobId, 'job-queued');
    return {
      outcome: 'retry',
      record,
      error: errorPayload,
    };
  }

  writeJobError(jobId, errorPayload);
  const status = terminalStatusFromError(errorPayload);
  record = updateJob(jobId, {
    status,
    completedAt: new Date().toISOString(),
    error: errorPayload,
    exitCode,
  });
  appendJobState(jobId, `job-${status}`);
  notifyJobCompletion(record);
  return {
    outcome: status,
    record,
    error: errorPayload,
  };
}

export function markUnexpectedJobFailure(jobId: string, error: unknown, label = 'Detached worker failed'): void {
  progress(`${label}: ${error instanceof Error ? error.message : String(error)}`, false);
  const fallback: StructuredErrorPayload = {
    error: true,
    category: 'unknown',
    message: error instanceof Error ? error.message : String(error),
    exitCode: 1,
    action: 'Inspect the job metadata and retry the command.',
  };
  writeJobError(jobId, fallback);
  const job = readJob(jobId);
  if (job !== undefined) {
    const record = updateJob(jobId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: fallback,
      exitCode: 1,
    });
    appendJobState(jobId, 'job-failed');
    notifyJobCompletion(record);
  }
}

export async function runJobWorkerOrExit(jobId: string): Promise<void> {
  try {
    const result = await runJobWorker(jobId);
    if (result.outcome === 'retry') {
      process.exitCode = 75;
    }
  } catch (error: unknown) {
    markUnexpectedJobFailure(jobId, error);
    process.exitCode = 1;
  }
}
