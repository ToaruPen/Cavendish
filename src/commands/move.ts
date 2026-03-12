import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { GLOBAL_ARGS, rejectUnknownFlags } from '../core/cli-args.js';
import { errorMessage, fail, progress } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish move <chat-id> --project "Name"` — move a conversation to a project.
 */
const MOVE_ARGS = {
  chatId: {
    type: 'positional' as const,
    description: 'The conversation ID to move',
    required: true as const,
  },
  project: {
    type: 'string' as const,
    description: 'Target project name',
    required: true as const,
  },
  ...GLOBAL_ARGS,
};

export const moveCommand = defineCommand({
  meta: {
    name: 'move',
    description: 'Move a conversation to a project',
  },
  args: MOVE_ARGS,
  async run({ args }): Promise<void> {
    if (!rejectUnknownFlags(MOVE_ARGS)) { return; }

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
