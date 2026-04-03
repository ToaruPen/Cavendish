import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('codex review workflow', () => {
  it('skips the review job for bot actors', () => {
    const workflow = readFileSync('.github/workflows/codex-review.yml', 'utf-8');

    expect(workflow).toContain("if: ${{ !endsWith(github.actor, '[bot]') }}");
  });

  it('does not pass the removed drop-sudo action input', () => {
    const workflow = readFileSync('.github/workflows/codex-review.yml', 'utf-8');

    expect(workflow).not.toContain('drop-sudo: true');
    expect(workflow).toContain('safety-strategy: drop-sudo');
  });
});
