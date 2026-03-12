import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, fail, progress } from '../core/output-handler.js';
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
      progress(`[dry-run] Would move conversation ${args.chatId} to project "${args.project}"`, false);
      return;
    }

    await withDriver(quiet, async (driver) => {
      await driver.moveToProject(args.chatId, args.project, quiet);
    }, undefined, { verbose: isVerbose });
  },
});
