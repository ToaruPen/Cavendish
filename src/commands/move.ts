import { defineCommand } from 'citty';

import { GLOBAL_ARGS } from '../core/cli-args.js';
import { progress } from '../core/output-handler.js';
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
    ...GLOBAL_ARGS,
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;

    if (args.dryRun === true) {
      progress(`[dry-run] Would move conversation ${args.chatId} to project "${args.project}"`, false);
      return;
    }

    await withDriver(quiet, async (driver) => {
      await driver.moveToProject(args.chatId, args.project, quiet);
    });
  },
});
