import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractFileArgs, extractRepeatableArgs, findMissingFile } from '../src/core/cli-args.js';

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

  it('throws when --file is at end of argv (no value)', () => {
    expect(() =>
      extractFileArgs(['node', 'index.mjs', 'ask', '--file']),
    ).toThrow('--file requires a value');
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
    ).toThrow('--file requires a value');
  });

  it('extracts --file= (equals) form', () => {
    const result = extractFileArgs(['node', 'index.mjs', 'ask', '--file=/home/user/a.ts', 'hello']);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('/home/user/a.ts');
  });

  it('throws when --file= has empty value', () => {
    expect(() =>
      extractFileArgs(['node', 'index.mjs', 'ask', '--file=']),
    ).toThrow('--file requires a value');
  });

  it('resolves relative paths to absolute', () => {
    const result = extractFileArgs(['node', 'index.mjs', 'ask', '--file', './src/index.ts']);
    expect(result).toHaveLength(1);
    expect(isAbsolute(result[0])).toBe(true);
    expect(result[0]).toContain('src/index.ts');
  });
});

describe('extractRepeatableArgs() with non-file flags', () => {
  it('extracts multiple --gdrive arguments without path resolution', () => {
    const result = extractRepeatableArgs(
      ['node', 'index.mjs', 'ask', '--gdrive', 'report.pdf', '--gdrive', 'data.csv', 'hello'],
      'gdrive',
    );
    expect(result).toEqual(['report.pdf', 'data.csv']);
  });

  it('extracts --github arguments without path resolution', () => {
    const result = extractRepeatableArgs(
      ['node', 'index.mjs', 'ask', '--github', 'owner/repo', 'hello'],
      'github',
    );
    expect(result).toEqual(['owner/repo']);
  });

  it('error messages include the correct flag name', () => {
    expect(() =>
      extractRepeatableArgs(['node', 'index.mjs', 'ask', '--gdrive'], 'gdrive'),
    ).toThrow('--gdrive requires a value');
  });

  it('rejects empty string values in space-separated form', () => {
    expect(() =>
      extractRepeatableArgs(['node', 'index.mjs', 'ask', '--github', ''], 'github'),
    ).toThrow('--github requires a value');
  });

  it('does not resolve paths when resolvePaths is false', () => {
    const result = extractRepeatableArgs(
      ['node', 'index.mjs', 'ask', '--gdrive', './relative/file.txt'],
      'gdrive',
      false,
    );
    expect(result).toEqual(['./relative/file.txt']);
  });
});

describe('findMissingFile()', () => {
  it('returns undefined when all files exist', () => {
    const thisFile = fileURLToPath(import.meta.url);
    expect(findMissingFile([thisFile])).toBeUndefined();
  });

  it('returns the first missing file path', () => {
    expect(findMissingFile(['/nonexistent/path.ts'])).toBe('/nonexistent/path.ts');
  });

  it('returns undefined for empty array', () => {
    expect(findMissingFile([])).toBeUndefined();
  });

  it('rejects directories', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    expect(findMissingFile([dir])).toBe(dir);
  });
});
