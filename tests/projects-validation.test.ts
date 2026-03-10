import { describe, expect, it } from 'vitest';

import { validateProjectArgs } from '../src/commands/projects.js';

describe('validateProjectArgs', () => {
  it('returns null when no flags are set', () => {
    expect(validateProjectArgs(false, false, undefined)).toBeNull();
  });

  it('returns null for --chats with --name', () => {
    expect(validateProjectArgs(true, false, 'MyProject')).toBeNull();
  });

  it('returns null for --create with --name', () => {
    expect(validateProjectArgs(false, true, 'MyProject')).toBeNull();
  });

  it('rejects --chats and --create together', () => {
    const result = validateProjectArgs(true, true, 'MyProject');
    expect(result).toMatch(/mutually exclusive/);
  });

  it('rejects --chats without --name', () => {
    const result = validateProjectArgs(true, false, undefined);
    expect(result).toMatch(/--chats requires --name/);
  });

  it('rejects --create without --name', () => {
    const result = validateProjectArgs(false, true, undefined);
    expect(result).toMatch(/--create requires --name/);
  });

  it('prioritizes mutual exclusion over missing --name', () => {
    const result = validateProjectArgs(true, true, undefined);
    expect(result).toMatch(/mutually exclusive/);
  });
});
