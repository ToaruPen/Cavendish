import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

let waitForResponseMock: ReturnType<typeof vi.fn>;
let getAssistantMessageCountMock: ReturnType<typeof vi.fn>;

vi.mock('../src/core/browser-manager.js', () => ({
  CAVENDISH_DIR: join(process.cwd(), '.tmp-tests', 'cavendish'),
  BrowserManager: vi.fn(() => ({
    getPage: vi.fn().mockResolvedValue({ url: (): string => 'https://chatgpt.com' }),
    closePage: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../src/core/chatgpt-driver.js', () => {
  waitForResponseMock = vi.fn().mockResolvedValue({ text: 'new response', completed: true });
  getAssistantMessageCountMock = vi.fn()
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(2)
    .mockResolvedValueOnce(2);

  return {
    ChatGPTDriver: vi.fn(() => ({
      navigateToChat: vi.fn().mockResolvedValue(undefined),
      getMostRecentChatId: vi.fn().mockResolvedValue({
        chatId: 'recent-chat-id',
        href: '/c/recent-chat-id',
      }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getAssistantMessageCount: getAssistantMessageCountMock,
      getLastResponse: vi.fn().mockResolvedValue('existing response'),
      waitForResponse: waitForResponseMock,
      extractChatId: vi.fn().mockReturnValue('recent-chat-id'),
      getCurrentUrl: vi.fn().mockReturnValue('https://chatgpt.com/c/recent-chat-id'),
    })),
  };
});

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

vi.mock('../src/core/driver/helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/driver/helpers.js')>();
  return {
    ...original,
    delay: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../src/core/model-config.js', () => ({
  allowedThinkingEfforts: vi.fn().mockReturnValue(undefined),
  supportsGitHub: vi.fn().mockReturnValue(false),
  THINKING_EFFORT_LEVELS: ['light', 'standard', 'extended', 'deep'],
}));

vi.mock('../src/core/output-handler.js', () => ({
  emitChunk: vi.fn(),
  emitFinal: vi.fn(),
  errorMessage: vi.fn((e: unknown): string => (e instanceof Error ? e.message : String(e))),
  failStructured: vi.fn(),
  failValidation: vi.fn(),
  json: vi.fn(),
  progress: vi.fn(),
  text: vi.fn(),
  validateFormat: vi.fn().mockReturnValue('json'),
  verbose: vi.fn(),
}));

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

describe('ask --continue baseline capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for assistant message count to stabilize before waiting for a follow-up response', async () => {
    const { askCommand } = await import('../src/commands/ask.js');
    const run = askCommand.run;
    if (run === undefined) {
      throw new Error('askCommand.run is undefined');
    }

    await run({
      args: {
        _: [],
        prompt: 'follow-up',
        model: 'Pro',
        quiet: false,
        verbose: false,
        stream: false,
        dryRun: false,
        format: 'json',
        continue: true,
        agent: false,
      } as never,
      rawArgs: [],
      cmd: askCommand,
    });

    expect(getAssistantMessageCountMock).toHaveBeenCalledTimes(3);
    expect(waitForResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      initialMsgCount: 2,
    }));
  });
});
