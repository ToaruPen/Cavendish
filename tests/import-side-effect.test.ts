import { readFileSync } from 'node:fs';

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
});
