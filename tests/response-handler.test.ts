import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SELECTORS } from '../src/constants/selectors.js';

vi.mock('../src/core/driver/helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/driver/helpers.js')>();
  return {
    ...original,
    delay: vi.fn(() => Promise.resolve()),
  };
});

interface Snapshot {
  text: string;
  count: number;
  stopVisible: boolean;
  copyVisible: boolean;
  thinkingText?: string;
}

class FakeCountLocator {
  private readonly sequence: Snapshot[];
  private readonly indexRef: { value: number };

  constructor(
    sequence: Snapshot[],
    indexRef: { value: number },
  ) {
    this.sequence = sequence;
    this.indexRef = indexRef;
  }

  count(): Promise<number> {
    return Promise.resolve(this.current.count);
  }

  isVisible(): Promise<boolean> {
    return Promise.resolve(this.current.stopVisible);
  }

  private get current(): Snapshot {
    return this.sequence[Math.min(this.indexRef.value, this.sequence.length - 1)];
  }
}

class FakePage {
  private readonly sequence: Snapshot[];
  private readonly indexRef = { value: 0 };

  constructor(sequence: Snapshot[]) {
    this.sequence = sequence;
  }

  locator(selector: string): FakeCountLocator {
    if (selector === SELECTORS.ASSISTANT_MESSAGE) {
      return new FakeCountLocator(this.sequence, this.indexRef);
    }
    if (selector === SELECTORS.STOP_BUTTON) {
      return new FakeCountLocator(this.sequence, this.indexRef);
    }
    throw new Error(`Unexpected selector: ${selector}`);
  }

  evaluate(): Promise<{ text: string; copyButtonVisible: boolean; thinkingText: string }> {
    const current = this.sequence[Math.min(this.indexRef.value, this.sequence.length - 1)];
    if (this.indexRef.value < this.sequence.length - 1) {
      this.indexRef.value += 1;
    }
    return Promise.resolve({
      text: current.text,
      copyButtonVisible: current.copyVisible,
      thinkingText: current.thinkingText ?? '',
    });
  }
}

