import { defineCommand } from 'citty';

import type { ConversationMessage } from '../core/chatgpt-driver.js';
import { jsonRaw, text, validateFormat } from '../core/output-handler.js';
import { withDriver } from '../core/with-driver.js';

/**
 * Format conversation messages as human-readable text.
 * Each message is prefixed with its role label.
 */
function formatAsText(messages: readonly ConversationMessage[]): string {
  return messages
    .map((m) => `[${m.role}]\n${m.content}`)
    .join('\n\n');
}

/**
 * `cavendish read <chat-id>` — read messages from an existing conversation.
 */
export const readCommand = defineCommand({
  meta: {
    name: 'read',
    description: 'Read messages from an existing ChatGPT conversation',
  },
  args: {
    chatId: {
      type: 'positional',
      description: 'The conversation ID to read',
      required: true,
    },
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
      const messages = await driver.readConversation(args.chatId, quiet);

      if (format === 'text') {
        text(formatAsText(messages));
      } else {
        jsonRaw(messages);
      }
    });
  },
});
