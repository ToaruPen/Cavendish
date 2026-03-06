import { defineCommand, runMain } from 'citty';

import { archiveCommand } from './commands/archive.js';
import { askCommand } from './commands/ask.js';
import { deleteCommand } from './commands/delete.js';
import { listCommand } from './commands/list.js';
import { moveCommand } from './commands/move.js';
import { projectsCommand } from './commands/projects.js';
import { readCommand } from './commands/read.js';

const main = defineCommand({
  meta: {
    name: 'cavendish',
    version: '0.1.0',
    description:
      'Playwright-based CLI that automates ChatGPT Web UI for coding agents',
  },
  subCommands: {
    archive: archiveCommand,
    ask: askCommand,
    delete: deleteCommand,
    list: listCommand,
    move: moveCommand,
    projects: projectsCommand,
    read: readCommand,
  },
});

void runMain(main);
