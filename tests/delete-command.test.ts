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
});
