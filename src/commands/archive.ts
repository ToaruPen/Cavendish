import { defineCommand } from 'citty';

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
    quiet: {
      type: 'boolean',
      description: 'Suppress stderr progress messages',
    },
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;

    await withDriver(quiet, async (driver) => {
      await driver.archiveConversation(args.chatId, quiet);
    });
  },
});
