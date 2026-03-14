import { beforeEach, describe, expect, it, vi } from 'vitest';

let jsonRawMock: ReturnType<typeof vi.fn>;

vi.mock('../src/core/cli-args.js', () => ({
  FORMAT_ARG: {},
  GLOBAL_ARGS: {},
  rejectUnknownFlags: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/core/jobs/store.js', () => ({
  listJobs: vi.fn(() => [
    {
      jobId: 'job-1',
      kind: 'ask',
      status: 'queued',
      submittedAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
    },
  ]),
  readJob: vi.fn(),
  readJobError: vi.fn(),
  readJobResult: vi.fn(),
}));

vi.mock('../src/core/jobs/worker.js', () => ({
  runJobWorkerOrExit: vi.fn(),
}));

vi.mock('../src/core/jobs/runner.js', () => ({
  runJobRunnerOrExit: vi.fn(),
}));

vi.mock('../src/core/output-handler.js', () => {
  jsonRawMock = vi.fn();
  return {
    fail: vi.fn(),
    failStructured: vi.fn(),
    jsonRaw: jsonRawMock,
    progress: vi.fn(),
    text: vi.fn(),
    validateFormat: vi.fn().mockReturnValue('json'),
  };
});

describe('jobs command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists detached jobs from the root jobs command', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const run = jobsCommand.run;
    if (run === undefined) {
      throw new Error('jobsCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: [],
      cmd: jobsCommand,
    });

    expect(jsonRawMock).toHaveBeenCalledWith([
      {
        id: 'job-1',
        kind: 'ask',
        status: 'queued',
        submittedAt: '2026-03-14T00:00:00.000Z',
        updatedAt: '2026-03-14T00:00:00.000Z',
        chatId: undefined,
      },
    ]);
  });
});
