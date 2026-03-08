import { describe, expect, it } from 'vitest';

import {
  assertValidChatId,
  conversationLinkById,
  conversationLinkByIdBroad,
  projectConversationLinkById,
} from '../src/constants/selectors.js';

describe('assertValidChatId()', () => {
  describe('valid IDs', () => {
    it('accepts a UUID-style ID', () => {
      expect(() => { assertValidChatId('6820abc1-def2-3456-7890-abcdef123456'); }).not.toThrow();
    });

    it('accepts alphanumeric with hyphens', () => {
      expect(() => { assertValidChatId('abc-123-def'); }).not.toThrow();
    });

    it('accepts alphanumeric with underscores', () => {
      expect(() => { assertValidChatId('chat_id_123'); }).not.toThrow();
    });

    it('accepts purely numeric ID', () => {
      expect(() => { assertValidChatId('12345'); }).not.toThrow();
    });

    it('accepts purely alphabetic ID', () => {
      expect(() => { assertValidChatId('abcdef'); }).not.toThrow();
    });

    it('accepts mixed alphanumeric with hyphens and underscores', () => {
      expect(() => { assertValidChatId('a1-b2_c3'); }).not.toThrow();
    });
  });

  describe('invalid IDs', () => {
    it('rejects empty string', () => {
      expect(() => { assertValidChatId(''); }).toThrow('Invalid conversation ID format');
    });

    it('rejects CSS selector injection with brackets', () => {
      expect(() => { assertValidChatId('abc"][onclick="alert(1)'); }).toThrow('Invalid conversation ID format');
    });

    it('rejects IDs with spaces', () => {
      expect(() => { assertValidChatId('abc 123'); }).toThrow('Invalid conversation ID format');
    });

    it('rejects IDs with slashes (path traversal)', () => {
      expect(() => { assertValidChatId('../etc/passwd'); }).toThrow('Invalid conversation ID format');
    });

    it('rejects IDs with angle brackets (HTML injection)', () => {
      expect(() => { assertValidChatId('<script>'); }).toThrow('Invalid conversation ID format');
    });

    it('rejects IDs with semicolons', () => {
      expect(() => { assertValidChatId('abc;def'); }).toThrow('Invalid conversation ID format');
    });

    it('rejects IDs with quotes', () => {
      expect(() => { assertValidChatId('abc"def'); }).toThrow('Invalid conversation ID format');
      expect(() => { assertValidChatId("abc'def"); }).toThrow('Invalid conversation ID format');
    });

    it('rejects IDs with hash symbols', () => {
      expect(() => { assertValidChatId('#history'); }).toThrow('Invalid conversation ID format');
    });

    it('includes the invalid ID in the error message', () => {
      expect(() => { assertValidChatId('bad/id'); }).toThrow('bad/id');
    });
  });
});

describe('conversationLinkById()', () => {
  it('builds an exact sidebar link selector', () => {
    const selector = conversationLinkById('abc-123');
    expect(selector).toBe('#history a[href="/c/abc-123"]');
  });

  it('throws for invalid IDs', () => {
    expect(() => { conversationLinkById('bad/id'); }).toThrow('Invalid conversation ID format');
  });
});

describe('conversationLinkByIdBroad()', () => {
  it('builds an ends-with sidebar link selector', () => {
    const selector = conversationLinkByIdBroad('abc-123');
    expect(selector).toBe('#history a[href$="/c/abc-123"]');
  });

  it('throws for invalid IDs', () => {
    expect(() => { conversationLinkByIdBroad('<script>'); }).toThrow('Invalid conversation ID format');
  });
});

describe('projectConversationLinkById()', () => {
  it('builds a main content area link selector', () => {
    const selector = projectConversationLinkById('abc-123');
    expect(selector).toBe('main a[href$="/c/abc-123"]');
  });

  it('throws for invalid IDs', () => {
    expect(() => { projectConversationLinkById('"; DROP TABLE'); }).toThrow('Invalid conversation ID format');
  });
});
