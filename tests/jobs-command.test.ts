import { beforeEach, describe, expect, it, vi } from 'vitest';

let failStructuredMock: ReturnType<typeof vi.fn>;
let jsonRawMock: ReturnType<typeof vi.fn>;
let progressMock: ReturnType<typeof vi.fn>;

interface RunnableCommand {
  run?: (context: {
    args: never;
    rawArgs: string[];
    cmd: RunnableCommand;
  }) => void | Promise<void>;
}

vi.mock('../src/core/cli-args.js', () => ({
  FORMAT_ARG: {},
  GLOBAL_ARGS: {},
  rejectUnknownFlags: vi.fn().mockReturnValue(true),
  toTimeoutMs: (sec: number): number => sec === 0 ? Number.MAX_SAFE_INTEGER : sec * 1000,
  formatTimeoutDisplay: (sec: number): string => sec === 0 ? 'unlimited' : `${String(sec)}s`,
}));

vi.mock('../src/core/jobs/store.js', () => ({
  listJobs: vi.fn(() => [
    {
      jobId: 'job-1',
      kind: 'ask',
      status: 'queued',
      submittedAt: '2026-03-14T00:00:00.000Z',
      updatedAt: '2026-03-14T00:00:00.000Z',
      retryCount: 2,
      lastRetriedAt: '2026-03-14T00:00:10.000Z',
      lastRetryError: 'Another cavendish process is running.',
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
  failStructuredMock = vi.fn();
  jsonRawMock = vi.fn();
  progressMock = vi.fn();
  return {
    fail: vi.fn(),
    failStructured: failStructuredMock,
    jsonRaw: jsonRawMock,
    progress: progressMock,
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
        retryCount: 2,
        lastRetriedAt: '2026-03-14T00:00:10.000Z',
        lastRetryError: 'Another cavendish process is running.',
      },
    ]);
  });

  it('does not emit the root jobs list when a subcommand is invoked', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const run = jobsCommand.run;
    if (run === undefined) {
      throw new Error('jobsCommand.run is undefined');
    }

    await run({
      args: {
        _: ['read'],
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: ['read', 'job-1', '--format', 'json'],
      cmd: jobsCommand,
    });

    expect(jsonRawMock).not.toHaveBeenCalled();
  });

  it('does not emit the root jobs list when options appear before a subcommand', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const run = jobsCommand.run;
    if (run === undefined) {
      throw new Error('jobsCommand.run is undefined');
    }

    await run({
      args: {
        _: ['read'],
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: ['--format', 'json', 'read', 'job-1'],
      cmd: jobsCommand,
    });

    expect(jsonRawMock).not.toHaveBeenCalled();
  });

  it('does not treat string option values as subcommand names', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const run = jobsCommand.run;
    if (run === undefined) {
      throw new Error('jobsCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        format: 'list',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: ['--format', 'list'],
      cmd: jobsCommand,
    });

    expect(jsonRawMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces invalid job metadata through failStructured', async () => {
    const { jobsCommand } = await import('../src/commands/jobs.js');
    const store = await import('../src/core/jobs/store.js');
    vi.mocked(store.readJob).mockImplementation(() => {
      throw new Error('Job job-1 has invalid status metadata. Recreate the detached job and retry.');
    });
    const subCommands = jobsCommand.subCommands as unknown as { read?: RunnableCommand };
    const readCommand = subCommands.read;
    const run = readCommand?.run;
    if (readCommand === undefined || run === undefined) {
      throw new Error('jobsCommand.subCommands.read.run is undefined');
    }

    await Promise.resolve(run({
      args: {
        _: [],
        jobId: 'job-1',
        format: 'json',
        quiet: false,
        verbose: false,
      } as never,
      rawArgs: [],
      cmd: readCommand,
    }));

    expect(failStructuredMock).toHaveBeenCalledTimes(1);
  });

  it('supports --poll on jobs wait and emits periodic progress updates', async () => {
    vi.useFakeTimers();
    try {
      const { jobsCommand } = await import('../src/commands/jobs.js');
      const store = await import('../src/core/jobs/store.js');
      vi.mocked(store.readJob)
        .mockReturnValueOnce({
          jobId: 'job-1',
          kind: 'ask',
          status: 'running',
          submittedAt: '2026-03-14T00:00:00.000Z',
          updatedAt: '2026-03-14T00:00:00.000Z',
          retryCount: 0,
        } as never)
        .mockReturnValueOnce({
          jobId: 'job-1',
          kind: 'ask',
          status: 'completed',
          submittedAt: '2026-03-14T00:00:00.000Z',
          updatedAt: '2026-03-14T00:00:01.000Z',
          retryCount: 0,
        } as never);
      vi.mocked(store.readJobResult).mockReturnValue({
        event: {
          content: 'final response',
          model: 'Pro',
          partial: false,
          timeoutSec: 0,
          timestamp: '2026-03-14T00:00:01.000Z',
        },
      } as never);

      const subCommands = jobsCommand.subCommands as unknown as {
        wait?: RunnableCommand;
      };
      const waitCommand = subCommands.wait;
      const run = waitCommand?.run;
      if (waitCommand === undefined || run === undefined) {
        throw new Error('jobsCommand.subCommands.wait.run is undefined');
      }

      const runPromise = Promise.resolve(run({
        args: {
          _: [],
          jobId: 'job-1',
          poll: '0.1',
          timeout: '5',
          format: 'json',
          quiet: false,
          verbose: false,
        } as never,
        rawArgs: [],
        cmd: waitCommand,
      }));

      await vi.advanceTimersByTimeAsync(250);
      await runPromise;

      expect(progressMock).toHaveBeenCalled();
      expect(jsonRawMock).toHaveBeenCalledWith({
        content: 'final response',
        model: 'Pro',
        chatId: undefined,
        url: undefined,
        project: undefined,
        partial: false,
        timeoutSec: 0,
        timestamp: '2026-03-14T00:00:01.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
