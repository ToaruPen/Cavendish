import { describe, expect, it } from 'vitest';

import { doctorCommand } from '../src/commands/doctor.js';
import { statusCommand } from '../src/commands/status.js';

/**
 * Extract arg definitions from a citty command.
 * Returns a record of arg name -> { type, description, ... }.
 */
function getArgs(cmd: typeof doctorCommand): Record<string, { type: string }> {
  return (cmd.args ?? {}) as Record<string, { type: string }>;
}

describe('status / doctor command compatibility', () => {
  it('status and doctor accept the same argument names', () => {
    const doctorArgNames = Object.keys(getArgs(doctorCommand)).sort((a, b) => a.localeCompare(b));
    const statusArgNames = Object.keys(getArgs(statusCommand)).sort((a, b) => a.localeCompare(b));

    expect(statusArgNames).toEqual(doctorArgNames);
  });

  it('status and doctor args have the same types', () => {
    const doctorArgs = getArgs(doctorCommand);
    const statusArgs = getArgs(statusCommand);

    for (const key of Object.keys(doctorArgs)) {
      expect(statusArgs[key].type, `arg "${key}" type mismatch`).toBe(doctorArgs[key].type);
    }
  });

  it('both commands use --json (boolean), not --format (string)', () => {
    const doctorArgs = getArgs(doctorCommand);
    const statusArgs = getArgs(statusCommand);

    // --json must exist and be boolean
    expect(doctorArgs).toHaveProperty('json');
    expect(statusArgs).toHaveProperty('json');
    expect(doctorArgs.json.type).toBe('boolean');
    expect(statusArgs.json.type).toBe('boolean');

    // --format must NOT exist (was the old incompatible interface)
    expect(doctorArgs).not.toHaveProperty('format');
    expect(statusArgs).not.toHaveProperty('format');
  });
});
