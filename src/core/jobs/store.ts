import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CAVENDISH_DIR } from '../browser-manager.js';
import type { StructuredErrorPayload } from '../errors.js';

import type { DetachedJobRequest, JobKind, JobRecord, JobResultRecord, JobStatus } from './types.js';

const JOBS_DIR = join(CAVENDISH_DIR, 'jobs');
const JOB_FILE = 'job.json';
const PROMPT_FILE = 'prompt.txt';
const EVENTS_FILE = 'events.ndjson';
const RESULT_FILE = 'result.json';
const ERROR_FILE = 'error.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KINDS: readonly JobKind[] = ['ask', 'deep-research'];
const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled'];
const STALE_RUNNING_JOB_MS = 30 * 60 * 1000;
const STALE_RUNNING_JOB_MAX_RETRIES = 3;

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  chmodSync(path, DIR_MODE);
}

function assertValidJobId(jobId: string): void {
  if (!UUID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job ID: ${jobId}`);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function writeJsonAtomic(path: string, data: unknown): void {
  ensureDir(dirname(path));
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tempPath, path);
}

export function getJobsDir(): string {
  ensureDir(JOBS_DIR);
  return JOBS_DIR;
}

export function getJobDir(jobId: string): string {
  assertValidJobId(jobId);
  return join(getJobsDir(), jobId);
}

export function getJobFilePath(jobId: string): string {
  return join(getJobDir(jobId), JOB_FILE);
}

export function getJobEventsPath(jobId: string): string {
  return join(getJobDir(jobId), EVENTS_FILE);
}

export function getJobResultPath(jobId: string): string {
  return join(getJobDir(jobId), RESULT_FILE);
}

export function getJobErrorPath(jobId: string): string {
  return join(getJobDir(jobId), ERROR_FILE);
}

export function getJobPromptPath(jobId: string): string {
  return join(getJobDir(jobId), PROMPT_FILE);
}

export function readJobPrompt(jobId: string): string {
  const path = getJobPromptPath(jobId);
  if (!existsSync(path)) {
    return '';
  }
  return readFileSync(path, 'utf8');
}

export function createJob(request: DetachedJobRequest): JobRecord {
  const jobId = randomUUID();
  const submittedAt = new Date().toISOString();
  const record: JobRecord = {
    jobId,
    kind: request.kind,
    status: 'queued',
    argv: request.argv,
    notifyFile: request.notifyFile,
    submittedAt,
    updatedAt: submittedAt,
    retryCount: 0,
    resultPath: getJobResultPath(jobId),
    eventsPath: getJobEventsPath(jobId),
    errorPath: getJobErrorPath(jobId),
  };
  // Write the prompt file before persisting the job record so that an
  // already-running detached runner cannot pick up the job before the
  // prompt is available on disk.
  if (request.prompt !== undefined && request.prompt.length > 0) {
    ensureDir(getJobDir(jobId));
    const promptPath = getJobPromptPath(jobId);
    writeFileSync(promptPath, request.prompt);
    chmodSync(promptPath, FILE_MODE);
  }
  saveJob(record);
  return record;
}

export function saveJob(record: JobRecord): void {
  ensureDir(getJobDir(record.jobId));
  writeJsonAtomic(getJobFilePath(record.jobId), record);
}

export function updateJob(
  jobId: string,
  updates: Partial<JobRecord> | ((current: JobRecord) => Partial<JobRecord>),
): JobRecord {
  const current = readJob(jobId);
  if (current === undefined) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const nextUpdates = typeof updates === 'function'
    ? updates(current)
    : updates;
  const next: JobRecord = {
    ...current,
    ...nextUpdates,
    updatedAt: new Date().toISOString(),
  };
  saveJob(next);
  return next;
}

function readJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cavendish:jobs] failed to parse ${label} at "${path}": ${message}\n`);
    return undefined;
  }
}

function assertStringField(value: unknown, field: string, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} has invalid ${field} metadata. Recreate the detached job and retry.`);
  }
}

function assertOptionalStringField(value: unknown, field: string, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${label} has invalid ${field} metadata. Recreate the detached job and retry.`);
  }
}

function assertOptionalNumberField(value: unknown, field: string, label: string): void {
  if (value !== undefined && typeof value !== 'number') {
    throw new Error(`${label} has invalid ${field} metadata. Recreate the detached job and retry.`);
  }
}

