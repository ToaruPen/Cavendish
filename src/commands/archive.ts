import { defineCommand } from 'citty';

import { GLOBAL_ARGS } from '../core/cli-args.js';
import { progress } from '../core/output-handler.js';
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
    const quiet = args.quiet === true;

    if (args.dryRun === true) {
      progress(`[dry-run] Would archive conversation ${args.chatId}`, false);
      return;
    }

    await withDriver(quiet, async (driver) => {
      await driver.archiveConversation(args.chatId, quiet);
    });
  },
});
