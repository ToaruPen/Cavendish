import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, fail, progress } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish archive <chat-id>` — archive a conversation.
 */
const ARCHIVE_ARGS = {
  chatId: {
    type: 'positional' as const,
    description: 'The conversation ID to archive',
    required: true as const,
  },
  ...GLOBAL_ARGS,
};

export const archiveCommand = defineCommand({
  meta: {
    name: 'archive',
    description: 'Archive a conversation by ID',
  },
  args: ARCHIVE_ARGS,
  async run({ args }): Promise<void> {
    if (!rejectUnknownFlags(ARCHIVE_ARGS)) { return; }

    const quiet = args.quiet === true;
    const isVerbose = args.verbose === true;

    try {
      assertValidChatId(args.chatId);
    } catch (error: unknown) {
      fail(errorMessage(error));
      return;
    }

    if (args.dryRun === true) {
      progress(`[dry-run] Would archive conversation ${args.chatId}`, false);
      return;
    }

    await withDriver(quiet, async (driver) => {
      await driver.archiveConversation(args.chatId, quiet);
    }, undefined, { verbose: isVerbose });
  },
});
