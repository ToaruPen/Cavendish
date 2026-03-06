import { defineCommand } from 'citty';

import { outputList, progress, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * `cavendish list` — list conversations from the ChatGPT sidebar.
 */
export const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List conversations from the ChatGPT sidebar',
  },
  args: {
    quiet: {
      type: 'boolean',
      description: 'Suppress stderr progress messages',
    },
    format: {
      type: 'string',
      description: 'Output format: json or text (default: json)',
      default: 'json',
    },
  },
  async run({ args }): Promise<void> {
    const quiet = args.quiet === true;
    const format = validateFormat(args.format);
    if (format === undefined) {return;}

    await withDriver(quiet, async (driver) => {
      progress('Fetching conversation list...', quiet);
      const conversations = await driver.getConversationList();
      progress(`Found ${String(conversations.length)} conversation(s)`, quiet);
      outputList(conversations, format);
    });
  },
});