function assertOptionalBooleanField(value: unknown, field: string, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${label} has invalid ${field} metadata. Recreate the detached job and retry.`);
  }
}

function assertValidJobRecordShape(record: unknown, label: string): asserts record is JobRecord {
  if (record === null || typeof record !== 'object') {
    throw new Error(`${label} is not a valid job record object. Recreate the detached job and retry.`);
  }
  const candidate = record as Partial<JobRecord>;
  assertStringField(candidate.jobId, 'jobId', label);
  assertValidJobId(candidate.jobId);
  if (typeof candidate.kind !== 'string' || !JOB_KINDS.includes(candidate.kind)) {
    throw new Error(`${label} has invalid kind metadata. Recreate the detached job and retry.`);
  }
  if (typeof candidate.status !== 'string' || !JOB_STATUSES.includes(candidate.status)) {
    throw new Error(`${label} has invalid status metadata. Recreate the detached job and retry.`);
  }
  if (!Array.isArray(candidate.argv) || candidate.argv.some((value) => typeof value !== 'string')) {
    throw new Error(`${label} has invalid argv metadata. Recreate the detached job and retry.`);
  }
  assertStringField(candidate.submittedAt, 'submittedAt', label);
  assertStringField(candidate.updatedAt, 'updatedAt', label);
  assertStringField(candidate.resultPath, 'resultPath', label);
  assertStringField(candidate.eventsPath, 'eventsPath', label);
  assertStringField(candidate.errorPath, 'errorPath', label);
  if (typeof candidate.retryCount !== 'number' || !Number.isInteger(candidate.retryCount) || candidate.retryCount < 0) {
    throw new Error(`${label} is missing required retryCount metadata. Recreate the detached job and retry.`);
  }
  assertOptionalStringField(candidate.notifyFile, 'notifyFile', label);
  assertOptionalStringField(candidate.startedAt, 'startedAt', label);
  assertOptionalStringField(candidate.completedAt, 'completedAt', label);
  assertOptionalStringField(candidate.chatId, 'chatId', label);
  assertOptionalStringField(candidate.url, 'url', label);
  assertOptionalStringField(candidate.lastRetriedAt, 'lastRetriedAt', label);
  assertOptionalStringField(candidate.lastRetryError, 'lastRetryError', label);
  assertOptionalBooleanField(candidate.partial, 'partial', label);
  assertOptionalNumberField(candidate.exitCode, 'exitCode', label);
  assertOptionalNumberField(candidate.workerPid, 'workerPid', label);
}

export function readJob(jobId: string): JobRecord | undefined {
  const path = getJobFilePath(jobId);
  if (!existsSync(path)) {
    return undefined;
  }
  const record = readJsonFile(path, `job ${jobId}`);
  if (record === undefined) {
    return undefined;
  }
  assertValidJobRecordShape(record, `Job ${jobId}`);
  return record;
}

export function listJobs(): JobRecord[] {
  if (!existsSync(JOBS_DIR)) {
    return [];
  }
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readJob(entry.name);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[cavendish:jobs] skipping invalid job directory "${entry.name}": ${message}\n`);
        return undefined;
      }
    })
    .filter((value): value is JobRecord => value !== undefined)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

function isWorkerPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'EPERM') {
      return false;
    }
    if (isErrnoException(error) && error.code === 'ESRCH') {
      return true;
    }
    return true;
  }
}

function staleRunningReason(job: JobRecord, nowMs: number): string | undefined {
  if (job.status !== 'running') {
    return undefined;
  }
  if (job.workerPid !== undefined && isWorkerPidDead(job.workerPid)) {
    return `worker process ${String(job.workerPid)} is no longer running`;
  }
  const updatedAtMs = Date.parse(job.updatedAt);
  if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= STALE_RUNNING_JOB_MS) {
    return `no progress for ${String(Math.round((nowMs - updatedAtMs) / 1000))}s`;
  }
  return undefined;
}

function recoverStaleRunningJob(job: JobRecord, reason: string): JobRecord {
  const retryCount = Number.isFinite(job.retryCount) ? job.retryCount : 0;
  if (retryCount >= STALE_RUNNING_JOB_MAX_RETRIES) {
    const error: StructuredErrorPayload = {
      error: true,
      category: 'job_no_progress',
      message: `Detached job ${job.jobId} did not make progress: ${reason}.`,
      exitCode: 12,
      action: 'Inspect the job events and submit the job again if needed.',
    };
    writeJobError(job.jobId, error);
    return updateJob(job.jobId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error,
      exitCode: error.exitCode,
      workerPid: undefined,
      lastRetryError: reason,
    });
  }
  return updateJob(job.jobId, {
    status: 'queued',
    startedAt: undefined,
    workerPid: undefined,
    retryCount: retryCount + 1,
    lastRetriedAt: new Date().toISOString(),
    lastRetryError: `Recovered stale running job: ${reason}`,
  });
}

export function readNextQueuedJob(): JobRecord | undefined {
  const jobs = listJobs();
  const nowMs = Date.now();
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    if (job.status === 'queued') {
      return job;
    }
    const staleReason = staleRunningReason(job, nowMs);
    if (staleReason !== undefined) {
      const recovered = recoverStaleRunningJob(job, staleReason);
      if (recovered.status === 'queued') {
        return recovered;
      }
    }
  }
  return undefined;
}

export function appendJobEvent(jobId: string, line: string): void {
  ensureDir(getJobDir(jobId));
  appendFileSync(getJobEventsPath(jobId), `${line}\n`);
}

export function writeJobResult(jobId: string, result: JobResultRecord): void {
  writeJsonAtomic(getJobResultPath(jobId), result);
}

export function readJobResult(jobId: string): JobResultRecord | undefined {
  const path = getJobResultPath(jobId);
  if (!existsSync(path)) {
    return undefined;
  }
  return readJsonFile(path, `job result ${jobId}`) as JobResultRecord | undefined;
}

/**
 * Scan events.ndjson for the longest content from chunk/final events.
 * Used to recover partial responses when no final event was emitted
 * (e.g. stall-timeout where the worker exits before writing a result).
 */
export function recoverBestContentFromEvents(jobId: string): string | undefined {
  const path = getJobEventsPath(jobId);
  if (!existsSync(path)) {
    return undefined;
  }
  let best: string | undefined;
  let bestLength = 0;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    if (line.length === 0) {continue;}
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type !== 'chunk' && parsed.type !== 'final') {continue;}
      const content = parsed.content;
      if (typeof content === 'string' && content.length > bestLength) {
        best = content;
        bestLength = content.length;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[cavendish:jobs] skipping malformed event line in ${path}: ${message}\n`);
    }
  }
  return best;
}

export function writeJobError(jobId: string, error: StructuredErrorPayload): void {
  writeJsonAtomic(getJobErrorPath(jobId), error);
}

export function readJobError(jobId: string): StructuredErrorPayload | undefined {
  const path = getJobErrorPath(jobId);
  if (!existsSync(path)) {
    return undefined;
  }
  return readJsonFile(path, `job error ${jobId}`) as StructuredErrorPayload | undefined;
}
