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

  evaluate(): Promise<{ text: string; copyButtonVisible: boolean }> {
    const current = this.sequence[Math.min(this.indexRef.value, this.sequence.length - 1)];
    if (this.indexRef.value < this.sequence.length - 1) {
      this.indexRef.value += 1;
    }
    return Promise.resolve({
      text: current.text,
      copyButtonVisible: current.copyVisible,
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
});
