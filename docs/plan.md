# ChatGPT CLI 計画書

## 1. 概要

Playwrightを用いてChatGPTのWeb UIを自動操作し、任意のコーディングエージェント（Claude Code, Codex CLI等）からシェルコマンド一つでChatGPT Proモデルへの問い合わせ、ファイル添付レビュー、プロジェクト操作等を行えるCLIツール。

---

## 2. 技術スタック

- **ランタイム**: Node.js（PlaywrightのネイティブがNode.jsであり、TypeScriptとの親和性が高い）
- **ブラウザ自動化**: Playwright（headed モード、専用Chromeプロファイル）
- **言語**: TypeScript
- **パッケージマネージャ**: npm or pnpm
- **配布**: npm パッケージとしてグローバルインストール可能にする

---

## 3. アーキテクチャ

```
┌──────────────────────┐
│  Claude Code / Codex │
│  / その他エージェント  │
└──────────┬───────────┘
           │ shell exec
           ▼
┌──────────────────────┐
│    chatgpt-cli       │
│  (Node.js CLI)       │
│                      │
│  ┌────────────────┐  │
│  │ Command Parser │  │
│  │  (commander)   │  │
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Browser Manager│  │
│  │ (Playwright)   │  │
│  │ - 起動/接続    │  │
│  │ - プロファイル  │  │
│  │   管理         │  │
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ ChatGPT Driver │  │
│  │ - DOM操作      │  │
│  │ - 応答取得     │  │
│  │ - ファイル添付  │  │
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Output Handler │  │
│  │ - stdout出力   │  │
│  │ - JSON/text    │  │
│  └────────────────┘  │
└──────────────────────┘
           │
           ▼ CDP (DevTools Protocol)
┌──────────────────────┐
│  Chrome (headed)     │
│  専用プロファイル      │
│  chatgpt.com         │
└──────────────────────┘
```

---

## 4. コマンド体系

### 4.1 セットアップ系

```bash
# 初回セットアップ: 専用Chromeプロファイルを作成し、手動ログインを促す
chatgpt-cli init

# ログイン状態の確認
chatgpt-cli status
```

### 4.2 メッセージ送信系（中核機能）

```bash
# 基本的な問い合わせ
chatgpt-cli ask "質問テキスト"

# モデル指定
chatgpt-cli ask --model pro "質問テキスト"
chatgpt-cli ask --model auto "質問テキスト"

# ファイル添付
chatgpt-cli ask --file ./src/main.ts "このコードをレビューしてください"
chatgpt-cli ask --file ./a.ts --file ./b.ts "この2つのファイルを比較してください"

# 標準入力からの読み取り
cat error.log | chatgpt-cli ask "このエラーを分析してください"

# プロジェクト内で実行
chatgpt-cli ask --project "For-Agents" "プロジェクトの方針を教えてください"

# 既存チャットに追加メッセージ
chatgpt-cli ask --continue "続きを詳しく説明してください"
```

### 4.3 チャット管理系

```bash
# チャット一覧
chatgpt-cli list

# チャット削除
chatgpt-cli delete <chat-id>

# 新規チャット作成（メッセージ送信なし）
chatgpt-cli new --model pro
```

### 4.4 プロジェクト系

```bash
# プロジェクト一覧
chatgpt-cli projects

# プロジェクト内のチャット一覧
chatgpt-cli projects --name "For-Agents" --chats
```

### 4.5 出力オプション（全コマンド共通）

```bash
# 出力形式
--format text     # デフォルト: プレーンテキスト
--format json     # 構造化出力（メタデータ含む）
--format markdown # Markdown形式

# タイムアウト
--timeout 120     # 秒数指定（デフォルト: 120秒）

# 静かモード（進捗表示なし）
--quiet
```

---

## 5. モジュール設計

### 5.1 BrowserManager

責務：Chromeの起動・接続・プロファイル管理