describe('waitForResponse()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes when a copy button appears even if the stop button never shows', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const page = new FakePage([
      { text: '', count: 0, stopVisible: false, copyVisible: false },
      { text: 'Final answer', count: 1, stopVisible: false, copyVisible: false },
      { text: 'Final answer', count: 1, stopVisible: false, copyVisible: true },
    ]) as unknown as Parameters<typeof waitForResponse>[0];

    const result = await waitForResponse(page, {
      timeout: 5_000,
      initialMsgCount: 0,
      quiet: true,
    });

    expect(result).toEqual({
      text: 'Final answer',
      completed: true,
    });
  });

  it('ignores a completed snapshot that matches the pre-send response text', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const page = new FakePage([
      { text: 'Old answer', count: 2, stopVisible: false, copyVisible: true },
      { text: 'New answer', count: 3, stopVisible: true, copyVisible: false },
      { text: 'New answer', count: 3, stopVisible: false, copyVisible: true },
    ]) as unknown as Parameters<typeof waitForResponse>[0];

    const result = await waitForResponse(page, {
      timeout: 5_000,
      initialMsgCount: 2,
      initialResponseText: 'Old answer',
      quiet: true,
    });

    expect(result).toEqual({
      text: 'New answer',
      completed: true,
    });
  });

  it('completes when a repeated follow-up matches the pre-send response text', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const page = new FakePage([
      { text: 'Old answer', count: 2, stopVisible: false, copyVisible: true },
      { text: 'Old answer', count: 3, stopVisible: true, copyVisible: false },
      { text: 'Old answer', count: 3, stopVisible: false, copyVisible: true },
    ]) as unknown as Parameters<typeof waitForResponse>[0];

    const result = await waitForResponse(page, {
      timeout: 5_000,
      initialMsgCount: 2,
      initialResponseText: 'Old answer',
      quiet: true,
    });

    expect(result).toEqual({
      text: 'Old answer',
      completed: true,
    });
  });

  it('completes a same-text follow-up that finishes between polls', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const page = new FakePage([
      { text: 'Old answer', count: 3, stopVisible: false, copyVisible: true },
    ]) as unknown as Parameters<typeof waitForResponse>[0];

    const result = await waitForResponse(page, {
      timeout: 5_000,
      initialMsgCount: 2,
      initialResponseText: 'Old answer',
      quiet: true,
    });

    expect(result).toEqual({
      text: 'Old answer',
      completed: true,
    });
  });

  it('does not complete from stable text alone when no stop or copy button is present', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const now = vi.spyOn(Date, 'now');
    let tick = 0;
    now.mockImplementation(() => {
      tick += 3_000;
      return tick;
    });

    try {
      const page = new FakePage([
        { text: '', count: 0, stopVisible: false, copyVisible: false },
        { text: 'Final answer', count: 1, stopVisible: false, copyVisible: false },
        { text: 'Final answer', count: 1, stopVisible: false, copyVisible: false },
      ]) as unknown as Parameters<typeof waitForResponse>[0];

      await expect(waitForResponse(page, {
        timeout: 30_000,
        stallTimeoutMs: 5_000,
        initialMsgCount: 0,
        quiet: true,
      })).rejects.toThrow('Response stalled');
    } finally {
      now.mockRestore();
    }
  });

  it('surfaces stop-button visibility probe failures with selector context', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const page = {
      locator(selector: string) {
        if (selector === SELECTORS.STOP_BUTTON) {
          return {
            isVisible: () => Promise.reject(new Error('visibility failed')),
          };
        }
        if (selector === SELECTORS.ASSISTANT_MESSAGE) {
          return {
            count: () => Promise.resolve(0),
          };
        }
        throw new Error(`Unexpected selector: ${selector}`);
      },
    } as unknown as Parameters<typeof waitForResponse>[0];

    await expect(waitForResponse(page, {
      timeout: 5_000,
      initialMsgCount: 0,
      quiet: true,
    })).rejects.toThrow(
      `Failed to inspect stop button visibility (selector: ${SELECTORS.STOP_BUTTON}): visibility failed`,
    );
  });

  it('does not stall when thinking text changes despite no assistant message output (#194)', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const now = vi.spyOn(Date, 'now');
    let tick = 0;
    now.mockImplementation(() => {
      tick += 3_000;
      return tick;
    });

    try {
      const page = new FakePage([
        { text: '', count: 0, stopVisible: false, copyVisible: false },
        { text: '', count: 0, stopVisible: true, copyVisible: false, thinkingText: 'Thinking step 1...' },
        { text: '', count: 0, stopVisible: true, copyVisible: false, thinkingText: 'Thinking step 1... step 2...' },
        { text: '', count: 0, stopVisible: true, copyVisible: false, thinkingText: 'Thinking step 1... step 2... step 3...' },
        { text: 'Final answer', count: 1, stopVisible: false, copyVisible: true },
      ]) as unknown as Parameters<typeof waitForResponse>[0];

      const result = await waitForResponse(page, {
        timeout: 60_000,
        stallTimeoutMs: 5_000,
        initialMsgCount: 0,
        quiet: true,
      });

      expect(result).toEqual({
        text: 'Final answer',
        completed: true,
      });
    } finally {
      now.mockRestore();
    }
  });

  it('does not stall when assistant message leads and thinking text changes before stop button (#194)', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const now = vi.spyOn(Date, 'now');
    let tick = 0;
    now.mockImplementation(() => {
      tick += 3_000;
      return tick;
    });

    try {
      const page = new FakePage([
        { text: '', count: 0, stopVisible: false, copyVisible: false },
        { text: 'Partial answer', count: 1, stopVisible: false, copyVisible: false, thinkingText: 'Thinking step 1...' },
        { text: 'Partial answer', count: 1, stopVisible: true, copyVisible: false, thinkingText: 'Thinking step 1... step 2...' },
        { text: 'Partial answer', count: 1, stopVisible: true, copyVisible: false, thinkingText: 'Thinking step 1... step 2... step 3...' },
        { text: 'Final answer', count: 1, stopVisible: false, copyVisible: true },
      ]) as unknown as Parameters<typeof waitForResponse>[0];

      const result = await waitForResponse(page, {
        timeout: 60_000,
        stallTimeoutMs: 5_000,
        initialMsgCount: 0,
        quiet: true,
      });

      expect(result).toEqual({
        text: 'Final answer',
        completed: true,
      });
    } finally {
      now.mockRestore();
    }
  });

  it('times out when activity stalls while the stop button remains visible', async () => {
    const { waitForResponse } = await import('../src/core/driver/response-handler.js');
    const now = vi.spyOn(Date, 'now');
    let tick = 0;
    now.mockImplementation(() => {
      tick += 3_000;
      return tick;
    });

    try {
      const page = new FakePage([
        { text: '', count: 0, stopVisible: false, copyVisible: false },
        { text: 'Thinking...', count: 1, stopVisible: true, copyVisible: false },
        { text: 'Thinking...', count: 1, stopVisible: true, copyVisible: false },
        { text: 'Thinking...', count: 1, stopVisible: true, copyVisible: false },
      ]) as unknown as Parameters<typeof waitForResponse>[0];

      await expect(waitForResponse(page, {
        timeout: 30_000,
        stallTimeoutMs: 5_000,
        initialMsgCount: 0,
        quiet: true,
      })).rejects.toThrow('Response stalled');
    } finally {
      now.mockRestore();
    }
  });
});
