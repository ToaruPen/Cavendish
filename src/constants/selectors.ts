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
  MODEL_SELECTOR_BUTTON: '[data-testid="model-switcher-dropdown-button"]',

  /** Model picker dropdown menu */
  MODEL_MENU: '[role="menu"]',

  /** Individual model option inside the menu */
  MODEL_MENUITEM: '[role="menuitem"]',

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
  COPY_BUTTON: '[data-testid="copy-turn-action-button"]',

  /** Stop button visible while response is streaming */
  STOP_BUTTON: '[data-testid="stop-button"]',

  /** Thinking/reasoning indicator */
  THINKING_INDICATOR: '.agent-turn',

  // ── Thinking effort ────────────────────────────────────────
  /** Container for composer footer action pills (model features) */
  COMPOSER_FOOTER_ACTIONS: '[data-testid="composer-footer-actions"]',

  /** Thinking effort pill button in the composer footer */
  THINKING_EFFORT_PILL: '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',

  /** Menu items inside the thinking effort dropdown */
  THINKING_EFFORT_MENUITEM: '[role="menuitemradio"]',

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
