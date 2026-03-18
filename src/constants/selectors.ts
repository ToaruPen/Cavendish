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

  /** Individual model option (excludes submenu triggers like Legacy models) */
  MODEL_MENUITEM: '[role="menuitem"]:not([data-has-submenu])',

  // ── File attachment ──────────────────────────────────────
  /** Hidden file input for general file uploads (ChatGPT assigns id="upload-files") */
  FILE_INPUT_GENERIC: '#upload-files',

  /** File tile that appears in the composer after a file is attached.
   *  Uses the Tailwind group name which is specific to file tiles. */
  FILE_ATTACHMENT_TILE: '.group\\/file-tile',

  // ── Messages ─────────────────────────────────────────────
  /** All assistant response messages */
  ASSISTANT_MESSAGE: '[data-message-author-role="assistant"]',

  /** All user messages */
  USER_MESSAGE: '[data-message-author-role="user"]',

  /** Text node inside the rendered user message bubble */
  USER_MESSAGE_BUBBLE_TEXT: '.whitespace-pre-wrap',

  /** Any descendant that explicitly exposes a message role */
  MESSAGE_ROLE_NODE: '[data-message-author-role]',

  /** Fallback for rendered conversation turns, matched via data-testid prefix */
  CONVERSATION_TURN: 'main section[data-testid^="conversation-turn"]',

  /** Attachment tile still uploading (live DOM: remove button has cursor-wait) */
  UPLOAD_IN_PROGRESS: '.group\\/file-tile button.cursor-wait',

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

  /** Most-recent conversation link (broad match for both regular and project chats) */
  MOST_RECENT_CONVERSATION_LINK: '#history a[href*="/c/"]',

  /** New chat button */
  NEW_CHAT_LINK: 'a[data-testid="create-new-chat-button"]',

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

  /** Conversation links in the project main content area (href: /g/.../c/{id}) */
  PROJECT_CONVERSATION_LINK: 'main a[href*="/c/"]',

  /** Three-dot menu button on a project conversation item (in main content) */
  PROJECT_CONVERSATION_MENU_BUTTON: '[data-testid="project-conversation-overflow-menu"] button',

  /** "Move to project" option in the conversation context menu */
  CONVERSATION_MOVE_TO_PROJECT_OPTION:
    '[role="menuitem"]:has-text("プロジェクトに移動する"), [role="menuitem"]:has-text("Move to project")',

  /** Project picker item in the move-to-project submenu.
   *  Broad selector — always use with .filter({ hasText }) to scope to the target project.
   *  The submenu has no unique container data-testid to scope against. */
  PROJECT_PICKER_ITEM: '[role="menuitem"]',

  /** Sidebar section toggle for projects (expands/collapses the project list) */
  PROJECT_SECTION_TOGGLE:
    'button:has-text("プロジェクト"), button:has-text("Projects")',

  /** New project button in the sidebar (visible after expanding project section) */
  NEW_PROJECT_BUTTON:
    'button:has-text("プロジェクトを新規作成"), button:has-text("Create new project"), button:has-text("New project")',

  /** Project creation modal container */
  PROJECT_CREATE_MODAL: '[data-testid="modal-new-project-enhanced"]',

  /** Project name input field in the create-project modal (scoped to modal) */
  PROJECT_NAME_INPUT: '[data-testid="modal-new-project-enhanced"] input[type="text"]',

  /** Create project confirm button in the modal (scoped to modal) */
  PROJECT_CREATE_CONFIRM:
    '[data-testid="modal-new-project-enhanced"] button:has-text("プロジェクトを作成する"), [data-testid="modal-new-project-enhanced"] button:has-text("Create project")',

  // ── Composer + menu (submenu navigation) ──────────────────
  /** Plus button that opens the composer attachment/feature menu */
  COMPOSER_PLUS_BUTTON: '[data-testid="composer-plus-btn"]',

  /** Generic menu item — matches both menuitem and menuitemradio (used in composer + menu) */
  MENU_ITEM: '[role="menuitem"], [role="menuitemradio"]',

  // ── Google Drive ──────────────────────────────────────────
  /** Google Picker iframe */
  GDRIVE_PICKER_IFRAME: 'iframe[src*="docs.google.com/picker"]',

  /** Search input inside the Google Picker iframe */
  GDRIVE_PICKER_SEARCH: 'input[type="text"]',

  /** File result items inside the Google Picker iframe */
  GDRIVE_PICKER_RESULT_ITEM: '[role="option"]',

  /** Select button inside the Google Picker iframe (Google Closure Library uses div[role=button]) */
  GDRIVE_PICKER_SELECT_BUTTON:
    '[role="button"]:has-text("選択"), [role="button"]:has-text("Select")',

  // ── Deep Research ──────────────────────────────────────────
  /** Send button that appears after text is entered (shared with DR page) */
  SEND_BUTTON: '[data-testid="send-button"]',

  /** Send button filtered to enabled state (not disabled) */
  SEND_BUTTON_ENABLED: '[data-testid="send-button"]:not([disabled])',

  /** URL substring used to locate the Deep Research iframe */
  DEEP_RESEARCH_FRAME_URL: 'deep_research',

  /** Deep Research app container (present only on /deep-research) */
  DEEP_RESEARCH_APP: '.deep-research-app',

  /** "開始する" button inside DR iframe — starts research after plan display */
  DEEP_RESEARCH_START_BUTTON: 'button:has-text("開始する"), button:has-text("Start research")',

  /** "リサーチを停止" button inside DR iframe — visible during research phase */
  DEEP_RESEARCH_STOP_BUTTON: 'button:has-text("リサーチを停止"), button:has-text("Stop research")',

  /** Root element for extracting DR report text inside the content iframe */
  DEEP_RESEARCH_REPORT_ROOT: 'main',

  /** "更新する" button inside DR iframe — re-runs the same prompt without new input */
  DEEP_RESEARCH_UPDATE_BUTTON: 'button:text-is("更新する"), button:text-is("Update")',

  /** Export button inside DR iframe header (opens export menu) */
  DEEP_RESEARCH_EXPORT_BUTTON:
    'button[aria-label="エクスポートする"], button[aria-label="Export"]',

  /** "コンテンツをコピーする" option in the DR export menu */
  DEEP_RESEARCH_COPY_CONTENT:
    'button:has-text("コンテンツをコピーする"), button:has-text("Copy content")',

  /** "マークダウンにエクスポートする" option in the DR export menu */
  DEEP_RESEARCH_EXPORT_MARKDOWN:
    'button:has-text("マークダウンにエクスポートする"), button:has-text("Export to Markdown")',

  /** "Word にエクスポートする" option in the DR export menu */
  DEEP_RESEARCH_EXPORT_WORD:
    'button:has-text("Word にエクスポートする"), button:has-text("Export to Word")',

  /** "PDF にエクスポートする" option in the DR export menu */
  DEEP_RESEARCH_EXPORT_PDF:
    'button:has-text("PDF にエクスポートする"), button:has-text("Export to PDF")',

  // ── GitHub integration ────────────────────────────────────
  /** GitHub pill button in composer footer (after GitHub is enabled) */
  GITHUB_FOOTER_BUTTON: '[data-testid="composer-footer-actions"] button:has-text("GitHub")',

  /** Repository search input in the GitHub picker popover */
  GITHUB_REPO_SEARCH: 'input[placeholder="リポジトリを検索..."], input[placeholder="Search repositories..."]',

  /** Radix popover content wrapper (used for GitHub repo picker) */
  POPOVER_CONTENT: '[data-radix-popper-content-wrapper]',

  // ── Agent Mode ────────────────────────────────────────────
  /** Agent mode pill button in composer footer (after agent mode is enabled) */
  AGENT_MODE_PILL:
    'button.__composer-pill[aria-label*="エージェント"], button.__composer-pill[aria-label*="Agent"]',

  // ── Auth / Cloudflare detection ────────────────────────────
  /** Cloudflare Turnstile challenge iframe */
  CF_TURNSTILE_IFRAME: 'iframe[src*="challenges.cloudflare.com"]',

  /** Cloudflare challenge form (alternative detection) */
  CF_CHALLENGE_FORM: '#challenge-form',

  /** ChatGPT login button (visible on auth/login pages) */
  LOGIN_BUTTON: '[data-testid="login-button"]',

  // ── Google OAuth login ────────────────────────────────────
  /** "Continue with Google" button on the auth0/OpenID login page (auth.openai.com).
   *  Matches social login buttons with Google branding. */
  CONTINUE_WITH_GOOGLE:
    'button:has-text("Continue with Google"), button:has-text("Google で続行"), a:has-text("Continue with Google"), a:has-text("Google で続行"), [data-provider="google"]',
} as const;

