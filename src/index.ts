import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineCommand, runMain } from 'citty';

import { archiveCommand } from './commands/archive.js';
import { askCommand } from './commands/ask.js';
import { deepResearchCommand } from './commands/deep-research.js';
import { deleteCommand } from './commands/delete.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { moveCommand } from './commands/move.js';
import { projectsCommand } from './commands/projects.js';
import { readCommand } from './commands/read.js';
import { statusCommand } from './commands/status.js';
import { registerSignalHandlers } from './core/shutdown.js';

declare const __VERSION__: string;

const main = defineCommand({
  meta: {
    name: 'cavendish',
    version: __VERSION__,
    description:
      'Playwright-based CLI that automates ChatGPT Web UI for coding agents',
  },
  subCommands: {
    archive: archiveCommand,
    ask: askCommand,
    'deep-research': deepResearchCommand,
    delete: deleteCommand,
    doctor: doctorCommand,
    init: initCommand,
    list: listCommand,
    move: moveCommand,
    projects: projectsCommand,
    read: readCommand,
    status: statusCommand,
  },
});

// Only execute CLI when run directly (not when imported as a module).
// Use realpathSync to resolve symlinks from global npm installs (e.g.
// /usr/local/bin/cavendish → ~/.npm/.../dist/index.mjs).
const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? realpathSync(process.argv[1]) : '';
const isDirectRun = entryFile === currentFile;

if (isDirectRun) {
  registerSignalHandlers();
  void runMain(main);
}
