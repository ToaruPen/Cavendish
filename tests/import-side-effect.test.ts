import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('index.ts import safety', () => {
  it('does not have a "main" field in package.json that would resolve imports to CLI entry', () => {
    // Verify that importing the package by name does not resolve to the CLI
    // entry point. The "main" field was removed so that `import('cavendish')`
    // or `require('cavendish')` does not trigger the CLI.
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(pkg.main).toBeUndefined();
    expect(pkg.exports).toBeUndefined();
    expect(pkg.bin).toBeDefined();
    expect((pkg.bin as Record<string, string>).cavendish).toBe(
      './dist/index.mjs',
    );
  });

  it('importing dist/index.mjs does not trigger CLI side effects', () => {
    const distEntry = resolve('dist/index.mjs');
    if (!existsSync(distEntry)) {
      // Skip when dist/ hasn't been built (CI may run tests before build)
      return;
    }

    // Dynamically import the built module in a subprocess.
    // If the direct-run guard is broken, runMain() would parse argv and
    // potentially call process.exit or produce CLI output.
    const script = [
      `import('${distEntry.replace(/\\/g, '/')}')`,
      `.then(() => console.log('__IMPORT_OK__'))`,
      `.catch(e => { console.error(e); process.exit(1); })`,
    ].join('');

    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 10_000,
      encoding: 'utf-8',
      // Provide no extra argv so argv[1] is '-e', never matching currentFile
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    expect(result.trim()).toBe('__IMPORT_OK__');
  });
});
