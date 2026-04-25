import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isWorkerPidAlive, latestJobProgressMs } from '../src/core/jobs/pid-utils.js';
import type { JobRecord } from '../src/core/jobs/types.js';

let testRoot: string;

function makeJob(updatedAt: string, eventsPath: string): JobRecord {
  return {
    jobId: randomUUID(),
    kind: 'ask',
    status: 'running',
    argv: ['ask', 'hello'],
    submittedAt: updatedAt,
    updatedAt,
    retryCount: 0,
    resultPath: join(testRoot, 'result.json'),
    eventsPath,
    errorPath: join(testRoot, 'error.json'),
  };
}

describe('job pid utilities', () => {
  beforeEach(() => {
    testRoot = join(process.cwd(), `.tmp-jobs-pid-utils-${randomUUID()}`);
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('treats ESRCH as a dead worker pid', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    expect(isWorkerPidAlive(12345)).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(12345, 0);
  });

  it('treats EPERM as an alive worker pid', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    expect(isWorkerPidAlive(12345)).toBe(true);
  });

  it('preserves alive status for unexpected pid check errors', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('unexpected pid check failure');
    });

    expect(isWorkerPidAlive(12345)).toBe(true);
  });

  it('uses the newest signal from job metadata and events file mtime', () => {
    const eventsPath = join(testRoot, 'events.ndjson');
    writeFileSync(eventsPath, '{"type":"chunk","timestamp":"2026-03-14T00:20:00.000Z"}\n');
    const eventsTime = new Date('2026-03-14T00:20:00.000Z');
    utimesSync(eventsPath, eventsTime, eventsTime);
    const job = makeJob('2026-03-14T00:00:00.000Z', eventsPath);

    expect(latestJobProgressMs(job)).toBe(statSync(eventsPath).mtimeMs);
  });
});
