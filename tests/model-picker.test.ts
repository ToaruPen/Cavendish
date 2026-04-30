import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { SELECTORS } from '../src/constants/selectors.js';
import { ChatGPTDriver } from '../src/core/chatgpt-driver.js';

interface FakeModelOption {
  text: string;
  clicked: boolean;
}

class FakeModelItemsLocator {
  constructor(private readonly items: FakeModelOption[]) {}

  filter({ hasText }: { hasText: string }): FakeModelItemsLocator {
    return new FakeModelItemsLocator(this.items.filter((item) => item.text.includes(hasText)));
  }

  count(): Promise<number> {
    return Promise.resolve(this.items.length);
  }

  first(): FakeModelItemsLocator {
    return new FakeModelItemsLocator(this.items.slice(0, 1));
  }

  click(): Promise<void> {
    const item = this.items.at(0);
    if (item === undefined) {
      throw new Error('No model item to click');
    }
    item.clicked = true;
    return Promise.resolve();
  }

  evaluateAll<T>(fn: (els: { getAttribute(name: string): string | null; textContent: string }[]) => T): Promise<T> {
    return Promise.resolve(
      fn(
        this.items.map((item, index) => ({
          getAttribute: (name: string): string | null => {
            if (name === 'data-testid') {
              return `model-${String(index)}`;
            }
            return null;
          },
          textContent: item.text,
        })),
      ),
    );
  }
}

class FakeModelMenuLocator {
  constructor(private readonly items: FakeModelOption[]) {}

  waitFor(): Promise<void> {
    return Promise.resolve();
  }

  first(): this {
    return this;
  }

  locator(selector: string): FakeModelItemsLocator {
    if (selector.includes('menuitemradio')) {
      return new FakeModelItemsLocator(this.items);
    }
    return new FakeModelItemsLocator([]);
  }
}

class FakeClickableLocator {
  click(): Promise<void> {
    return Promise.resolve();
  }

  waitFor(): Promise<void> {
    return Promise.resolve();
  }
}

describe('ChatGPTDriver.selectModel()', () => {
  it('selects model picker radio items from the current ChatGPT DOM', async () => {
    const options: FakeModelOption[] = [
      { text: 'Instant', clicked: false },
      { text: 'Thinking', clicked: false },
      { text: 'Pro', clicked: false },
    ];

    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === SELECTORS.PROMPT_INPUT || selector === SELECTORS.MODEL_SELECTOR_BUTTON) {
          return new FakeClickableLocator();
        }
        if (selector === SELECTORS.MODEL_MENU) {
          return new FakeModelMenuLocator(options);
        }
        throw new Error(`Unexpected selector: ${selector}`);
      }),
      keyboard: {
        press: vi.fn().mockResolvedValue(undefined),
      },
    } as const;

    const driver = new ChatGPTDriver(page as unknown as Page);
    vi.spyOn(driver, 'waitForReady').mockResolvedValue(undefined);

    await driver.selectModel('Pro', true);

    expect(options[2]?.clicked).toBe(true);
  });

  it('opens the current composer pill model picker when the legacy data-testid is absent', async () => {
    const options: FakeModelOption[] = [
      { text: 'Instant', clicked: false },
      { text: 'Thinking', clicked: false },
      { text: 'Pro • Extended', clicked: false },
    ];
    const clickedSelectors: string[] = [];

    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === SELECTORS.PROMPT_INPUT) {
          return new FakeClickableLocator();
        }
        if (selector === SELECTORS.MODEL_SELECTOR_BUTTON) {
          return {
            click: () => {
              clickedSelectors.push(selector);
              return Promise.resolve();
            },
          };
        }
        if (selector === SELECTORS.MODEL_MENU) {
          return new FakeModelMenuLocator(options);
        }
        throw new Error(`Unexpected selector: ${selector}`);
      }),
      keyboard: {
        press: vi.fn().mockResolvedValue(undefined),
      },
    } as const;

    const driver = new ChatGPTDriver(page as unknown as Page);
    vi.spyOn(driver, 'waitForReady').mockResolvedValue(undefined);

    await driver.selectModel('Pro', true);

    expect(clickedSelectors).toEqual([SELECTORS.MODEL_SELECTOR_BUTTON]);
    expect(SELECTORS.MODEL_SELECTOR_BUTTON).toContain('__composer-pill');
    expect(options[2]?.clicked).toBe(true);
  });
});
