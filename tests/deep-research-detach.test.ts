import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SAFE_RESEARCH_PATH = join(process.cwd(), '.tmp-tests', 'research.csv');
const SAFE_JOB_PATH = join(process.cwd(), '.tmp-tests', 'dr-job.json');
const SAFE_EVENTS_PATH = join(process.cwd(), '.tmp-tests', 'dr-events.ndjson');

let jsonRawMock: ReturnType<typeof vi.fn>;
let submitDetachedJobMock: ReturnType<typeof vi.fn>;
let withDriverMock: ReturnType<typeof vi.fn>;

vi.mock('../src/core/cli-args.js', () => ({
  FORMAT_ARG: {},
  GLOBAL_ARGS: {},
  STREAM_ARG: {},
  buildPrompt: vi.fn((prompt: string): string => prompt),
  readStdin: vi.fn().mockReturnValue(''),
  rejectUnknownFlags: vi.fn().mockReturnValue(true),
  validateFileArgs: vi.fn().mockReturnValue([SAFE_RESEARCH_PATH]),
}));

vi.mock('../src/core/jobs/store.js', () => ({
  getJobFilePath: vi.fn(() => SAFE_JOB_PATH),
}));

vi.mock('../src/core/jobs/submit.js', () => {
  submitDetachedJobMock = vi.fn(() => ({
    jobId: 'job-dr-1',
    kind: 'deep-research',
    status: 'queued',
    submittedAt: '2026-03-14T00:00:00.000Z',
    eventsPath: SAFE_EVENTS_PATH,
  }));
  return {
    submitDetachedJob: submitDetachedJobMock,
  };
});

vi.mock('../src/core/output-handler.js', () => {
  jsonRawMock = vi.fn();
  return {
    emitFinal: vi.fn(),
    emitState: vi.fn(),
    errorMessage: vi.fn((e: unknown): string => (e instanceof Error ? e.message : String(e))),
    failValidation: vi.fn(),
    json: vi.fn(),
    jsonRaw: jsonRawMock,
    progress: vi.fn(),
    text: vi.fn(),
    validateFormat: vi.fn().mockReturnValue('json'),
    verbose: vi.fn(),
  };
});

vi.mock('../src/core/with-driver.js', () => {
  const mock = vi.fn();
  withDriverMock = mock;
  return { withDriver: mock };
});

vi.mock('../src/constants/selectors.js', async () => {
  const actual = await vi.importActual<typeof import('../src/constants/selectors.js')>('../src/constants/selectors.js');
  return {
    ...actual,
    assertValidChatId: vi.fn(),
  };
});

interface DetachedRequest {
  kind: string;
  notifyFile?: string;
  argv: string[];
}

interface SubmitPayload {
  jobId: string;
  kind: string;
  status: string;
  submittedAt: string;
  jobPath: string;
  eventsPath: string;
  notifyFile?: string;
}

describe('deep-research --detach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits a detached deep-research job and returns job metadata', async () => {
    const { deepResearchCommand } = await import('../src/commands/deep-research.js');
    const run = deepResearchCommand.run;
    if (run === undefined) {
      throw new Error('deepResearchCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        prompt: 'research topic',
        quiet: false,
        verbose: false,
        stream: false,
        dryRun: false,
        format: 'json',
        detach: true,
        notifyFile: './dr-notify.ndjson',
        export: 'markdown',
        exportPath: './report.md',
      } as never,
      rawArgs: [],
      cmd: deepResearchCommand,
    });

    expect(submitDetachedJobMock).toHaveBeenCalledOnce();
    expect(withDriverMock).not.toHaveBeenCalled();
    const request = submitDetachedJobMock.mock.calls[0]?.[0] as DetachedRequest | undefined;
    expect(request).toBeDefined();
    if (request === undefined) {
      throw new Error('Detached deep-research request was not captured');
    }
    expect(request.kind).toBe('deep-research');
    expect(request.notifyFile).toMatch(/dr-notify\.ndjson$/);
    expect(request.argv).toEqual([
      'deep-research',
      '--timeout',
      '1800',
      '--file',
      SAFE_RESEARCH_PATH,
      '--export',
      'markdown',
      '--exportPath',
      './report.md',
    ]);

    const payload = jsonRawMock.mock.calls[0]?.[0] as SubmitPayload | undefined;
    expect(payload).toBeDefined();
    if (payload === undefined) {
      throw new Error('Detached deep-research payload was not emitted');
    }
    expect(payload.jobId).toBe('job-dr-1');
    expect(payload.kind).toBe('deep-research');
    expect(payload.status).toBe('queued');
    expect(payload.submittedAt).toBe('2026-03-14T00:00:00.000Z');
    expect(payload.jobPath).toBe(SAFE_JOB_PATH);
    expect(payload.eventsPath).toBe(SAFE_EVENTS_PATH);
    expect(payload.notifyFile).toMatch(/dr-notify\.ndjson$/);
  });
});
