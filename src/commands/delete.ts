import { defineCommand } from 'citty';

import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish delete <chat-id>` — delete a conversation.
 * Use `--project "Name"` to delete a project conversation.
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
    project: {
      type: 'string',
      description: 'Project name (required for project conversations)',
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress stderr progress messages',
    },
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const projectName = args.project;

    await withDriver(quiet, async (driver) => {
      if (projectName !== undefined) {
        await driver.navigateToProject(projectName, quiet);
        await driver.deleteProjectConversation(args.chatId, quiet);
      } else {
        await driver.deleteConversation(args.chatId, quiet);
      }
    });
  },
});
