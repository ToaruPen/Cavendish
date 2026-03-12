import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, fail, progress } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish archive <chat-id>` — archive a conversation.
 */
export const archiveCommand = defineCommand({
  meta: {
    name: 'archive',
    description: 'Archive a conversation by ID',
  },
  args: {
    chatId: {
      type: 'positional',
      description: 'The conversation ID to archive',
      required: true,
    },
    ...GLOBAL_ARGS,
  },
  async run({ args }): Promise<void> {
    if (!rejectUnknownFlags(args)) { return; }

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
