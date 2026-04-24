import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testRoot: string;

async function importWithMockedHome(): Promise<typeof import('../src/core/jobs/store.js')> {
  vi.resetModules();
  vi.doMock('node:os', async () => {
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...realOs,
      homedir: (): string => testRoot,
    };
  });
  return import('../src/core/jobs/store.js');
}

describe('job store', () => {
  beforeEach(() => {
    testRoot = join(process.cwd(), `.tmp-jobs-test-${randomUUID()}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('creates, reads, and lists jobs', async () => {
    const { createJob, readJob, listJobs, getJobFilePath } = await importWithMockedHome();
    const job = createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });

    expect(existsSync(getJobFilePath(job.jobId))).toBe(true);
    expect(readJob(job.jobId)?.status).toBe('queued');
    expect(readJob(job.jobId)?.retryCount).toBe(0);
    expect(listJobs().map((entry) => entry.jobId)).toContain(job.jobId);
  });

  it('appends events and stores result/error payloads', async () => {
    const {
      appendJobEvent,
      createJob,
      getJobEventsPath,
      readJobError,
      readJobResult,
      writeJobError,
      writeJobResult,
    } = await importWithMockedHome();
    const job = createJob({
      kind: 'deep-research',
      argv: ['deep-research', 'topic'],
    });

    appendJobEvent(job.jobId, '{"type":"state","state":"job-running"}');
    writeJobResult(job.jobId, {
      event: {
        type: 'final',
        content: 'done',
        timestamp: '2026-03-14T00:00:00.000Z',
        partial: false,
      },
      savedAt: '2026-03-14T00:00:00.000Z',
    });
    writeJobError(job.jobId, {
      error: true,
      category: 'timeout',
      message: 'timed out',
      exitCode: 7,
      action: 'retry',
    });

    expect(readFileSync(getJobEventsPath(job.jobId), 'utf8')).toContain('"job-running"');
    expect(readJobResult(job.jobId)?.event.content).toBe('done');
    expect(readJobError(job.jobId)?.category).toBe('timeout');
  });

  it('ignores invalid job directories when listing jobs', async () => {
    const { createJob, getJobsDir, readNextQueuedJob } = await importWithMockedHome();
    const job = createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });
    mkdirSync(join(getJobsDir(), 'not-a-job-id'));

    expect(readNextQueuedJob()?.jobId).toBe(job.jobId);
  });

  it('skips invalid legacy job records without retry metadata', async () => {
    const { createJob, getJobsDir, getJobFilePath, readNextQueuedJob } = await importWithMockedHome();
    const job = createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });
    const legacyJobId = '00000000-0000-4000-8000-000000000099';
    mkdirSync(join(getJobsDir(), legacyJobId), { recursive: true });
    writeFileSync(getJobFilePath(legacyJobId), `${JSON.stringify({
      jobId: legacyJobId,
      kind: 'ask',
      status: 'queued',
      argv: ['ask', 'legacy'],
      submittedAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
      resultPath: join(getJobsDir(), legacyJobId, 'result.json'),
      eventsPath: join(getJobsDir(), legacyJobId, 'events.ndjson'),
      errorPath: join(getJobsDir(), legacyJobId, 'error.json'),
    }, null, 2)}\n`);
    const incompleteJobId = '00000000-0000-4000-8000-000000000097';
    mkdirSync(join(getJobsDir(), incompleteJobId), { recursive: true });
    writeFileSync(getJobFilePath(incompleteJobId), `${JSON.stringify({
      retryCount: 0,
    }, null, 2)}\n`);

    expect(readNextQueuedJob()?.jobId).toBe(job.jobId);
  });

  it('recovers the longest chunk content from events.ndjson', async () => {
    const { appendJobEvent, createJob, recoverBestContentFromEvents } = await importWithMockedHome();
    const job = createJob({ kind: 'ask', argv: ['ask', 'hello'] });
    appendJobEvent(job.jobId, JSON.stringify({ type: 'chunk', content: 'Hello', timestamp: '2026-01-01T00:00:00Z' }));
    appendJobEvent(job.jobId, JSON.stringify({ type: 'chunk', content: 'Hello world', timestamp: '2026-01-01T00:00:01Z' }));
    appendJobEvent(job.jobId, JSON.stringify({ type: 'chunk', content: 'Hello world, how are you?', timestamp: '2026-01-01T00:00:02Z' }));
    appendJobEvent(job.jobId, JSON.stringify({ type: 'state', state: 'job-running', content: '', timestamp: '2026-01-01T00:00:03Z' }));

    expect(recoverBestContentFromEvents(job.jobId)).toBe('Hello world, how are you?');
  });

  it('returns undefined when events.ndjson has no chunk or final events', async () => {
    const { appendJobEvent, createJob, recoverBestContentFromEvents } = await importWithMockedHome();
    const job = createJob({ kind: 'ask', argv: ['ask', 'hello'] });
    appendJobEvent(job.jobId, JSON.stringify({ type: 'state', state: 'job-running', content: '', timestamp: '2026-01-01T00:00:00Z' }));

    expect(recoverBestContentFromEvents(job.jobId)).toBeUndefined();
  });

  it('returns undefined when events.ndjson does not exist', async () => {
    const { recoverBestContentFromEvents } = await importWithMockedHome();

    expect(recoverBestContentFromEvents('00000000-0000-4000-8000-000000000001')).toBeUndefined();
  });

  it('skips job files that deserialize to null', async () => {
    const { createJob, getJobsDir, getJobFilePath, readNextQueuedJob } = await importWithMockedHome();
    const job = createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });
    const invalidJobId = '00000000-0000-4000-8000-000000000098';
    mkdirSync(join(getJobsDir(), invalidJobId), { recursive: true });
    writeFileSync(getJobFilePath(invalidJobId), 'null\n');

    expect(readNextQueuedJob()?.jobId).toBe(job.jobId);
  });

  it('recovers a stale running job whose worker pid is no longer alive', async () => {
    const { createJob, readJob, readNextQueuedJob, updateJob } = await importWithMockedHome();
    const job = createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });
    updateJob(job.jobId, {
      status: 'running',
      workerPid: 987_654,
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    try {
      const next = readNextQueuedJob();

      expect(next?.jobId).toBe(job.jobId);
      expect(next?.status).toBe('queued');
      expect(next?.retryCount).toBe(1);
      expect(next?.workerPid).toBeUndefined();
      expect(next?.lastRetryError).toContain('worker process 987654 is no longer running');
      expect(readJob(job.jobId)?.status).toBe('queued');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('recovers a stale running job when updatedAt has not advanced', async () => {
    const { createJob, getJobFilePath, readNextQueuedJob, updateJob } = await importWithMockedHome();
    const job = createJob({
      kind: 'ask',
      argv: ['ask', 'hello'],
    });
    const runningJob = updateJob(job.jobId, {
      status: 'running',
    });
    writeFileSync(getJobFilePath(job.jobId), `${JSON.stringify({
      ...runningJob,
      updatedAt: '2026-03-14T00:00:00.000Z',
    }, null, 2)}\n`);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-03-14T00:31:00.000Z').getTime(),
    );

    try {
      const next = readNextQueuedJob();

      expect(next?.jobId).toBe(job.jobId);
      expect(next?.status).toBe('queued');
      expect(next?.retryCount).toBe(1);
      expect(next?.lastRetryError).toContain('no progress');
    } finally {
      nowSpy.mockRestore();
    }
  });
});
