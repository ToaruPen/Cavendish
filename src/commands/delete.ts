import { defineCommand } from 'citty';

import { assertValidChatId } from '../constants/selectors.js';
import { GLOBAL_ARGS } from '../core/cli-args.js';
import { errorMessage, fail, progress } from '../core/output-handler.js';
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
    ...GLOBAL_ARGS,
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const projectName = args.project;

    try {
      assertValidChatId(args.chatId);
    } catch (error: unknown) {
      fail(errorMessage(error));
      return;
    }

    if (args.dryRun === true) {
      const target = projectName !== undefined
        ? `project conversation ${args.chatId} in "${projectName}"`
        : `conversation ${args.chatId}`;
      progress(`[dry-run] Would delete ${target}`, false);
      return;
    }

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
