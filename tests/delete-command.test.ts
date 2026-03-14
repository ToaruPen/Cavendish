import { describe, expect, it, vi } from 'vitest';

import { deleteCommand } from '../src/commands/delete.js';

describe('deleteCommand', () => {
  it('accepts --format json without treating it as an unknown option', async () => {
    const run = deleteCommand.run;
    if (run === undefined) {
      throw new Error('deleteCommand.run is undefined');
    }

    const chatId = '12345678-1234-1234-1234-123456789012';
    const origArgv = process.argv;
    const origExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const args = {
      _: [],
      chatId,
      dryRun: true,
      format: 'json',
      project: undefined,
      quiet: false,
      verbose: false,
      stdin: false,
    } as unknown as Parameters<NonNullable<typeof deleteCommand.run>>[0]['args'];

    try {
      process.argv = ['node', 'index.mjs', 'delete', chatId, '--format', 'json', '--dry-run'];
      process.exitCode = undefined;

      await run({
        args,
        rawArgs: [],
        cmd: deleteCommand,
      });

      expect(process.exitCode).toBeUndefined();
      const stderrOutput = stderrSpy.mock.calls.flat().join('');
      expect(stderrOutput).not.toContain('Unknown option');
    } finally {
      process.argv = origArgv;
      process.exitCode = origExitCode;
      stderrSpy.mockRestore();
    }
  });

  it('shows batch progress in dry-run with multiple IDs', async () => {
    const run = deleteCommand.run;
    if (run === undefined) {
      throw new Error('deleteCommand.run is undefined');
    }

    const id1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const id2 = 'bbbbbbbb-2222-2222-2222-222222222222';
    const origArgv = process.argv;
    const origExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const args = {
      _: [],
      chatId: id1,
      dryRun: true,
      format: 'json',
      project: undefined,
      quiet: false,
      verbose: false,
      stdin: false,
    } as unknown as Parameters<NonNullable<typeof deleteCommand.run>>[0]['args'];

    try {
      process.argv = ['node', 'index.mjs', 'delete', id1, id2, '--format', 'json', '--dry-run'];
      process.exitCode = undefined;

      await run({
        args,
        rawArgs: [],
        cmd: deleteCommand,
      });

      expect(process.exitCode).toBeUndefined();
      const stderrOutput = stderrSpy.mock.calls.flat().join('');
      expect(stderrOutput).toContain('[1/2]');
      expect(stderrOutput).toContain('[2/2]');
      expect(stderrOutput).toContain(id1);
      expect(stderrOutput).toContain(id2);
    } finally {
      process.argv = origArgv;
      process.exitCode = origExitCode;
      stderrSpy.mockRestore();
    }
  });

  it('fails when no IDs are provided', async () => {
    const run = deleteCommand.run;
    if (run === undefined) {
      throw new Error('deleteCommand.run is undefined');
    }

    const origArgv = process.argv;
    const origExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const args = {
      _: [],
      chatId: '',
      dryRun: false,
      format: 'json',
      project: undefined,
      quiet: false,
      verbose: false,
      stdin: false,
    } as unknown as Parameters<NonNullable<typeof deleteCommand.run>>[0]['args'];

    try {
      process.argv = ['node', 'index.mjs', 'delete', '--format', 'json'];
      process.exitCode = undefined;

      await run({
        args,
        rawArgs: [],
        cmd: deleteCommand,
      });

      expect(process.exitCode).toBe(1);
      const stderrOutput = stderrSpy.mock.calls.flat().join('');
      expect(stderrOutput).toContain('No conversation IDs provided');
    } finally {
      process.argv = origArgv;
      process.exitCode = origExitCode;
      stderrSpy.mockRestore();
    }
  });

  it('deduplicates repeated IDs', async () => {
    const run = deleteCommand.run;
    if (run === undefined) {
      throw new Error('deleteCommand.run is undefined');
    }

    const id1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const origArgv = process.argv;
    const origExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const args = {
      _: [],
      chatId: id1,
      dryRun: true,
      format: 'json',
      project: undefined,
      quiet: false,
      verbose: false,
      stdin: false,
    } as unknown as Parameters<NonNullable<typeof deleteCommand.run>>[0]['args'];

    try {
      // Same ID twice
      process.argv = ['node', 'index.mjs', 'delete', id1, id1, '--format', 'json', '--dry-run'];
      process.exitCode = undefined;

      await run({
        args,
        rawArgs: [],
        cmd: deleteCommand,
      });

      expect(process.exitCode).toBeUndefined();
      const stderrOutput = stderrSpy.mock.calls.flat().join('');
      // Should only process once (deduplicated)
      expect(stderrOutput).toContain('[1/1]');
      expect(stderrOutput).not.toContain('[2/');
    } finally {
      process.argv = origArgv;
      process.exitCode = origExitCode;
      stderrSpy.mockRestore();
    }
  });

  it('rejects invalid chat IDs in batch', async () => {
    const run = deleteCommand.run;
    if (run === undefined) {
      throw new Error('deleteCommand.run is undefined');
    }

    const validId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const invalidId = 'bad<script>id';
    const origArgv = process.argv;
    const origExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const args = {
      _: [],
      chatId: validId,
      dryRun: true,
      format: 'json',
      project: undefined,
      quiet: false,
      verbose: false,
      stdin: false,
    } as unknown as Parameters<NonNullable<typeof deleteCommand.run>>[0]['args'];

    try {
      process.argv = ['node', 'index.mjs', 'delete', validId, invalidId, '--format', 'json', '--dry-run'];
      process.exitCode = undefined;

      await run({
        args,
        rawArgs: [],
        cmd: deleteCommand,
      });

      expect(process.exitCode).toBe(1);
      const stderrOutput = stderrSpy.mock.calls.flat().join('');
      expect(stderrOutput).toContain('Invalid conversation ID format');
    } finally {
      process.argv = origArgv;
      process.exitCode = origExitCode;
      stderrSpy.mockRestore();
    }
  });
});