export type SelectorKey = keyof typeof SELECTORS;

/**
 * Bilingual menu labels used with openComposerMenuItem().
 * Each entry is [Japanese, English] for locale-agnostic matching.
 */
export const MENU_LABELS = {
  SHOW_MORE: ['さらに表示', 'Show more'] as const,
  ADD_FROM_GOOGLE_DRIVE: ['Google Drive から追加する', 'Add from Google Drive'] as const,
  GITHUB: ['GitHub'] as const,
  AGENT_MODE: ['エージェントモード', 'Agent mode'] as const,
} as const;

export const CHATGPT_BASE_URL = 'https://chatgpt.com';

/**
 * Validate a conversation/chat ID to prevent CSS selector injection.
 * Throws if the ID contains invalid characters.
 */
export function assertValidChatId(id: string): void {
  if (!/^[\w-]+$/.test(id)) {
    throw new Error(
      `Invalid conversation ID format: "${id}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
    );
  }
}

/**
 * Build a selector for a specific conversation link by ID (sidebar, exact match).
 */
export function conversationLinkById(id: string): string {
  assertValidChatId(id);
  return `#history a[href="/c/${id}"]`;
}

/**
 * Build a selector for a conversation link by ID using ends-with match.
 * Works for both regular (/c/{id}) and project (/g/.../c/{id}) chat URLs in sidebar.
 */
export function conversationLinkByIdBroad(id: string): string {
  assertValidChatId(id);
  return `#history a[href$="/c/${id}"]`;
}

/**
 * Build a selector for a project conversation link by ID in main content area.
 */
export function projectConversationLinkById(id: string): string {
  assertValidChatId(id);
  return `main a[href$="/c/${id}"]`;
}
