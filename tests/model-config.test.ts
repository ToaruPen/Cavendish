import { describe, expect, it } from 'vitest';

import {
  allowedThinkingEfforts,
  EFFORT_LABEL_CANDIDATES,
  MODEL_EFFORT_LEVELS,
  resolveModelCategory,
  supportsGitHub,
  THINKING_EFFORT_LEVELS,
} from '../src/core/model-config.js';

describe('resolveModelCategory()', () => {
  describe('thinking models', () => {
    it('returns "thinking" for exact "Thinking"', () => {
      expect(resolveModelCategory('Thinking')).toBe('thinking');
    });

    it('is case-insensitive', () => {
      expect(resolveModelCategory('THINKING')).toBe('thinking');
      expect(resolveModelCategory('thinking')).toBe('thinking');
    });

    it('matches when "thinking" appears as substring', () => {
      expect(resolveModelCategory('o3-mini-thinking')).toBe('thinking');
      expect(resolveModelCategory('GPT-4-Thinking-Preview')).toBe('thinking');
    });
  });

  describe('pro models', () => {
    it('returns "pro" for exact "Pro"', () => {
      expect(resolveModelCategory('Pro')).toBe('pro');
    });

    it('is case-insensitive', () => {
      expect(resolveModelCategory('PRO')).toBe('pro');
      expect(resolveModelCategory('pro')).toBe('pro');
    });

    it('matches when "pro" appears as substring', () => {
      expect(resolveModelCategory('ChatGPT-Pro')).toBe('pro');
      expect(resolveModelCategory('gpt-4o-pro-mode')).toBe('pro');
    });
  });

  describe('regular models (no thinking effort support)', () => {
    it('returns undefined for "4o"', () => {
      expect(resolveModelCategory('4o')).toBeUndefined();
    });

    it('returns undefined for "gpt-4o"', () => {
      expect(resolveModelCategory('gpt-4o')).toBeUndefined();
    });

    it('returns undefined for "4o-mini"', () => {
      expect(resolveModelCategory('4o-mini')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(resolveModelCategory('')).toBeUndefined();
    });
  });

  describe('priority: "thinking" is checked before "pro"', () => {
    it('returns "thinking" when model contains both "thinking" and "pro"', () => {
      expect(resolveModelCategory('pro-thinking-v2')).toBe('thinking');
    });
  });
});

describe('allowedThinkingEfforts()', () => {
  it('returns all effort levels for thinking models', () => {
    const efforts = allowedThinkingEfforts('Thinking');
    expect(efforts).toEqual(THINKING_EFFORT_LEVELS);
    expect(efforts).toEqual(['light', 'standard', 'extended', 'deep']);
  });

  it('returns restricted levels for pro models', () => {
    const efforts = allowedThinkingEfforts('Pro');
    expect(efforts).toEqual(MODEL_EFFORT_LEVELS.pro);
    expect(efforts).toEqual(['standard', 'extended']);
  });

  it('returns undefined for regular models', () => {
    expect(allowedThinkingEfforts('4o')).toBeUndefined();
    expect(allowedThinkingEfforts('gpt-4o-mini')).toBeUndefined();
  });

  it('returns undefined for empty model string', () => {
    expect(allowedThinkingEfforts('')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(allowedThinkingEfforts('THINKING')).toEqual(THINKING_EFFORT_LEVELS);
    expect(allowedThinkingEfforts('PRO')).toEqual(MODEL_EFFORT_LEVELS.pro);
  });
});

describe('supportsGitHub()', () => {
  it('returns true for thinking models', () => {
    expect(supportsGitHub('Thinking')).toBe(true);
  });

  it('returns true for thinking models (case-insensitive)', () => {
    expect(supportsGitHub('THINKING')).toBe(true);
    expect(supportsGitHub('thinking')).toBe(true);
  });

  it('returns false for pro models', () => {
    expect(supportsGitHub('Pro')).toBe(false);
  });

  it('returns false for regular models', () => {
    expect(supportsGitHub('4o')).toBe(false);
    expect(supportsGitHub('gpt-4o-mini')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(supportsGitHub('')).toBe(false);
  });
});

describe('constants', () => {
  it('THINKING_EFFORT_LEVELS has exactly 4 levels', () => {
    expect(THINKING_EFFORT_LEVELS).toHaveLength(4);
  });

  it('EFFORT_LABEL_CANDIDATES covers all effort levels', () => {
    for (const level of THINKING_EFFORT_LEVELS) {
      expect(EFFORT_LABEL_CANDIDATES[level]).toBeDefined();
      expect(EFFORT_LABEL_CANDIDATES[level].length).toBeGreaterThan(0);
    }
  });

  it('EFFORT_LABEL_CANDIDATES includes both Japanese and English labels', () => {
    // Each level should have at least 2 candidates (JP + EN)
    for (const level of THINKING_EFFORT_LEVELS) {
      expect(EFFORT_LABEL_CANDIDATES[level].length).toBeGreaterThanOrEqual(2);
    }
  });

  it('MODEL_EFFORT_LEVELS.thinking includes all levels', () => {
    expect(MODEL_EFFORT_LEVELS.thinking).toEqual(THINKING_EFFORT_LEVELS);
  });

  it('MODEL_EFFORT_LEVELS.pro is a subset of thinking levels', () => {
    for (const level of MODEL_EFFORT_LEVELS.pro) {
      expect(THINKING_EFFORT_LEVELS).toContain(level);
    }
  });
});
