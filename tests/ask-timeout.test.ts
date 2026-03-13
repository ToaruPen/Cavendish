import { beforeEach, describe, expect, it, vi } from 'vitest';

let failStructuredMock: ReturnType<typeof vi.fn>;
let jsonMock: ReturnType<typeof vi.fn>;
let textMock: ReturnType<typeof vi.fn>;

vi.mock('../src/core/browser-manager.js', () => ({
  BrowserManager: vi.fn(() => ({
    getPage: vi.fn().mockResolvedValue({ url: (): string => 'https://chatgpt.com' }),
    closePage: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../src/core/chatgpt-driver.js', () => ({
  ChatGPTDriver: vi.fn(() => ({
    navigateToNewChat: vi.fn().mockResolvedValue(undefined),
    selectModel: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getAssistantMessageCount: vi.fn().mockResolvedValue(0),
    waitForResponse: vi.fn().mockResolvedValue({ text: 'partial text', completed: false }),
    extractChatId: vi.fn().mockReturnValue('abc123'),
    getCurrentUrl: vi.fn().mockReturnValue('https://chatgpt.com/c/abc123'),
  })),
}));

vi.mock('../src/core/cli-args.js', () => ({
  FORMAT_ARG: {},
  GLOBAL_ARGS: {},
  STREAM_ARG: {},
  buildPrompt: vi.fn((prompt: string): string => prompt),
  extractArgsOrFail: vi.fn().mockReturnValue([]),
  readStdin: vi.fn().mockReturnValue(''),
  rejectUnknownFlags: vi.fn().mockReturnValue(true),
  validateFileArgs: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/core/model-config.js', () => ({
  allowedThinkingEfforts: vi.fn().mockReturnValue(undefined),
  supportsGitHub: vi.fn().mockReturnValue(false),
  THINKING_EFFORT_LEVELS: ['light', 'standard', 'extended', 'deep'],
}));

vi.mock('../src/core/output-handler.js', () => {
  failStructuredMock = vi.fn();
  jsonMock = vi.fn();
  textMock = vi.fn();

  return {
    emitChunk: vi.fn(),
    emitFinal: vi.fn(),
    errorMessage: vi.fn((e: unknown): string => (e instanceof Error ? e.message : String(e))),
    failStructured: failStructuredMock,
    failValidation: vi.fn(),
    json: jsonMock,
    progress: vi.fn(),
    text: textMock,
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

async function runAsk(): Promise<void> {
  const { askCommand } = await import('../src/commands/ask.js');
  const args = {
    _: [],
    prompt: 'test prompt',
    model: 'Pro',
    quiet: false,
    verbose: false,
    stream: false,
    dryRun: false,
    format: 'json',
    continue: false,
    agent: false,
  } as unknown as Parameters<NonNullable<typeof askCommand.run>>[0]['args'];

  const run = askCommand.run;
  if (run === undefined) {
    throw new Error('askCommand.run is undefined');
  }
  await run({ args, rawArgs: [], cmd: askCommand });
}

describe('ask timeout classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes incomplete responses through failStructured instead of stdout success output', async () => {
    await runAsk();

    expect(failStructuredMock).toHaveBeenCalledOnce();
    const firstCall = failStructuredMock.mock.calls[0] as [unknown, unknown];
    const error: unknown = firstCall[0];
    const format: unknown = firstCall[1];
    expect(format).toBe('json');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Timed out waiting for a final response');
    expect(jsonMock).not.toHaveBeenCalled();
    expect(textMock).not.toHaveBeenCalled();
  });
});
