import { describe, expect, it, vi } from 'vitest';

describe('root command aliases', () => {
  it('registers wait as a top-level alias', async () => {
    vi.stubGlobal('__VERSION__', 'test-version');
    const { main } = await import('../src/index.js');

    expect(main.subCommands).toBeDefined();
    expect(Object.hasOwn(main.subCommands ?? {}, 'wait')).toBe(true);
  });
});
