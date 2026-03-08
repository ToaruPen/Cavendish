import { describe, expect, it } from 'vitest';

import {
  CavendishError,
  EXIT_CODES,
  type ErrorCategory,
  classifyError,
} from '../src/core/errors.js';

describe('CavendishError', () => {
  it('stores category and message', () => {
    const err = new CavendishError('test', 'timeout');
    expect(err.message).toBe('test');
    expect(err.category).toBe('timeout');
    expect(err.name).toBe('CavendishError');
  });

  it('uses default action when none provided', () => {
    const err = new CavendishError('test', 'cdp_unavailable');
    expect(err.action).toContain('Start Chrome');
  });

  it('uses default action for chrome_launch_failed', () => {
    const err = new CavendishError('test', 'chrome_launch_failed');
    expect(err.action).toContain('Check Chrome permissions');
  });

  it('accepts custom action', () => {
    const err = new CavendishError('test', 'timeout', 'custom action');
    expect(err.action).toBe('custom action');
  });

  it('toPayload() returns structured JSON shape', () => {
    const err = new CavendishError('something broke', 'selector_miss');
    const payload = err.toPayload();

    expect(payload).toEqual({
      error: true,
      category: 'selector_miss',
      message: 'something broke',
      exitCode: EXIT_CODES.selector_miss,
      action: expect.any(String) as string,
    });
  });

  it('extends Error', () => {
    const err = new CavendishError('msg', 'unknown');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CavendishError);
  });
});

describe('EXIT_CODES', () => {
  it('assigns unique codes to each category', () => {
    const codes = Object.values(EXIT_CODES);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  it('uses code 1 for unknown', () => {
    expect(EXIT_CODES.unknown).toBe(1);
  });

  it('uses code 8 for chrome_launch_failed', () => {
    expect(EXIT_CODES.chrome_launch_failed).toBe(8);
  });

  it('covers all categories', () => {
    const categories: ErrorCategory[] = [
      'cdp_unavailable',
      'chrome_not_found',
      'chrome_launch_failed',
      'auth_expired',
      'cloudflare_blocked',
      'selector_miss',
      'timeout',
      'unknown',
    ];
    for (const cat of categories) {
      expect(EXIT_CODES[cat]).toBeTypeOf('number');
    }
  });
});

describe('classifyError', () => {
  it('returns CavendishError unchanged', () => {
    const original = new CavendishError('original', 'timeout');
    const result = classifyError(original);
    expect(result).toBe(original);
  });

  it('classifies CDP connection errors', () => {
    const err = new Error('ECONNREFUSED 127.0.0.1:9222');
    expect(classifyError(err).category).toBe('cdp_unavailable');
  });

  it('classifies CDP port errors', () => {
    const err = new Error('Chrome did not respond on port 9222 after 3 attempts');
    expect(classifyError(err).category).toBe('cdp_unavailable');
  });

  it('classifies failed Chrome connection', () => {
    const err = new Error('Failed to connect to Chrome');
    expect(classifyError(err).category).toBe('cdp_unavailable');
  });

  it('classifies Chrome not found errors', () => {
    const err = new Error('Chrome not found. Searched: /usr/bin/google-chrome');
    expect(classifyError(err).category).toBe('chrome_not_found');
  });

  it('classifies Chrome launch failure as chrome_launch_failed', () => {
    const err = new Error('Failed to launch Chrome at "/usr/bin/google-chrome"');
    expect(classifyError(err).category).toBe('chrome_launch_failed');
  });

  it('classifies Chrome binary not found as chrome_not_found', () => {
    const err = new Error('Chrome binary not found at "/usr/bin/google-chrome"');
    expect(classifyError(err).category).toBe('chrome_not_found');
  });

  it('classifies permission denied launching Chrome as chrome_launch_failed', () => {
    const err = new Error('Permission denied launching Chrome at "/usr/bin/google-chrome"');
    expect(classifyError(err).category).toBe('chrome_launch_failed');
  });

  it('classifies auth errors (not logged in)', () => {
    const err = new Error('Not logged in (login page detected)');
    expect(classifyError(err).category).toBe('auth_expired');
  });

  it('classifies auth errors (login required)', () => {
    expect(classifyError(new Error('Login required to access ChatGPT')).category).toBe('auth_expired');
  });

  it('classifies auth errors (session expired)', () => {
    expect(classifyError(new Error('Session expired, please re-authenticate')).category).toBe('auth_expired');
  });

  it('classifies auth errors (/auth/login URL)', () => {
    expect(classifyError(new Error('Redirected to /auth/login')).category).toBe('auth_expired');
  });

  it('does not classify "author-role" as auth error', () => {
    const err = new Error('Unexpected data-testid author-role in DOM');
    expect(classifyError(err).category).not.toBe('auth_expired');
  });

  it('does not classify "authorization header" as auth error', () => {
    const err = new Error('Missing authorization header in request');
    expect(classifyError(err).category).not.toBe('auth_expired');
  });

  it('does not classify "session storage" as auth error', () => {
    const err = new Error('Failed to read session storage key');
    expect(classifyError(err).category).not.toBe('auth_expired');
  });

  it('classifies Cloudflare errors', () => {
    const err = new Error('Cloudflare challenge detected');
    expect(classifyError(err).category).toBe('cloudflare_blocked');
  });

  it('classifies timeout errors', () => {
    const err = new Error('Timeout 30000ms exceeded');
    expect(classifyError(err).category).toBe('timeout');
  });

  it('classifies selector miss errors', () => {
    const err = new Error('Conversation "abc" not found in sidebar');
    expect(classifyError(err).category).toBe('selector_miss');
  });

  it('classifies iframe not found as selector miss', () => {
    const err = new Error('Deep Research iframe not found');
    expect(classifyError(err).category).toBe('selector_miss');
  });

  it('classifies picker not found as selector miss', () => {
    const err = new Error('Project "X" not found in project picker.');
    expect(classifyError(err).category).toBe('selector_miss');
  });

  it('classifies locator waiting as selector miss', () => {
    const err = new Error('Error: waiting for locator("button.submit")');
    expect(classifyError(err).category).toBe('selector_miss');
  });

  it('classifies Playwright locator timeout as selector_miss, not timeout', () => {
    const err = new Error(
      'Timeout 30000ms exceeded. waiting for locator(\'[data-testid="prompt-textarea"]\')',
    );
    expect(classifyError(err).category).toBe('selector_miss');
  });

  it('classifies timeout with "selector" in human text as timeout, not selector_miss', () => {
    const err = new Error(
      'Deep Research start not detected within timeout. Check ChatGPT Pro status or selector changes.',
    );
    expect(classifyError(err).category).toBe('timeout');
  });

  it('falls back to unknown for unrecognized errors', () => {
    const err = new Error('Something completely unexpected');
    expect(classifyError(err).category).toBe('unknown');
  });

  it('handles non-Error values', () => {
    const result = classifyError('string error');
    expect(result).toBeInstanceOf(CavendishError);
    expect(result.message).toBe('string error');
    expect(result.category).toBe('unknown');
  });
});
