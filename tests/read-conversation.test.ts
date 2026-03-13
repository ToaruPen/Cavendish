import { errors } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { SELECTORS } from '../src/constants/selectors.js';
import { ChatGPTDriver } from '../src/core/chatgpt-driver.js';

class WaitLocator {
  private readonly waitImpl: () => Promise<void>;

  constructor(waitImpl: () => Promise<void>) {
    this.waitImpl = waitImpl;
  }

  first(): this {
    return this;
  }

  async waitFor(): Promise<void> {
    await this.waitImpl();
  }
}

describe('ChatGPTDriver.readConversation()', () => {
  it('falls back to broad conversation turns when role selectors time out', async () => {
    const typedSelector = `${SELECTORS.USER_MESSAGE}, ${SELECTORS.ASSISTANT_MESSAGE}`;
    const locator = vi.fn((selector: string) => {
      if (selector === typedSelector) {
        return new WaitLocator(() => Promise.reject(new errors.TimeoutError('waiting for locator')));
      }
      if (selector === SELECTORS.CONVERSATION_TURN) {
        return new WaitLocator(() => Promise.resolve());
      }
      throw new Error(`Unexpected selector: ${selector}`);
    });

    const page = {
      locator,
      evaluate: vi.fn().mockResolvedValue([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ]),
    } as const;

    const driver = new ChatGPTDriver(page as never);
    vi.spyOn(driver, 'navigateToChat').mockResolvedValue(undefined);

    const messages = await driver.readConversation('chat-123', true);

    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    expect(locator).toHaveBeenCalledWith(SELECTORS.CONVERSATION_TURN);
  });

  it('falls back to broad conversation turns when only one typed role is visible', async () => {
    const typedSelector = `${SELECTORS.USER_MESSAGE}, ${SELECTORS.ASSISTANT_MESSAGE}`;
    const locator = vi.fn((selector: string) => {
      if (selector === typedSelector || selector === SELECTORS.USER_MESSAGE) {
        return new WaitLocator(() => Promise.resolve());
      }
      if (selector === SELECTORS.ASSISTANT_MESSAGE) {
        return new WaitLocator(() => Promise.reject(new errors.TimeoutError('assistant missing')));
      }
      if (selector === SELECTORS.CONVERSATION_TURN) {
        return new WaitLocator(() => Promise.resolve());
      }
      throw new Error(`Unexpected selector: ${selector}`);
    });

    const page = {
      locator,
      evaluate: vi.fn().mockResolvedValue([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ]),
    } as const;

    const driver = new ChatGPTDriver(page as never);
    vi.spyOn(driver, 'navigateToChat').mockResolvedValue(undefined);

    const messages = await driver.readConversation('chat-123', true);

    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]);
    expect(locator).toHaveBeenCalledWith(SELECTORS.CONVERSATION_TURN);
  });

  it('prefers the user message bubble text over attachment tile text', async () => {
    const typedSelector = `${SELECTORS.USER_MESSAGE}, ${SELECTORS.ASSISTANT_MESSAGE}`;
    const locator = vi.fn((selector: string) => {
      if (selector === typedSelector) {
        return new WaitLocator(() => Promise.resolve());
      }
      if (selector === SELECTORS.USER_MESSAGE || selector === SELECTORS.ASSISTANT_MESSAGE) {
        return new WaitLocator(() => Promise.resolve());
      }
      throw new Error(`Unexpected selector: ${selector}`);
    });

    const userElement = {
      getAttribute: (name: string): string | null =>
        name === 'data-message-author-role' ? 'user' : null,
      querySelector: (selector: string): { textContent: string } | null =>
        selector === SELECTORS.USER_MESSAGE_BUBBLE_TEXT
          ? { textContent: 'Reply with exactly FILE_OK' }
          : null,
      textContent: 'index.tsTypeScriptReply with exactly FILE_OK',
    };
    const assistantElement = {
      getAttribute: (name: string): string | null =>
        name === 'data-message-author-role' ? 'assistant' : null,
      querySelector: (): null => null,
      textContent: 'FILE_OK',
    };

    const globalWithDocument = globalThis as typeof globalThis & {
      document?: Document;
    };
    const originalDocument = globalWithDocument.document;
    globalWithDocument.document = {
      querySelectorAll: (selector: string): unknown[] => {
        if (selector === typedSelector) {
          return [userElement, assistantElement];
        }
        if (selector === SELECTORS.USER_MESSAGE) {
          return [userElement];
        }
        if (selector === SELECTORS.ASSISTANT_MESSAGE) {
          return [assistantElement];
        }
        if (selector === SELECTORS.CONVERSATION_TURN) {
          return [];
        }
        throw new Error(`Unexpected document selector: ${selector}`);
      },
    } as unknown as Document;

    const page = {
      locator,
      evaluate: vi.fn((fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg))),
    } as const;

    const driver = new ChatGPTDriver(page as never);
    vi.spyOn(driver, 'navigateToChat').mockResolvedValue(undefined);

    try {
      const messages = await driver.readConversation('chat-123', true);

      expect(messages).toEqual([
        { role: 'user', content: 'Reply with exactly FILE_OK' },
        { role: 'assistant', content: 'FILE_OK' },
      ]);
    } finally {
      globalWithDocument.document = originalDocument;
    }
  });

  it('extracts explicit roles from fallback conversation turns', async () => {
    const typedSelector = `${SELECTORS.USER_MESSAGE}, ${SELECTORS.ASSISTANT_MESSAGE}`;
    const locator = vi.fn((selector: string) => {
      if (selector === typedSelector) {
        return new WaitLocator(() => Promise.reject(new errors.TimeoutError('waiting for locator')));
      }
      if (selector === SELECTORS.CONVERSATION_TURN) {
        return new WaitLocator(() => Promise.resolve());
      }
      throw new Error(`Unexpected selector: ${selector}`);
    });

    const fallbackUser = {
      getAttribute: (name: string): string | null => (name === 'data-turn' ? 'user' : null),
      querySelector: (): null => null,
      textContent: 'hello',
    };
    const fallbackAssistant = {
      getAttribute: (name: string): string | null => (name === 'data-turn' ? 'assistant' : null),
      querySelector: (): null => null,
      textContent: 'world',
    };

    const globalWithDocument = globalThis as typeof globalThis & {
      document?: Document;
    };
    const originalDocument = globalWithDocument.document;
    globalWithDocument.document = {
      querySelectorAll: (selector: string): unknown[] => {
        if (
          selector === typedSelector
          || selector === SELECTORS.USER_MESSAGE
          || selector === SELECTORS.ASSISTANT_MESSAGE
        ) {
          return [];
        }
        if (selector === SELECTORS.CONVERSATION_TURN) {
          return [fallbackUser, fallbackAssistant];
        }
        throw new Error(`Unexpected document selector: ${selector}`);
      },
    } as unknown as Document;

    const page = {
      locator,
      evaluate: vi.fn((fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg))),
    } as const;

    const driver = new ChatGPTDriver(page as never);
    vi.spyOn(driver, 'navigateToChat').mockResolvedValue(undefined);

    try {
      const messages = await driver.readConversation('chat-123', true);

      expect(messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ]);
    } finally {
      globalWithDocument.document = originalDocument;
    }
  });
});
