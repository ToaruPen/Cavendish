import { defineCommand, runMain } from 'citty';

import { askCommand } from './commands/ask.js';

const main = defineCommand({
  meta: {
    name: 'cavendish',
    version: '0.1.0',
    description:
      'Playwright-based CLI that automates ChatGPT Web UI for coding agents',
  },
  subCommands: {
    ask: askCommand,
  },
});

void runMain(main);
