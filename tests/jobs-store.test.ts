import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
});
