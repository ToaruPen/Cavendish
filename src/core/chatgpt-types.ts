/**
 * Shared type definitions for the ChatGPT driver and its sub-modules.
 */

export type DeepResearchExportFormat = 'markdown' | 'word' | 'pdf';

export interface ConversationItem {
  id: string;
  title: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  href: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface WaitForResponseOptions {
  /** Timeout in milliseconds (default: 2_400_000). */
  timeout?: number;
  /** Fail if response activity stops for longer than this after it starts. */
  stallTimeoutMs?: number;
  /** Stable-text fallback used when the stop button never appears. */
  settleDelayMs?: number;
  /** Called with cumulative response text as it streams in. */
  onChunk?: (text: string) => void;
  /** Suppress stderr progress messages. */
  quiet?: boolean;
  /** Assistant message count captured BEFORE sendMessage to avoid race conditions. */
  initialMsgCount: number;
  /** Last assistant response text captured before sending a follow-up. */
  initialResponseText?: string;
  /** Label prefix for progress messages (e.g. 'Deep Research'). Defaults to 'Response'. */
  label?: string;
}

export interface WaitForResponseResult {
  text: string;
  completed: boolean;
}