- `launch()`: 専用プロファイルでChromeをheadedモードで起動
- `isRunning()`: 既にChromeが起動しているか確認
- `connect()`: 起動済みChromeにCDP経由で接続
- `getPage()`: ChatGPTのタブを取得、なければ新規作成
- `close()`: ブラウザを終了

設計方針：CLIの呼び出しごとにChromeを起動・終了するとオーバーヘッドが大きいため、初回起動後はChromeプロセスを常駐させ、以降は `connect()` で接続する。一定時間アクセスがなければ自動終了するタイマーを設ける。

### 5.2 ChatGPTDriver

責務：ChatGPTのDOM操作全般

- `navigateToNewChat()`: 新規チャット画面に遷移
- `navigateToProject(name)`: プロジェクトページに遷移
- `selectModel(model)`: モデルセレクターで指定モデルを選択
- `attachFiles(paths)`: DataTransfer APIでファイルを添付
- `sendMessage(text)`: メッセージ入力・送信
- `waitForResponse(timeout)`: 応答完了をポーリングで待機
- `getLastResponse()`: 最新のアシスタント応答を取得
- `getConversationList()`: サイドバーからチャット一覧を取得
- `deleteConversation(id)`: チャットを削除

すべての操作はセレクタベースで行い、スクリーンショットは使用しない。

### 5.3 OutputHandler

責務：結果の整形と出力

- `text(response)`: プレーンテキストとしてstdoutに出力
- `json(response)`: メタデータ（モデル名、思考時間、トークン数等）含む構造化出力
- `markdown(response)`: Markdown形式出力

### 5.4 ConfigManager

責務：設定ファイルの管理

- 保存先: `~/.chatgpt-cli/config.json`
- Chromeプロファイル: `~/.chatgpt-cli/chrome-profile/`
- 設定項目：デフォルトモデル、タイムアウト、出力形式等

---

## 6. 重要セレクタ定義（検証済み）

今回の検証で確認したセレクタをCLIに組み込む。ChatGPTのUI更新で変更される可能性があるため、セレクタは定数ファイルに集約し、変更時の修正を容易にする。

```typescript
// selectors.ts
export const SELECTORS = {
  // 入力欄
  PROMPT_INPUT: '#prompt-textarea',
  
  // モデル選択
  MODEL_SELECTOR_BUTTON: 'button:has-text("モデル セレクター")', // aria-label含む
  MODEL_MENU: 'menu',                     // ドロップダウンメニュー
  MODEL_MENUITEM: 'menuitem',             // 各モデル項目
  
  // 送信ボタン
  SUBMIT_BUTTON: '.composer-submit-button-color',
  
  // ファイル添付
  FILE_INPUT_GENERIC: 'input[type="file"]:not([id])',
  FILE_ADD_BUTTON: '[data-testid="composer-plus-btn"]',
  
  // 応答
  ASSISTANT_MESSAGE: '[data-message-author-role="assistant"]',
  USER_MESSAGE: '[data-message-author-role="user"]',
  
  // 応答完了検知
  COPY_BUTTON: '[aria-label="コピーする"]',
  THINKING_INDICATOR: '.agent-turn',
  
  // チャット管理
  CONVERSATION_LINK: 'a[href^="/c/"]',
  NEW_CHAT_LINK: 'a[href="/"]',
  
  // プロジェクト
  PROJECT_LINK: 'a[href*="/project"]',
};
```

---

## 7. エラーハンドリング方針

| エラー種別 | 対処 |
|---|---|
| Chromeが起動できない | エラーメッセージ + `chatgpt-cli init` を案内 |
| ログインセッション切れ | 検知して `chatgpt-cli init` でのログインを案内 |
| Cloudflareチャレンジ発動 | 検知してユーザーに手動解決を案内 |
| 入力欄の空振り | JS確認 → 最大3回リトライ |
| 応答タイムアウト | タイムアウト値と共に部分応答を返す |
| セレクタ変更（UI更新） | エラーログに具体的セレクタを出力し、修正を容易に |

---

## 8. 実装フェーズ

### Phase 1: 最小動作版（MVP）

