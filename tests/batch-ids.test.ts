import { describe, expect, it } from 'vitest';

import { collectChatIds, extractPositionalIds } from '../src/core/cli-args.js';

describe('extractPositionalIds', () => {
  it('extracts IDs after the subcommand', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'delete', 'id1', 'id2', 'id3'];
      expect(extractPositionalIds('delete')).toEqual(['id1', 'id2', 'id3']);
    } finally {
      process.argv = origArgv;
    }
  });

  it('skips flags and their values', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'delete', 'id1', '--format', 'json', 'id2', '--dry-run'];
      expect(extractPositionalIds('delete')).toEqual(['id1', 'id2']);
    } finally {
      process.argv = origArgv;
    }
  });

  it('skips --project flag with its value', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'delete', 'id1', '--project', 'MyProject', 'id2'];
      expect(extractPositionalIds('delete')).toEqual(['id1', 'id2']);
    } finally {
      process.argv = origArgv;
    }
  });

  it('returns empty when no IDs follow the subcommand', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'delete', '--dry-run'];
      expect(extractPositionalIds('delete')).toEqual([]);
    } finally {
      process.argv = origArgv;
    }
  });

  it('stops at -- separator', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'delete', 'id1', '--', 'id2'];
      expect(extractPositionalIds('delete')).toEqual(['id1']);
    } finally {
      process.argv = origArgv;
    }
  });

  it('returns empty when subcommand is not found', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'ask', 'id1'];
      expect(extractPositionalIds('delete')).toEqual([]);
    } finally {
      process.argv = origArgv;
    }
  });

  it('handles --flag=value syntax for flags with values', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'delete', 'id1', '--format=json', 'id2'];
      expect(extractPositionalIds('delete')).toEqual(['id1', 'id2']);
    } finally {
      process.argv = origArgv;
    }
  });

  it('skips boolean flags without consuming the next token', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'delete', '--quiet', 'id1', '--stdin', 'id2'];
      expect(extractPositionalIds('delete')).toEqual(['id1', 'id2']);
    } finally {
      process.argv = origArgv;
    }
  });
});

describe('collectChatIds', () => {
  it('deduplicates IDs', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'delete', 'id1', 'id2', 'id1'];
      expect(collectChatIds('delete', false)).toEqual(['id1', 'id2']);
    } finally {
      process.argv = origArgv;
    }
  });

  it('collects IDs without stdin when useStdin is false', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'archive', 'aaa', 'bbb'];
      expect(collectChatIds('archive', false)).toEqual(['aaa', 'bbb']);
    } finally {
      process.argv = origArgv;
    }
  });

  it('works with move subcommand and --project flag', () => {
    const origArgv = process.argv;
    try {
      process.argv = ['node', 'index.mjs', 'move', 'id1', 'id2', '--project', 'MyProject'];
      expect(collectChatIds('move', false)).toEqual(['id1', 'id2']);
    } finally {
      process.argv = origArgv;
    }
  });
});
