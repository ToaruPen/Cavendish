import { describe, expect, it, vi } from 'vitest';

import { findUnknownFlag, rejectUnknownFlags } from '../src/core/cli-args.js';

describe('findUnknownFlag', () => {
  const declaredKeys = ['format', 'quiet', 'verbose', 'dryRun', 'thinkingEffort'];

  it('returns undefined when all flags are known', () => {
    const argv = ['node', 'index.mjs', 'ask', '--format', 'json', '--quiet'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('returns the first unknown flag', () => {
    const argv = ['node', 'index.mjs', 'ask', '--bogus', '--format', 'json'];
    expect(findUnknownFlag(argv, declaredKeys)).toBe('--bogus');
  });

  it('recognizes kebab-case variants of camelCase args', () => {
    const argv = ['node', 'index.mjs', 'ask', '--dry-run', '--thinking-effort', 'light'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('stops checking at -- separator', () => {
    const argv = ['node', 'index.mjs', 'ask', '--format', 'json', '--', '--bogus'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('handles --flag=value syntax', () => {
    const argv = ['node', 'index.mjs', 'ask', '--format=json'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('detects unknown flags with --flag=value syntax', () => {
    const argv = ['node', 'index.mjs', 'ask', '--bogus=val'];
    expect(findUnknownFlag(argv, declaredKeys)).toBe('--bogus');
  });

  it('ignores positional arguments (non-flag tokens)', () => {
    const argv = ['node', 'index.mjs', 'ask', 'my prompt', '--format', 'json'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('returns undefined for empty args', () => {
    const argv = ['node', 'index.mjs', 'ask'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('handles misspelled flags (the real-world typo scenario)', () => {
    const argv = ['node', 'index.mjs', 'ask', '--formaat', 'json'];
    expect(findUnknownFlag(argv, declaredKeys)).toBe('--formaat');
  });

  it('detects unknown flag among many known flags', () => {
    const argv = ['node', 'index.mjs', 'ask', '--quiet', '--verbose', '--oops', '--dry-run'];
    expect(findUnknownFlag(argv, declaredKeys)).toBe('--oops');
  });

  it('ignores the subcommand name token', () => {
    const argv = ['node', 'index.mjs', 'deep-research', '--quiet'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('treats string values after known flags as non-flags', () => {
    // "json" doesn't start with "--" so it's skipped automatically
    const argv = ['node', 'index.mjs', 'ask', '--format', 'json', '--quiet'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  // --no-* boolean negation tests
  it('recognizes --no-verbose as a valid flag', () => {
    const argv = ['node', 'index.mjs', 'ask', '--no-verbose'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('recognizes --no-quiet as a valid flag', () => {
    const argv = ['node', 'index.mjs', 'ask', '--no-quiet'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('recognizes --no-dry-run (kebab-case negation)', () => {
    const argv = ['node', 'index.mjs', 'ask', '--no-dry-run'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('recognizes --no-dryRun (camelCase negation)', () => {
    const argv = ['node', 'index.mjs', 'ask', '--no-dryRun'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });

  it('rejects --no-bogus as unknown', () => {
    const argv = ['node', 'index.mjs', 'ask', '--no-bogus'];
    expect(findUnknownFlag(argv, declaredKeys)).toBe('--no-bogus');
  });

  it('handles --no-* with --flag=value syntax', () => {
    // --no-format=json doesn't make practical sense but the flag name
    // should still be recognized as known (citty handles semantics)
    const argv = ['node', 'index.mjs', 'ask', '--no-format=json'];
    expect(findUnknownFlag(argv, declaredKeys)).toBeUndefined();
  });
});

describe('rejectUnknownFlags', () => {
  // rejectUnknownFlags reads process.argv and calls failValidation on error.
  // We stub process.argv and capture stderr output (failValidation writes there).

  it('returns true when all flags are known', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'ask', '--quiet', '--format', 'json'];
      const result = rejectUnknownFlags({ quiet: true, format: 'json', verbose: false, _: [] });
      expect(result).toBe(true);
    } finally {
      process.argv = origArgv;
    }
  });

  it('returns false and sets exitCode for unknown flags', () => {
    const origArgv = process.argv;
    const origExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.argv = ['node', 'index.mjs', 'ask', '--bogus'];
      const result = rejectUnknownFlags({ quiet: false, format: 'json', _: [] });
      expect(result).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv = origArgv;
      process.exitCode = origExitCode;
      stderrSpy.mockRestore();
    }
  });

  it('excludes citty internal _ key from known flags', () => {
    const origArgv = process.argv;
    const origExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // --_ should not be accepted even though '_' is in parsedArgs
      process.argv = ['node', 'index.mjs', 'ask', '--_'];
      const result = rejectUnknownFlags({ quiet: false, _: [] });
      expect(result).toBe(false);
    } finally {
      process.argv = origArgv;
      process.exitCode = origExitCode;
      stderrSpy.mockRestore();
    }
  });

  it('accepts --no-* negation flags for known boolean args', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'ask', '--no-verbose', '--no-dry-run'];
      const result = rejectUnknownFlags({ verbose: false, dryRun: false, _: [] });
      expect(result).toBe(true);
    } finally {
      process.argv = origArgv;
    }
  });
});
