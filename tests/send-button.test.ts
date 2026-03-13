import { describe, expect, it } from 'vitest';

import { SELECTORS } from '../src/constants/selectors.js';
import { clickReadySendButton, resolveReadySendButton } from '../src/core/driver/helpers.js';

interface FakeButtonState {
  visible: boolean;
  disabled?: boolean;
  ariaDisabled?: boolean;
  clicked?: boolean;
}

class FakeLocator {
  private readonly states: FakeButtonState[];
  private readonly index: number | undefined;

  constructor(states: FakeButtonState[], index?: number) {
    this.states = states;
    this.index = index;
  }

  count(): Promise<number> {
    return Promise.resolve(this.index === undefined ? this.states.length : 1);
  }

  nth(index: number): FakeLocator {
    return new FakeLocator(this.states, index);
  }

  isVisible(): Promise<boolean> {
    return Promise.resolve(this.current.visible);
  }

  evaluate<T>(fn: (el: Element) => T): Promise<T> {
    const state = this.current;
    const fakeElement = {
      hasAttribute: (name: string): boolean => name === 'disabled' && state.disabled === true,
      getAttribute: (name: string): string | null => {
        if (name === 'aria-disabled') {
          return state.ariaDisabled === true ? 'true' : null;
        }
        return null;
      },
      getBoundingClientRect: (): { width: number; height: number } => ({
        width: state.visible ? 100 : 0,
        height: state.visible ? 40 : 0,
      }),
    } as unknown as Element;

    return Promise.resolve(fn(fakeElement));
  }

  click(): Promise<void> {
    this.current.clicked = true;
    return Promise.resolve();
  }

  private get current(): FakeButtonState {
    if (this.index === undefined) {
      throw new Error('nth() must be called before accessing a concrete button');
    }
    return this.states[this.index];
  }
}

class FakePage {
  private readonly selectors: Record<string, FakeButtonState[]>;

  constructor(selectors: Record<string, FakeButtonState[]>) {
    this.selectors = selectors;
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this.selectors[selector] ?? []);
  }
}

describe('send button helpers', () => {
  it('prefers the enabled data-testid send button when the legacy button is disabled', async () => {
    const page = new FakePage({
      [SELECTORS.SEND_BUTTON]: [{ visible: true }],
      [SELECTORS.SUBMIT_BUTTON]: [{ visible: true, disabled: true }],
    }) as unknown as Parameters<typeof resolveReadySendButton>[0];

    const result = await resolveReadySendButton(page, SELECTORS.SUBMIT_BUTTON);

    expect(result).toEqual({
      selector: SELECTORS.SEND_BUTTON,
      index: 0,
    });
  });

  it('treats aria-disabled buttons as not ready', async () => {
    const page = new FakePage({
      [SELECTORS.SEND_BUTTON]: [{ visible: true, ariaDisabled: true }],
      [SELECTORS.SUBMIT_BUTTON]: [{ visible: true }],
    }) as unknown as Parameters<typeof resolveReadySendButton>[0];

    const result = await resolveReadySendButton(page, SELECTORS.SEND_BUTTON);

    expect(result).toEqual({
      selector: SELECTORS.SUBMIT_BUTTON,
      index: 0,
    });
  });

  it('clicks the resolved ready button', async () => {
    const states: Record<string, FakeButtonState[]> = {
      [SELECTORS.SEND_BUTTON]: [{ visible: true }],
    };
    const page = new FakePage(states) as unknown as Parameters<typeof clickReadySendButton>[0];

    await clickReadySendButton(page, SELECTORS.SUBMIT_BUTTON);

    expect(states[SELECTORS.SEND_BUTTON][0].clicked).toBe(true);
  });
});
