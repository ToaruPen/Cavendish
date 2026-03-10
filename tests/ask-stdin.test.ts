import { describe, expect, it, vi, afterEach } from 'vitest';

import { STDIN_MAX_BYTES, buildPrompt } from '../src/core/cli-args.js';

describe('buildPrompt()', () => {
  it('returns prompt only when stdinData is empty', () => {
    expect(buildPrompt('explain this', '')).toBe('explain this');
  });

  it('prepends stdinData with blank-line separator when present', () => {
    expect(buildPrompt('explain this', 'hello world')).toBe(
      'hello world\n\nexplain this',
    );
  });

  it('handles multiline stdinData', () => {
    const stdin = 'line1\nline2\nline3';
    expect(buildPrompt('summarize', stdin)).toBe(
      'line1\nline2\nline3\n\nsummarize',
    );
  });

  it('returns stdinData alone when prompt is empty (stdin-only pipe)', () => {
    expect(buildPrompt('', 'piped input')).toBe('piped input');
  });

  it('returns empty string when both prompt and stdinData are empty', () => {
    expect(buildPrompt('', '')).toBe('');
  });
});

describe('readStdin() size limit', () => {
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function importWithMockedFs(
    buf: Buffer,
  ): Promise<{ readStdin: () => string }> {
    vi.resetModules();

    vi.doMock('node:fs', async () => {
      const real = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...real,
        fstatSync: (): { isFIFO: () => boolean; isFile: () => boolean } => ({
          isFIFO: (): boolean => true,
          isFile: (): boolean => false,
        }),
        readFileSync: (): Buffer => buf,
      };
    });

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const mod = await import('../src/core/cli-args.js');
    return { readStdin: mod.readStdin };
  }

  it('accepts input within the size limit', async () => {
    const buf = Buffer.alloc(1024, 'a');
    const { readStdin } = await importWithMockedFs(buf);

    const result = readStdin();
    expect(result).toHaveLength(1024);
  });

  it('throws when input exceeds STDIN_MAX_BYTES', async () => {
    const buf = Buffer.alloc(STDIN_MAX_BYTES + 1, 'x');
    const { readStdin } = await importWithMockedFs(buf);

    expect(() => readStdin()).toThrow(/Stdin input exceeds/);
  });

  it('accepts input at exactly the limit', async () => {
    const buf = Buffer.alloc(STDIN_MAX_BYTES, 'y');
    const { readStdin } = await importWithMockedFs(buf);

    const result = readStdin();
    expect(result).toHaveLength(STDIN_MAX_BYTES);
  });
});
