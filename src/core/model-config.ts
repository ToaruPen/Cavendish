/**
 * Shared model configuration: thinking effort levels, model categories,
 * and validation helpers.
 *
 * Single source of truth — consumed by both ChatGPTDriver and CLI commands.
 */

export type ThinkingEffortLevel = 'light' | 'standard' | 'extended' | 'deep';

type ThinkingModelCategory = 'thinking' | 'pro';

export const THINKING_EFFORT_LEVELS: readonly ThinkingEffortLevel[] = [
  'light', 'standard', 'extended', 'deep',
] as const;

/** Candidate UI labels per effort level (Japanese + English). */
export const EFFORT_LABEL_CANDIDATES: Record<ThinkingEffortLevel, readonly string[]> = {
  light: ['ライト', 'Light'],
  standard: ['標準', 'Standard'],
  extended: ['拡張', 'Extended'],
  deep: ['深い', 'Deep'],
};

/** Valid effort levels per model category. */
export const MODEL_EFFORT_LEVELS: Record<ThinkingModelCategory, readonly ThinkingEffortLevel[]> = {
  thinking: THINKING_EFFORT_LEVELS,
  pro: ['standard', 'extended'],
};

/**
 * Determine the model category for thinking effort validation.
 * Returns undefined if the model does not support thinking effort.
 */
export function resolveModelCategory(model: string): ThinkingModelCategory | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('thinking')) {return 'thinking';}
  if (lower.includes('pro')) {return 'pro';}
  return undefined;
}

/**
 * Return the allowed thinking effort levels for a model, or undefined
 * if the model does not support --thinking-effort at all.
 */
export function allowedThinkingEfforts(model: string): readonly ThinkingEffortLevel[] | undefined {
  const category = resolveModelCategory(model);
  if (category === undefined) {return undefined;}
  return MODEL_EFFORT_LEVELS[category];
}

/**
 * Check whether a model supports GitHub integration in standard chat.
 * Only Thinking (Agent Mode) supports GitHub; Deep Research has its own path.
 */
export function supportsGitHub(model: string): boolean {
  return resolveModelCategory(model) === 'thinking';
}
