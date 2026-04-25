import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SAFE_CONTEXT_PATH = join(process.cwd(), '.tmp-tests', 'context.txt');
const SAFE_JOB_PATH = join(process.cwd(), '.tmp-tests', 'job.json');
const SAFE_EVENTS_PATH = join(process.cwd(), '.tmp-tests', 'events.ndjson');

let jsonRawMock: ReturnType<typeof vi.fn>;
let failStructuredMock: ReturnType<typeof vi.fn>;
let failValidationMock: ReturnType<typeof vi.fn>;
let submitDetachedJobMock: ReturnType<typeof vi.fn>;
let readStdinMock: ReturnType<typeof vi.fn>;
let buildPromptMock: ReturnType<typeof vi.fn>;

vi.mock('../src/core/browser-manager.js', () => ({
  BrowserManager: vi.fn(() => ({
    getPage: vi.fn(),
    closePage: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('../src/core/chatgpt-driver.js', () => ({
  ChatGPTDriver: vi.fn(() => ({})),
}));

vi.mock('../src/core/cli-args.js', () => {
  readStdinMock = vi.fn().mockReturnValue('');
  buildPromptMock = vi.fn((prompt: string): string => prompt);
  return {
    FORMAT_ARG: {},
    GLOBAL_ARGS: {},
    STREAM_ARG: {},
    buildPrompt: buildPromptMock,
    extractArgsOrFail: vi.fn((flag: string) => (flag === 'gdrive' ? ['drive-doc'] : [])),
    readStdin: readStdinMock,
    rejectUnknownFlags: vi.fn().mockReturnValue(true),
    validateFileArgs: vi.fn().mockReturnValue([SAFE_CONTEXT_PATH]),
    parseUploadTimeout: vi.fn().mockReturnValue(undefined),
    toTimeoutMs: (sec: number): number => sec === 0 ? Number.MAX_SAFE_INTEGER : sec * 1000,
    formatTimeoutDisplay: (sec: number): string => sec === 0 ? 'unlimited' : `${String(sec)}s`,
  };
});

vi.mock('../src/core/model-config.js', () => ({
  allowedThinkingEfforts: vi.fn().mockReturnValue(['light', 'standard', 'extended', 'deep']),
  supportsGitHub: vi.fn().mockReturnValue(true),
  THINKING_EFFORT_LEVELS: ['light', 'standard', 'extended', 'deep'],
}));

vi.mock('../src/core/jobs/store.js', () => ({
  getJobFilePath: vi.fn(() => SAFE_JOB_PATH),
}));

vi.mock('../src/core/jobs/submit.js', () => {
  submitDetachedJobMock = vi.fn(() => ({
    jobId: 'job-ask-1',
    kind: 'ask',
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
  failStructuredMock = vi.fn();
  failValidationMock = vi.fn();
  return {
    emitChunk: vi.fn(),
    emitFinal: vi.fn(),
    errorMessage: vi.fn((e: unknown): string => (e instanceof Error ? e.message : String(e))),
    failStructured: failStructuredMock,
    failValidation: failValidationMock,
    json: vi.fn(),
    jsonRaw: jsonRawMock,
    progress: vi.fn(),
    text: vi.fn(),
    validateFormat: vi.fn().mockReturnValue('json'),
    verbose: vi.fn(),
  };
});

vi.mock('../src/core/process-lock.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock('../src/core/shutdown.js', () => ({
  registerCleanup: vi.fn(() => vi.fn()),
}));

vi.mock('../src/constants/selectors.js', () => ({
  assertValidChatId: vi.fn(),
}));

import type { DetachedSubmitPayload } from '../src/core/jobs/helpers.js';
import type { DetachedJobRequest } from '../src/core/jobs/types.js';

describe('ask --detach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits a detached ask job and returns job metadata', async () => {
    const { askCommand } = await import('../src/commands/ask.js');
    const run = askCommand.run;
    if (run === undefined) {
      throw new Error('askCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        prompt: 'hello',
        model: 'Pro',
        quiet: false,
        verbose: false,
        stream: false,
        dryRun: false,
        format: 'json',
        continue: false,
        agent: true,
        detach: true,
        notifyFile: './notify.ndjson',
        thinkingEffort: 'standard',
        github: 'owner/repo',
      } as never,
      rawArgs: [],
      cmd: askCommand,
    });

    expect(submitDetachedJobMock).toHaveBeenCalledOnce();
    const request = submitDetachedJobMock.mock.calls[0]?.[0] as DetachedJobRequest | undefined;
    expect(request).toBeDefined();
    if (request === undefined) {
      throw new Error('Detached ask request was not captured');
    }
    expect(request.kind).toBe('ask');
    expect(request.notifyFile).toMatch(/notify\.ndjson$/);
    expect(request.argv).toEqual([
      'ask',
      '--model',
      'Pro',
      '--timeout',
      '0',
      '--file',
      SAFE_CONTEXT_PATH,
      '--gdrive',
      'drive-doc',
      '--agent',
      '--thinking-effort',
      'standard',
    ]);
    expect(request.prompt).toBe('hello');

    const payload = jsonRawMock.mock.calls[0]?.[0] as DetachedSubmitPayload | undefined;
    expect(payload).toBeDefined();
    if (payload === undefined) {
      throw new Error('Detached ask payload was not emitted');
    }
    expect(payload.jobId).toBe('job-ask-1');
    expect(payload.kind).toBe('ask');
    expect(payload.status).toBe('queued');
    expect(payload.submittedAt).toBe('2026-03-14T00:00:00.000Z');
    expect(payload.jobPath).toBe(SAFE_JOB_PATH);
    expect(payload.eventsPath).toBe(SAFE_EVENTS_PATH);
    expect(payload.notifyFile).toMatch(/notify\.ndjson$/);
  });

  it('passes stdin-only prompt via prompt field, not argv (#178)', async () => {
    readStdinMock.mockReturnValueOnce('stdin-only prompt');
    buildPromptMock.mockReturnValueOnce('stdin-only prompt');

    const { askCommand } = await import('../src/commands/ask.js');
    const run = askCommand.run;
    if (run === undefined) {
      throw new Error('askCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        prompt: undefined,
        model: 'Pro',
        quiet: false,
        verbose: false,
        stream: false,
        dryRun: false,
        format: 'json',
        continue: false,
        agent: false,
        detach: true,
      } as never,
      rawArgs: [],
      cmd: askCommand,
    });

    expect(submitDetachedJobMock).toHaveBeenCalledOnce();
    const request = submitDetachedJobMock.mock.calls[0]?.[0] as DetachedJobRequest | undefined;
    expect(request).toBeDefined();
    if (request === undefined) {
      throw new Error('Detached ask request was not captured');
    }
    // Prompt must be in the prompt field, not in argv (avoids ps exposure)
    expect(request.prompt).toBe('stdin-only prompt');
    expect(request.argv).not.toContain('--');
    expect(request.argv).not.toContain('stdin-only prompt');
  });

  it('defaults to detach when no --detach or --sync flag is given', async () => {
    const { askCommand } = await import('../src/commands/ask.js');
    const run = askCommand.run;
    if (run === undefined) {
      throw new Error('askCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        prompt: 'hello',
        model: 'Pro',
        quiet: false,
        verbose: false,
        stream: false,
        dryRun: false,
        format: 'json',
        continue: false,
        agent: false,
      } as never,
      rawArgs: [],
      cmd: askCommand,
    });

    // Default (no --detach, no --sync) should submit a detached job
    expect(submitDetachedJobMock).toHaveBeenCalledOnce();
    expect(failValidationMock).not.toHaveBeenCalled();
  });

  it('routes detached submit failures through failStructured', async () => {
    submitDetachedJobMock.mockRejectedValueOnce(new Error('runner startup failed'));
    const { askCommand } = await import('../src/commands/ask.js');
    const run = askCommand.run;
    if (run === undefined) {
      throw new Error('askCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        prompt: 'hello',
        model: 'Pro',
        quiet: false,
        verbose: false,
        stream: false,
        dryRun: false,
        format: 'json',
        continue: false,
        agent: false,
        detach: true,
      } as never,
      rawArgs: [],
      cmd: askCommand,
    });

    expect(failStructuredMock).toHaveBeenCalledWith(expect.any(Error), 'json');
    expect(jsonRawMock).not.toHaveBeenCalled();
  });

  it('--stream auto-implies sync (no detach even with --detach)', async () => {
    const { askCommand } = await import('../src/commands/ask.js');
    const run = askCommand.run;
    if (run === undefined) {
      throw new Error('askCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        prompt: 'hello',
        model: 'Pro',
        quiet: false,
        verbose: false,
        stream: true,
        dryRun: false,
        format: 'json',
        continue: false,
        agent: false,
        detach: true,
      } as never,
      rawArgs: [],
      cmd: askCommand,
    });

    // --stream overrides --detach to false; no validation error
    expect(failValidationMock).not.toHaveBeenCalled();
    expect(submitDetachedJobMock).not.toHaveBeenCalled();
  });
});
