import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { GLOBAL_ARGS, STDIN_ARG, collectChatIds, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, fail, progress } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish archive <id...>` — archive one or more conversations.
 * Use `--stdin` to read IDs from stdin (one per line).
 */
const ARCHIVE_ARGS = {
  chatId: {
    type: 'positional' as const,
    description: 'Conversation ID(s) to archive (supports multiple)',
    required: false as const,
  },
  ...GLOBAL_ARGS,
  ...STDIN_ARG,
};

export const archiveCommand = defineCommand({
  meta: {
    name: 'archive',
    description: 'Archive one or more conversations by ID',
  },
  args: ARCHIVE_ARGS,
  async run({ args }): Promise<void> {
    if (!rejectUnknownFlags(ARCHIVE_ARGS)) { return; }

    const quiet = args.quiet === true;
    const isVerbose = args.verbose === true;

    let ids: string[];
    try {
      ids = collectChatIds('archive', args.stdin === true);
    } catch (error: unknown) {
      fail(errorMessage(error));
      return;
    }

    if (ids.length === 0) {
      fail('No conversation IDs provided. Pass IDs as arguments or use --stdin.');
      return;
    }

    // Validate all IDs before starting
    for (const id of ids) {
      try {
        assertValidChatId(id);
      } catch (error: unknown) {
        fail(errorMessage(error));
        return;
      }
    }

    if (args.dryRun === true) {
      for (let i = 0; i < ids.length; i++) {
        progress(`[dry-run] [${String(i + 1)}/${String(ids.length)}] Would archive conversation ${ids[i]}`, false);
      }
      return;
    }

    await withDriver(quiet, async (driver) => {
      let failed = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const label = `[${String(i + 1)}/${String(ids.length)}]`;
        try {
          progress(`${label} Archiving: ${id}`, quiet);
          await driver.archiveConversation(id, quiet);
        } catch (error: unknown) {
          progress(`${label} Failed to archive ${id}: ${errorMessage(error)}`, false);
          failed++;
        }
      }
      if (ids.length > 1) {
        progress(
          `Completed: ${String(ids.length - failed)}/${String(ids.length)} (${String(failed)} failed)`,
          quiet,
        );
      }
      if (failed > 0) {
        process.exitCode = 1;
      }
    }, undefined, { verbose: isVerbose });
  },
});
