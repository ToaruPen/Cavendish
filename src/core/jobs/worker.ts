import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { StructuredErrorPayload } from '../errors.js';
import { progress } from '../output-handler.js';
import type { NdjsonEvent } from '../output-handler.js';

import { notifyJobCompletion } from './notifier.js';
import { appendJobEvent, readJob, readJobPrompt, recoverBestContentFromEvents, updateJob, writeJobError, writeJobResult } from './store.js';
import type { JobRecord, JobStatus } from './types.js';

type JobRunOutcome = 'completed' | 'failed' | 'timed_out' | 'retry';

interface JobRunResult {
  outcome: JobRunOutcome;
  record?: JobRecord;
  error?: StructuredErrorPayload;
}

function normalizeFailureExitCode(exitCode: number | undefined): number {
  return typeof exitCode === 'number' && exitCode !== 0 ? exitCode : 1;
}

function normalizeStructuredExitCode(
  exitCode: number,
  structuredError: StructuredErrorPayload | undefined,
): number {
  if (structuredError === undefined) {
    return normalizeFailureExitCode(exitCode);
  }
  return Math.max(exitCode, normalizeFailureExitCode(structuredError.exitCode));
}

function resolveCliEntrypoint(): string {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('Cannot resolve cavendish CLI entrypoint from process.argv[1]');
  }
  return entry;
}

function appendJobState(jobId: string, state: string): void {
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cavendish:jobs] failed to parse worker event: ${message}\n`);
    return undefined;
  }
}

function parseStructuredError(line: string): StructuredErrorPayload | undefined {
  if (!line.trimStart().startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.error === true && typeof parsed.message === 'string' && typeof parsed.category === 'string') {
      return parsed as unknown as StructuredErrorPayload;
    }
    return undefined;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cavendish:jobs] failed to parse worker stderr as JSON: ${message}\n`);
    return undefined;
  }
}

function buildWorkerArgs(job: JobRecord): string[] {
  const workerFlags = ['--stream', '--format', 'json', '--quiet'];
  // Preserve backwards compatibility with jobs queued before the prompt-file
  // migration: if argv still contains a '--' separator, insert worker flags
  // before it so they are not treated as positional arguments.
  const dashDashIdx = job.argv.indexOf('--');
  if (dashDashIdx === -1) {
    return [...job.argv, ...workerFlags];
  }
  const before = job.argv.slice(0, dashDashIdx);
  const fromDash = job.argv.slice(dashDashIdx);
  return [...before, ...workerFlags, ...fromDash];
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

function makeStdinErrorPayload(error: unknown): StructuredErrorPayload {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
  const detail = code === 'EPIPE'
    ? 'Detached worker stdin closed before the prompt could be delivered (EPIPE).'
    : `Detached worker stdin failed before the prompt could be delivered: ${message}`;
  return {
    error: true,
    category: 'unknown',
    message: detail,
    exitCode: 1,
    action: 'Inspect the detached worker process output and retry the command.',
  };
}

function appendStderrEvent(jobId: string, line: string): void {
  appendJobEvent(jobId, JSON.stringify({
    type: 'stderr',
    line,
    timestamp: new Date().toISOString(),
  }));
}

async function runWorkerAttempt(jobId: string, job: JobRecord): Promise<{
  exitCode: number;
  finalEvent?: NdjsonEvent;
  structuredError?: StructuredErrorPayload;
  stderrLines: string[];
}> {
  const child = spawn(process.execPath, [resolveCliEntrypoint(), ...buildWorkerArgs(job)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CAVENDISH_ALLOW_PARTIAL: '1',
    },
  });
  if (typeof child.pid === 'number') {
    updateJob(jobId, {
      workerPid: child.pid,
    });
  }

  let finalEvent: NdjsonEvent | undefined;
  let structuredError: StructuredErrorPayload | undefined;
  let stdinError: StructuredErrorPayload | undefined;
  const stderrLines: string[] = [];

  child.stdin.on('error', (error: unknown) => {
    stdinError = makeStdinErrorPayload(error);
    process.stderr.write(`[cavendish:jobs] ${stdinError.message}\n`);
  });

  try {
    child.stdin.end(readJobPrompt(job.jobId));
  } catch (error: unknown) {
    stdinError = makeStdinErrorPayload(error);
    process.stderr.write(`[cavendish:jobs] ${stdinError.message}\n`);
  }

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
      return;
    }
    stderrLines.push(line);
    appendStderrEvent(jobId, line);
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
    structuredError: structuredError ?? stdinError,
    stderrLines,
  };
}

