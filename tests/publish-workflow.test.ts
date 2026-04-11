import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('publish workflow', () => {
  it('guards npm publish behind a version availability check', () => {
    const workflow = readFileSync('.github/workflows/publish.yml', 'utf-8');

    expect(workflow).toContain('id: publish_guard');
    expect(workflow).toContain("if: steps.publish_guard.outputs.should_publish == 'true'");
    expect(workflow).toContain('node .github/scripts/check-publish-version.mjs');
  });

  it('runs the dead code check before publishing with ignored npm scripts', () => {
    const workflow = readFileSync('.github/workflows/publish.yml', 'utf-8');

    expect(workflow).toContain('name: Dead code check');
    expect(workflow).toContain('run: npm run deadcode:ci');
    expect(workflow).toContain('run: npm publish --ignore-scripts');

    const deadcodeIndex = workflow.indexOf('run: npm run deadcode:ci');
    const publishIndex = workflow.indexOf('run: npm publish --ignore-scripts');

    expect(deadcodeIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(-1);
    expect(deadcodeIndex).toBeLessThan(publishIndex);
  });

  it('serializes parallel publish runs with a concurrency gate', () => {
    const workflow = readFileSync('.github/workflows/publish.yml', 'utf-8');

    expect(workflow).toContain('group: publish-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: false');
  });
});
