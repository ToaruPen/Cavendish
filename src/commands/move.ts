import { defineCommand } from 'citty';

import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish move <chat-id> --project "Name"` — move a conversation to a project.
 */
export const moveCommand = defineCommand({
  meta: {
    name: 'move',
    description: 'Move a conversation to a project',
  },
  args: {
    chatId: {
      type: 'positional',
      description: 'The conversation ID to move',
      required: true,
    },
    project: {
      type: 'string',
      description: 'Target project name',
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
      await driver.moveToProject(args.chatId, args.project, quiet);
    });
  },
});
