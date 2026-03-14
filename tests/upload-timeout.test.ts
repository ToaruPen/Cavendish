import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseUploadTimeout } from '../src/core/cli-args.js';

const failValidationMock = vi.fn();

vi.mock('../src/core/output-handler.js', () => ({
  errorMessage: vi.fn((e: unknown): string => (e instanceof Error ? e.message : String(e))),
  failValidation: (...args: unknown[]): undefined => {
    failValidationMock(...args);
    return undefined;
  },
}));

describe('parseUploadTimeout()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined when arg is undefined (no flag provided)', () => {
    expect(parseUploadTimeout(undefined, 'json')).toBeUndefined();
    expect(failValidationMock).not.toHaveBeenCalled();
  });

  it('returns correct ms value for valid seconds input', () => {
    expect(parseUploadTimeout('300', 'json')).toBe(300_000);
    expect(failValidationMock).not.toHaveBeenCalled();
  });

  it('converts fractional seconds correctly', () => {
    expect(parseUploadTimeout('1.5', 'json')).toBe(1500);
    expect(failValidationMock).not.toHaveBeenCalled();
  });

  it('returns null and calls failValidation for non-numeric input', () => {
    expect(parseUploadTimeout('abc', 'text')).toBeNull();
    expect(failValidationMock).toHaveBeenCalledOnce();
    expect(failValidationMock).toHaveBeenCalledWith(
      expect.stringContaining('--upload-timeout must be a positive number'),
      'text',
    );
  });

  it('returns null and calls failValidation for zero', () => {
    expect(parseUploadTimeout('0', 'json')).toBeNull();
    expect(failValidationMock).toHaveBeenCalledOnce();
  });

  it('returns null and calls failValidation for negative value', () => {
    expect(parseUploadTimeout('-10', 'json')).toBeNull();
    expect(failValidationMock).toHaveBeenCalledOnce();
  });
});