- `init` コマンド（プロファイル作成＋手動ログイン誘導）
- `status` コマンド（ログイン状態確認）
- `ask` コマンド（テキスト送信＋応答取得、モデル指定）
- テキスト出力のみ

### Phase 2: ファイル操作

- `--file` オプションによるファイル添付
- 標準入力からのパイプ対応
- `--format json` 出力

### Phase 3: チャット・プロジェクト管理

- `list`, `delete`, `new` コマンド
- `projects` コマンド
- `--project`, `--continue` オプション

### Phase 4: 安定化・拡張

- リトライロジックの強化
- Chromeプロセス常駐化とタイマー自動終了
- npm パッケージとしての公開準備
- テストの整備

---

## 9. ディレクトリ構成

```
chatgpt-cli/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # エントリポイント (commander)
│   ├── commands/
│   │   ├── init.ts           # init コマンド
│   │   ├── status.ts         # status コマンド
│   │   ├── ask.ts            # ask コマンド
│   │   ├── list.ts           # list コマンド
│   │   ├── delete.ts         # delete コマンド
│   │   ├── projects.ts       # projects コマンド
│   │   └── new.ts            # new コマンド
│   ├── core/
│   │   ├── browser-manager.ts
│   │   ├── chatgpt-driver.ts
│   │   ├── output-handler.ts
│   │   └── config-manager.ts
│   ├── constants/
│   │   └── selectors.ts      # セレクタ定義
│   └── utils/
│       ├── logger.ts         # 進捗表示
│       └── retry.ts          # リトライユーティリティ
├── tests/
└── README.md
```

---

## 10. 制約事項・リスク

- ChatGPTのUI更新によるセレクタ破壊は避けられないため、セレクタの集約管理と迅速な修正体制が重要
- Proモデルの応答時間は数十秒〜数分と長い。呼び出し元エージェントのタイムアウト設定と整合させる必要がある
- ChatGPTの利用規約上、自動操作がグレーゾーンである可能性を認識しておく必要がある
- Chromeプロセスの常駐はメモリを消費するため、自動終了タイマーの適切な設定が必要

---

## 付録: 検証で確認済みの技術的事実

以下は2026年2月28日時点でのChatGPT Web UIに対する実機検証の結果である。

### DOM構造

- 入力欄: ProseMirror ベースの `contenteditable` div（`#prompt-textarea`）
- モデルセレクター: `button` → `menu` → `menuitem` の標準的なARIA構造
- 送信ボタン: `.composer-submit-button-color` クラス。テキスト入力時に表示
- ファイルinput: `input[type="file"]` が3つ存在。汎用（accept=""）が1つ、画像用が2つ
- 応答メッセージ: `[data-message-author-role="assistant"]` で全取得可能
- 応答完了: フィードバックボタン（コピー、いいね等）の出現で判定可能

### ファイル添付

DataTransfer APIによるJavaScript経由のファイル注入が動作することを確認済み。

```javascript
const fileInput = document.querySelectorAll('input[type="file"]')[0];
const dataTransfer = new DataTransfer();
dataTransfer.items.add(file);
fileInput.files = dataTransfer.files;
fileInput.dispatchEvent(new Event('change', { bubbles: true }));
```

### セキュリティ

- ChatGPTはCloudflare経由（server: cloudflare, cf-ray確認済み）
- Sentinel/Proof of Workチャレンジが毎メッセージ送信時に実行される
- インラインスクリプト内にwebdriver/headless検知コードは確認されなかった
- headed + 専用プロファイル構成であればbot検知リスクは最小

### API エンドポイント（参考）

- 会話: `/backend-api/conversations`, `/backend-api/f/conversation`
- ファイル: `/backend-api/files`, `/backend-api/files/process_upload_stream`
- モデル: `/backend-api/models`
- 認証: `/backend-api/accounts/check/v4-2023-04-27`
- Sentinel: `/backend-api/sentinel/chat-requirements/prepare`, `finalize`, `ping`
