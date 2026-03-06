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
  /** Sidebar history container (present once the sidebar has rendered) */
  SIDEBAR_HISTORY: '#history',

  /** Links to existing conversations in the sidebar (scoped to #history) */
  CONVERSATION_LINK: '#history a[href^="/c/"]',

  /** New chat button */
  NEW_CHAT_LINK: 'a[href="/"]',

  /** Three-dot menu button on a conversation item (visible on hover) */
  CONVERSATION_MENU_BUTTON: '[data-testid$="-options"]',

  /** Delete option inside the conversation context menu */
  CONVERSATION_DELETE_OPTION: '[data-testid="delete-chat-menu-item"]',

  /** Archive option inside the conversation context menu (no data-testid).
   *  Uses Playwright :has-text() pseudo-selector with locale fallback.
   *  Other locales tracked in #29. */
  CONVERSATION_ARCHIVE_OPTION:
    '[role="menuitem"]:has-text("アーカイブ"), [role="menuitem"]:has-text("Archive")',

  /** Confirm button in the delete-conversation dialog */
  CONVERSATION_DELETE_CONFIRM: '[data-testid="delete-conversation-confirm-button"]',

  // ── Projects ─────────────────────────────────────────────
  /** Links to projects in the sidebar */
  PROJECT_LINK: 'a[href*="/project"]',
} as const;

export type SelectorKey = keyof typeof SELECTORS;

export const CHATGPT_BASE_URL = 'https://chatgpt.com';

/**
 * Build a selector for a specific conversation link by ID.
 * Validates ID format to prevent CSS selector injection.
 */
export function conversationLinkById(id: string): string {
  if (!/^[\w-]+$/.test(id)) {
    throw new Error(`Invalid conversation ID format: "${id}". Only alphanumeric characters, hyphens, and underscores are allowed.`);
  }
  return `#history a[href="/c/${id}"]`;
}
