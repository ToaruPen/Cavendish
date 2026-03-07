import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CavendishError, EXIT_CODES } from '../src/core/errors.js';
import { emitChunk, emitFinal, emitState, failStructured, json, ndjsonChunk, progress, text } from '../src/core/output-handler.js';

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

    it('includes chatId in metadata when provided', () => {
      json('response', { chatId: '6820abc1-def2-3456-7890-abcdef123456', partial: false });

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');

      expect(parsed).toMatchObject({
        content: 'response',
        chatId: '6820abc1-def2-3456-7890-abcdef123456',
        partial: false,
      });
    });

    it('includes url in metadata when provided', () => {
      json('response', { url: 'https://chatgpt.com/c/abc123', partial: false });

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');

      expect(parsed).toMatchObject({
        content: 'response',
        url: 'https://chatgpt.com/c/abc123',
        partial: false,
      });
    });

    it('includes project in metadata when provided', () => {
      json('response', { project: 'My Project', partial: false });

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');

      expect(parsed).toMatchObject({
        content: 'response',
        project: 'My Project',
        partial: false,
      });
    });

    it('includes all metadata fields together', () => {
      json('response', {
        model: 'gpt-4o',
        chatId: '6820abc1-def2-3456-7890-abcdef123456',
        url: 'https://chatgpt.com/c/6820abc1-def2-3456-7890-abcdef123456',
        project: 'Dev Project',
        partial: true,
        timeoutSec: 120,
      });

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');

      expect(parsed).toMatchObject({
        content: 'response',
        model: 'gpt-4o',
        chatId: '6820abc1-def2-3456-7890-abcdef123456',
        url: 'https://chatgpt.com/c/6820abc1-def2-3456-7890-abcdef123456',
        project: 'Dev Project',
        partial: true,
        timeoutSec: 120,
      });
      expect(parsed).toHaveProperty('timestamp');
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

  describe('ndjsonChunk()', () => {
    it('writes a single JSON line to stdout', () => {
      ndjsonChunk({ type: 'chunk', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' });

      expect(writeCalls).toHaveLength(1);
      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
      expect(parsed).toEqual({
        type: 'chunk',
        content: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
      });
    });

    it('includes optional fields when present', () => {
      ndjsonChunk({
        type: 'final',
        content: 'result',
        timestamp: '2026-01-01T00:00:00.000Z',
        model: 'gpt-4o',
        chatId: 'abc-123',
        partial: false,
      });

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
      expect(parsed).toMatchObject({
        type: 'final',
        content: 'result',
        model: 'gpt-4o',
        chatId: 'abc-123',
        partial: false,
      });
    });
  });

  describe('emitChunk()', () => {
    it('writes a chunk event with auto-generated timestamp', () => {
      emitChunk('partial text');

      expect(writeCalls).toHaveLength(1);
      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
      expect(parsed).toMatchObject({
        type: 'chunk',
        content: 'partial text',
      });
      expect(parsed).toHaveProperty('timestamp');
    });
  });

  describe('emitState()', () => {
    it('writes a state event with state field', () => {
      emitState('researching');

      expect(writeCalls).toHaveLength(1);
      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
      expect(parsed).toMatchObject({
        type: 'state',
        content: '',
        state: 'researching',
      });
    });

    it('includes optional content', () => {
      emitState('generating', 'Processing report...');

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
      expect(parsed).toMatchObject({
        type: 'state',
        content: 'Processing report...',
        state: 'generating',
      });
    });
  });

  describe('emitFinal()', () => {
    it('writes a final event with metadata', () => {
      emitFinal('complete response', { model: 'Pro', chatId: 'chat-1', partial: false, timeoutSec: 120 });

      expect(writeCalls).toHaveLength(1);
      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
      expect(parsed).toMatchObject({
        type: 'final',
        content: 'complete response',
        model: 'Pro',
        chatId: 'chat-1',
        partial: false,
        timeoutSec: 120,
      });
    });

    it('defaults partial to false', () => {
      emitFinal('done');

      const parsed: unknown = JSON.parse(writeCalls[0] ?? '');
      expect(parsed).toMatchObject({
        type: 'final',
        content: 'done',
        partial: false,
      });
    });
  });

  describe('failStructured()', () => {
    afterEach(() => {
      process.exitCode = undefined;
    });

    it('writes JSON error to stderr when format is json', () => {
      const err = new CavendishError('CDP failed', 'cdp_unavailable');
      failStructured(err, 'json');

      expect(errorCalls).toHaveLength(1);
      const parsed: unknown = JSON.parse(errorCalls[0] ?? '');
      expect(parsed).toMatchObject({
        error: true,
        category: 'cdp_unavailable',
        message: 'CDP failed',
        exitCode: EXIT_CODES.cdp_unavailable,
      });
      expect(parsed).toHaveProperty('action');
    });

    it('writes human-readable error to stderr when format is text', () => {
      const err = new CavendishError('Chrome gone', 'chrome_not_found');
      failStructured(err, 'text');

      expect(errorCalls.some((c) => c.includes('Chrome gone'))).toBe(true);
      expect(errorCalls.some((c) => c.includes('Action:'))).toBe(true);
    });

    it('defaults to text output when format is omitted', () => {
      const err = new Error('generic failure');
      failStructured(err);

      expect(errorCalls.some((c) => c.includes('generic failure'))).toBe(true);
      // Should not be valid JSON (it's the text format)
      expect(() => JSON.parse(errorCalls[0] ?? '') as unknown).toThrow();
    });

    it('sets category-specific exit code', () => {
      failStructured(new CavendishError('timeout!', 'timeout'), 'text');
      expect(process.exitCode).toBe(EXIT_CODES.timeout);
    });

    it('classifies raw errors automatically', () => {
      failStructured(new Error('ECONNREFUSED 127.0.0.1:9222'), 'json');

      const parsed: unknown = JSON.parse(errorCalls[0] ?? '');
      expect(parsed).toMatchObject({
        error: true,
        category: 'cdp_unavailable',
      });
      expect(process.exitCode).toBe(EXIT_CODES.cdp_unavailable);
    });

    it('does not write to stdout (errors go to stderr only)', () => {
      failStructured(new Error('test'), 'json');

      expect(writeCalls).toHaveLength(0);
      expect(errorCalls.length).toBeGreaterThan(0);
    });
  });
});
