import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WithDriverOptions } from '../src/core/with-driver.js';

// Capture withDriver calls
let capturedOptions: WithDriverOptions | undefined;

vi.mock('../src/core/with-driver.js', () => ({
  withDriver: vi.fn(
    (
      _quiet: boolean,
      _action: unknown,
      _format?: string,
      options?: WithDriverOptions,
    ): Promise<void> => {
      capturedOptions = options;
      return Promise.resolve();
    },
  ),
}));

vi.mock('../src/core/cli-args.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/cli-args.js')>();
  return {
    ...original,
    readStdin: vi.fn(() => ''),
    toTimeoutMs: (sec: number): number => sec === 0 ? Number.MAX_SAFE_INTEGER : sec * 1000,
    formatTimeoutDisplay: (sec: number): string => sec === 0 ? 'unlimited' : `${String(sec)}s`,
  };
});

vi.mock('../src/core/output-handler.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/output-handler.js')>();
  return {
    ...original,
    progress: vi.fn(),
    verbose: vi.fn(),
    text: vi.fn(),
    json: vi.fn(),
    emitState: vi.fn(),
    emitFinal: vi.fn(),
    failValidation: vi.fn(),
  };
});

/** Call deepResearchCommand.run() with the given overrides. */
async function runDR(overrides: Record<string, unknown> = {}): Promise<void> {
  const { deepResearchCommand } = await import('../src/commands/deep-research.js');
  // Cast to satisfy citty's strict ParsedArgs — test mocks handle the actual values
  const args = {
    _: [],
    prompt: 'Test query',
    format: 'text',
    timeout: '60',
    sync: true,
    ...overrides,
  } as unknown as Parameters<NonNullable<typeof deepResearchCommand.run>>[0]['args'];

  const run = deepResearchCommand.run;
  if (run === undefined) { throw new Error('deepResearchCommand.run is undefined'); }
  await run({ args, rawArgs: [], cmd: deepResearchCommand });
}

describe('deep-research clipboard permissions', () => {
  beforeEach(() => {
    capturedOptions = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not grant clipboard permissions when --export is not specified', async () => {
    await runDR();

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.permissions).toEqual([]);
  });

  it('grants clipboard permissions when --export is specified', async () => {
    await runDR({ export: 'markdown' });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.permissions).toEqual(['clipboard-read', 'clipboard-write']);
  });

  it('does not call withDriver in dry-run mode (no permissions needed)', async () => {
    const { withDriver } = await import('../src/core/with-driver.js');

    await runDR({ dryRun: true });

    expect(withDriver).not.toHaveBeenCalled();
  });
});
