import { describe, expect, it } from 'vitest';

import { extractFileArgs, findMissingFile } from '../src/commands/ask.js';

describe('extractFileArgs()', () => {
  it('returns empty array when no --file flags', () => {
    expect(extractFileArgs(['node', 'index.mjs', 'ask', 'hello'])).toEqual([]);
  });

  it('extracts a single --file argument', () => {
    const result = extractFileArgs(['node', 'index.mjs', 'ask', '--file', '/home/user/a.ts', 'hello']);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('/home/user/a.ts');
  });

  it('extracts multiple --file arguments', () => {
    const result = extractFileArgs([
      'node', 'index.mjs', 'ask',
      '--file', '/home/user/a.ts',
      '--file', '/home/user/b.ts',
      'hello',
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('/home/user/a.ts');
    expect(result[1]).toBe('/home/user/b.ts');
  });

  it('ignores --file at end of argv (no value)', () => {
    const result = extractFileArgs(['node', 'index.mjs', 'ask', '--file']);
    expect(result).toEqual([]);
  });

  it('stops parsing at -- (end-of-options)', () => {
    const result = extractFileArgs([
      'node', 'index.mjs', 'ask',
      '--', '--file', '/home/user/a.ts',
    ]);
    expect(result).toEqual([]);
  });

  it('throws when --file value looks like a flag', () => {
    expect(() =>
      extractFileArgs(['node', 'index.mjs', 'ask', '--file', '--quiet']),
    ).toThrow('--file requires a file path');
  });

  it('resolves relative paths to absolute', () => {
    const result = extractFileArgs(['node', 'index.mjs', 'ask', '--file', './src/index.ts']);
    expect(result).toHaveLength(1);
    // Should be an absolute path
    expect(result[0]).toMatch(/^\//);
    expect(result[0]).toContain('src/index.ts');
  });
});

describe('findMissingFile()', () => {
  it('returns undefined when all files exist', () => {
    expect(findMissingFile([__filename])).toBeUndefined();
  });

  it('returns the first missing file path', () => {
    expect(findMissingFile(['/nonexistent/path.ts'])).toBe('/nonexistent/path.ts');
  });

  it('returns undefined for empty array', () => {
    expect(findMissingFile([])).toBeUndefined();
  });
});
