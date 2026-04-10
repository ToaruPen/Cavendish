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
}

class FakeModelMenuLocator {
  constructor(private readonly items: FakeModelOption[]) {}

  async waitFor(): Promise<void> {
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
  async click(): Promise<void> {
    return Promise.resolve();
  }

  async waitFor(): Promise<void> {
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

    const driver = new ChatGPTDriver(page as never);
    vi.spyOn(driver, 'waitForReady').mockResolvedValue(undefined);
    vi.spyOn(driver as never, 'waitForModelMenuStable').mockResolvedValue({
      populated: true,
      stabilized: true,
    });

    await driver.selectModel('Pro', true);

    expect(options[2]?.clicked).toBe(true);
  });
});
