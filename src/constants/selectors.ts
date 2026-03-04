/**
 * ChatGPT DOM selectors.
 *
 * Every CSS selector used to interact with the ChatGPT Web UI
 * MUST be defined here. Never inline selectors in driver code.
 *
 * Verified against chatgpt.com — see docs/plan.md §6.
 */
export const SELECTORS = {
  // ── Input ────────────────────────────────────────────────
  /** ProseMirror-based contenteditable prompt textarea */
  PROMPT_INPUT: '#prompt-textarea',

  /** Composer submit (send) button */
  SUBMIT_BUTTON: '.composer-submit-button-color',

  // ── Model selection ──────────────────────────────────────
  /** Button that opens the model picker dropdown */
  MODEL_SELECTOR_BUTTON: 'button:has-text("モデル セレクター")',

  /** Model picker dropdown menu */
  MODEL_MENU: 'menu',

  /** Individual model option inside the menu */
  MODEL_MENUITEM: 'menuitem',

  // ── File attachment ──────────────────────────────────────
  /** Hidden file input (no id attribute) */
  FILE_INPUT_GENERIC: 'input[type="file"]:not([id])',

  /** Plus button that opens the file attachment menu */
  FILE_ADD_BUTTON: '[data-testid="composer-plus-btn"]',

  // ── Messages ─────────────────────────────────────────────
  /** All assistant response messages */
  ASSISTANT_MESSAGE: '[data-message-author-role="assistant"]',

  /** All user messages */
  USER_MESSAGE: '[data-message-author-role="user"]',

  // ── Response completion ──────────────────────────────────
  /** Copy button that appears when the response is complete */
  COPY_BUTTON: '[aria-label="コピーする"]',

  /** Thinking/reasoning indicator */
  THINKING_INDICATOR: '.agent-turn',

  // ── Chat management ──────────────────────────────────────
  /** Links to existing conversations in the sidebar */
  CONVERSATION_LINK: 'a[href^="/c/"]',

  /** New chat button */
  NEW_CHAT_LINK: 'a[href="/"]',

  // ── Projects ─────────────────────────────────────────────
  /** Links to projects in the sidebar */
  PROJECT_LINK: 'a[href*="/project"]',
} as const;

export type SelectorKey = keyof typeof SELECTORS;
