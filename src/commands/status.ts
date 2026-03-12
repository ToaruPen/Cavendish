/**
 * `cavendish status` — alias for `cavendish doctor`.
 * Uses the same args and run function as doctor, but with its own meta.name
 * so help/usage output correctly shows "status" instead of "doctor".
 */
import { defineCommand } from 'citty';

import { doctorCommand } from './doctor.js';

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Run diagnostic checks on CLI prerequisites, authentication, and integrations',
  },
  args: doctorCommand.args,
  run: doctorCommand.run,
});
