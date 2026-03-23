import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Verify that the ask command registers a cleanup callback via
 * registerCleanup() and unregisters it in the finally block,
 * mirroring the pattern in withDriver().
 */

/* ---------- shared state ---------- */

let unregisterFns: ReturnType<typeof vi.fn>[];

/* ---------- static mocks ---------- */

vi.mock('../src/core/browser-manager.js', () => ({
  CAVENDISH_DIR: join(process.cwd(), '.tmp-tests', 'cavendish'),
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
    waitForResponse: vi.fn().mockResolvedValue({ text: 'response', completed: true }),
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
  parseUploadTimeout: vi.fn().mockReturnValue(undefined),
}));

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
  validateFormat: vi.fn().mockReturnValue('text'),
  verbose: vi.fn(),
}));

vi.mock('../src/core/process-lock.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock('../src/core/shutdown.js', () => ({
  registerCleanup: vi.fn((_fn: () => void | Promise<void>) => {
    const unregister = vi.fn();
    // unregisterFns is reassigned in beforeEach but the closure reads the
    // module-level variable at call time, so it always sees the latest array.
    unregisterFns.push(unregister);
    return unregister;
  }),
}));

vi.mock('../src/constants/selectors.js', () => ({
  assertValidChatId: vi.fn(),
}));

/* ---------- helpers ---------- */

/** Call askCommand.run() with minimal valid args. */
async function runAsk(): Promise<void> {
  const { askCommand } = await import('../src/commands/ask.js');
  // Cast to satisfy citty's strict ParsedArgs — test mocks handle the actual values
  const args = {
    _: [],
    prompt: 'test prompt',
    model: 'Pro',
    quiet: false,
    verbose: false,
    stream: false,
    dryRun: false,
    format: 'text',
    continue: false,
    agent: false,
    sync: true,
  } as unknown as Parameters<NonNullable<typeof askCommand.run>>[0]['args'];

  const run = askCommand.run;
  if (run === undefined) { throw new Error('askCommand.run is undefined'); }
  await run({ args, rawArgs: [], cmd: askCommand });
}

/* ---------- tests ---------- */

describe('ask command cleanup registration', () => {
  beforeEach(() => {
    unregisterFns = [];
    // clearAllMocks preserves mock implementations (unlike restoreAllMocks)
    // so factory-defined mockReturnValue / mockImplementation survive.
    vi.clearAllMocks();
  });

  it('registers a cleanup callback before acquiring the lock', async () => {
    const { registerCleanup } = await import('../src/core/shutdown.js');
    const { acquireLock } = await import('../src/core/process-lock.js');

    await runAsk();

    expect(registerCleanup).toHaveBeenCalledOnce();
    expect(typeof (registerCleanup as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('function');

    // registerCleanup must be invoked BEFORE acquireLock — reversing the
    // order in ask.ts would leave a window where SIGINT during lock
    // acquisition has no cleanup registered.
    const cleanupOrder = (registerCleanup as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const lockOrder = (acquireLock as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(cleanupOrder).toBeLessThan(lockOrder);
  });

  it('unregisters the cleanup callback in the finally block', async () => {
    await runAsk();

    expect(unregisterFns).toHaveLength(1);
    expect(unregisterFns[0]).toHaveBeenCalledOnce();
  });

  it('unregisters cleanup even when the command throws', async () => {
    const { BrowserManager } = await import('../src/core/browser-manager.js');
    (BrowserManager as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      getPage: vi.fn().mockRejectedValue(new Error('connection failed')),
      closePage: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    await runAsk();

    // failStructured handles the error; unregister should still be called
    expect(unregisterFns).toHaveLength(1);
    expect(unregisterFns[0]).toHaveBeenCalledOnce();
  });

  it('calls closePage BEFORE unregister in the finally block', async () => {
    const callOrder: string[] = [];

    // Override BrowserManager to track closePage call timing
    const { BrowserManager } = await import('../src/core/browser-manager.js');
    (BrowserManager as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      getPage: vi.fn().mockResolvedValue({ url: (): string => 'https://chatgpt.com' }),
      closePage: vi.fn().mockImplementation((): Promise<void> => {
        callOrder.push('closePage');
        return Promise.resolve();
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    // Override registerCleanup to track unregister call timing
    const { registerCleanup } = await import('../src/core/shutdown.js');
    (registerCleanup as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_fn: () => void | Promise<void>) => {
        const unregister = vi.fn((): void => {
          callOrder.push('unregister');
        });
        unregisterFns.push(unregister);
        return unregister;
      },
    );

    await runAsk();

    // ask.ts finally block: try { await closePage() } finally { unregister() }
    // Reversing this order would cause the test to fail.
    expect(callOrder).toEqual(['closePage', 'unregister']);
  });

  it('cleanup callback calls browser.closePage()', async () => {
    const { registerCleanup } = await import('../src/core/shutdown.js');

    // Capture the callback without removing it on unregister
    let capturedCallback: (() => void | Promise<void>) | undefined;
    (registerCleanup as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (fn: () => void | Promise<void>) => {
        capturedCallback = fn;
        return vi.fn();
      },
    );

    const { BrowserManager } = await import('../src/core/browser-manager.js');

    await runAsk();

    expect(capturedCallback).toBeDefined();
    await capturedCallback?.();

    const browserInstance = (BrowserManager as ReturnType<typeof vi.fn>).mock.results[0].value as {
      closePage: ReturnType<typeof vi.fn>;
    };
    expect(browserInstance.closePage).toHaveBeenCalled();
  });
});
