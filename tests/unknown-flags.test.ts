import { describe, expect, it } from 'vitest';

import { findUnknownFlag } from '../src/core/cli-args.js';

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
});
