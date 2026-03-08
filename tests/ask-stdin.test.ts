import { describe, expect, it } from 'vitest';

import { buildPrompt } from '../src/commands/ask.js';

describe('buildPrompt()', () => {
  it('returns prompt only when stdinData is empty', () => {
    expect(buildPrompt('explain this', '')).toBe('explain this');
  });

  it('prepends stdinData with blank-line separator when present', () => {
    expect(buildPrompt('explain this', 'hello world')).toBe(
      'hello world\n\nexplain this',
    );
  });

  it('handles multiline stdinData', () => {
    const stdin = 'line1\nline2\nline3';
    expect(buildPrompt('summarize', stdin)).toBe(
      'line1\nline2\nline3\n\nsummarize',
    );
  });

  it('returns stdinData alone when prompt is empty (stdin-only pipe)', () => {
    expect(buildPrompt('', 'piped input')).toBe('piped input');
  });

  it('returns empty string when both prompt and stdinData are empty', () => {
    expect(buildPrompt('', '')).toBe('');
  });
});
