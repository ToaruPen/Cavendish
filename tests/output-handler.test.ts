import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, progress, text } from '../src/core/output-handler.js';

describe('OutputHandler', () => {
  const writeCalls: string[] = [];
  const errorCalls: string[] = [];

  beforeEach(() => {
    writeCalls.length = 0;
    errorCalls.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writeCalls.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errorCalls.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('json()', () => {
    it('writes structured JSON to stdout', () => {
      json('hello world');

      expect(writeCalls).toHaveLength(1);
      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');

      expect(parsed).toMatchObject({
        content: 'hello world',
        partial: false,
      });
      expect(parsed).toHaveProperty('timestamp');
    });

    it('includes model and partial metadata', () => {
      json('response', { model: 'gpt-4o', partial: true });

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');

      expect(parsed).toMatchObject({
        content: 'response',
        model: 'gpt-4o',
        partial: true,
      });
    });

    it('sets partial to false by default', () => {
      json('test');

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');

      expect(parsed).toMatchObject({ partial: false });
    });
  });

  describe('text()', () => {
    it('writes plain text to stdout', () => {
      text('hello');

      expect(writeCalls).toEqual(['hello\n']);
    });
  });

  describe('progress()', () => {
    it('writes to stderr with prefix', () => {
      progress('connecting...');

      expect(errorCalls).toEqual(['[cavendish] connecting...\n']);
    });

    it('suppresses output when quiet is true', () => {
      progress('connecting...', true);

      expect(errorCalls).toHaveLength(0);
    });
  });
});
