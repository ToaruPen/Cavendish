import { defineCommand } from 'citty';

import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish delete <chat-id>` — delete a conversation.
 */
export const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete a conversation by ID',
  },
  args: {
    chatId: {
      type: 'positional',
      description: 'The conversation ID to delete',
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
      await driver.deleteConversation(args.chatId, quiet);
    });
  },
});
