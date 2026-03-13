import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CAVENDISH_DIR } from '../browser-manager.js';
import type { StructuredErrorPayload } from '../errors.js';

import type { DetachedJobRequest, JobRecord, JobResultRecord } from './types.js';

const JOBS_DIR = join(CAVENDISH_DIR, 'jobs');
const JOB_FILE = 'job.json';
const EVENTS_FILE = 'events.ndjson';
const RESULT_FILE = 'result.json';
const ERROR_FILE = 'error.json';

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
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
    resultPath: getJobResultPath(jobId),
    eventsPath: getJobEventsPath(jobId),
    errorPath: getJobErrorPath(jobId),
  };
  saveJob(record);
  return record;
}

export function saveJob(record: JobRecord): void {
  ensureDir(getJobDir(record.jobId));
  writeJsonAtomic(getJobFilePath(record.jobId), record);
}

export function updateJob(
  jobId: string,
  updates: Partial<JobRecord>,
): JobRecord {
  const current = readJob(jobId);
  if (current === undefined) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const next: JobRecord = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  saveJob(next);
  return next;
}

export function readJob(jobId: string): JobRecord | undefined {
  const path = getJobFilePath(jobId);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as JobRecord;
}

export function listJobs(): JobRecord[] {
  if (!existsSync(JOBS_DIR)) {
    return [];
  }
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJob(entry.name))
    .filter((value): value is JobRecord => value !== undefined)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
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
  return JSON.parse(readFileSync(path, 'utf8')) as JobResultRecord;
}

export function writeJobError(jobId: string, error: StructuredErrorPayload): void {
  writeJsonAtomic(getJobErrorPath(jobId), error);
}

export function readJobError(jobId: string): StructuredErrorPayload | undefined {
  const path = getJobErrorPath(jobId);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as StructuredErrorPayload;
}