export async function runJobWorker(jobId: string): Promise<JobRunResult> {
  const current = readJob(jobId);
  if (current === undefined) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const retryCount = Number.isFinite(current.retryCount) ? current.retryCount : 0;
  let record = updateJob(jobId, {
    status: 'running',
    startedAt: current.startedAt ?? new Date().toISOString(),
    retryCount,
  });
  appendJobState(jobId, 'job-running');

  const { exitCode, finalEvent, structuredError, stderrLines } = await runWorkerAttempt(jobId, record);
  const normalizedExitCode = normalizeStructuredExitCode(exitCode, structuredError);

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
      workerPid: undefined,
    });
    appendJobState(jobId, `job-${status}`);
    notifyJobCompletion(record);
    return { outcome: status, record };
  }

  // Recover partial content from streamed chunks when no final event was
  // emitted (e.g. stall-timeout).  This ensures result.json is populated
  // so that `cavendish jobs wait` can return the best available content.
  const recoveredContent = recoverBestContentFromEvents(jobId);
  if (recoveredContent !== undefined && recoveredContent.length > 0) {
    const now = new Date().toISOString();
    writeJobResult(jobId, {
      event: { type: 'final', content: recoveredContent, partial: true, timestamp: now },
      savedAt: now,
    });
  }

  const errorPayload: StructuredErrorPayload = structuredError ?? {
    error: true,
    category: 'unknown',
    message: stderrLines.length > 0
      ? `Detached worker exited without a final event (exit code: ${String(exitCode)})\nDetached worker stderr:\n${stderrLines.join('\n')}`
      : `Detached worker exited without a final event (exit code: ${String(exitCode)})`,
    exitCode: normalizedExitCode,
    action: 'Inspect the job error output and retry the command.',
  };

  if (isLockContentionError(errorPayload)) {
    record = updateJob(jobId, (latest) => ({
      status: 'queued',
      startedAt: undefined,
      retryCount: (Number.isFinite(latest.retryCount) ? latest.retryCount : 0) + 1,
      lastRetriedAt: new Date().toISOString(),
      lastRetryError: errorPayload.message,
      workerPid: undefined,
    }));
    appendJobState(jobId, 'job-queued');
    return {
      outcome: 'retry',
      record,
      error: errorPayload,
    };
  }

  writeJobError(jobId, errorPayload);
  const status = terminalStatusFromError(errorPayload);
  const hasRecoveredContent = recoveredContent !== undefined && recoveredContent.length > 0;
  record = updateJob(jobId, {
    status,
    completedAt: new Date().toISOString(),
    error: errorPayload,
    exitCode: normalizedExitCode,
    partial: hasRecoveredContent ? true : undefined,
    workerPid: undefined,
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
  let job: JobRecord | undefined;
  try {
    job = readJob(jobId);
  } catch (readError: unknown) {
    progress(
      `Detached worker failed to load job metadata for ${jobId}: ${readError instanceof Error ? readError.message : String(readError)}`,
      false,
    );
    return;
  }
  if (job !== undefined) {
    const record = updateJob(jobId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: fallback,
      exitCode: 1,
      workerPid: undefined,
    });
    appendJobState(jobId, 'job-failed');
    notifyJobCompletion(record);
  }
}

export function markJobRunnerKilled(jobId: string): void {
  const fallback: StructuredErrorPayload = {
    error: true,
    category: 'runner_killed',
    message: `Detached runner was interrupted while job ${jobId} was running.`,
    exitCode: 11,
    action: 'Restart the detached job; the runner process was interrupted before it could finish.',
  };
  writeJobError(jobId, fallback);
  let job: JobRecord | undefined;
  try {
    job = readJob(jobId);
  } catch (readError: unknown) {
    progress(
      `Detached runner failed to load job metadata for ${jobId}: ${readError instanceof Error ? readError.message : String(readError)}`,
      false,
    );
    return;
  }
  if (job?.status !== 'running') {
    return;
  }
  const record = updateJob(jobId, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: fallback,
    exitCode: fallback.exitCode,
    workerPid: undefined,
  });
  appendJobState(jobId, 'job-failed');
  notifyJobCompletion(record);
}

export async function runJobWorkerOrExit(jobId: string): Promise<void> {
  try {
    const result = await runJobWorker(jobId);
    if (result.outcome === 'retry') {
      process.exitCode = normalizeFailureExitCode(result.error?.exitCode);
      return;
    }
    if (result.error !== undefined) {
      process.exitCode = normalizeFailureExitCode(result.error.exitCode);
      return;
    }
    if (result.outcome === 'failed' || result.outcome === 'timed_out') {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    markUnexpectedJobFailure(jobId, error);
    process.exitCode = 1;
  }
}
