# Cavendish 計画書

## 1. 概要

Playwrightを用いてChatGPTのWeb UIを自動操作し、任意のコーディングエージェント（Claude Code, Codex CLI等）からシェルコマンド一つでChatGPT Proモデルへの問い合わせ、ファイル添付レビュー、プロジェクト操作、Deep Research等を行えるCLIツール。

---

## 2. 技術スタック

- **ランタイム**: Node.js（PlaywrightのネイティブがNode.jsであり、TypeScriptとの親和性が高い）
- **ブラウザ自動化**: Playwright（headed モード、専用Chromeプロファイル）
- **言語**: TypeScript
- **パッケージマネージャ**: npm
- **CLIフレームワーク**: citty (UnJS)
- **ビルドツール**: tsup
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
│    cavendish         │
│  (Node.js CLI)       │
│                      │
│  ┌────────────────┐  │
│  │ Command Parser │  │
│  │  (citty)       │  │
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Browser Manager│  │
│  │ (Playwright)   │  │
│  │ - spawn/接続   │  │
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
│  │ Error Handler  │  │
│  │ - エラー分類   │  │
│  │ - 終了コード   │  │
│  └───────┬────────┘  │
│          ▼           │
│  ┌────────────────┐  │
│  │ Output Handler │  │
│  │ - stdout出力   │  │
│  │ - JSON/text/   │  │
│  │   NDJSON       │  │
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
# 初回セットアップ
cavendish init

# プロファイルリセット＋再認証
cavendish init --reset

# 統合診断
cavendish doctor
cavendish doctor --json

# ログイン状態の確認
cavendish status
```

### 4.2 メッセージ送信系（中核機能）

```bash
# 基本的な問い合わせ
cavendish ask "質問テキスト"

# モデル指定
cavendish ask --model pro "質問テキスト"
cavendish ask --model auto "質問テキスト"

# ファイル添付
cavendish ask --file ./src/main.ts "このコードをレビューしてください"
cavendish ask --file ./a.ts --file ./b.ts "この2つのファイルを比較してください"

# 標準入力からの読み取り
cat error.log | cavendish ask "このエラーを分析してください"

# プロジェクト内で実行
cavendish ask --project "For-Agents" "プロジェクトの方針を教えてください"

# 既存チャットに追加メッセージ
cavendish ask --continue "続きを詳しく説明してください"

# ストリーミング出力（NDJSON）
cavendish ask --stream "質問テキスト"

# エージェントモード
cavendish ask --agent "問題を解いてください"

# 特定のチャットIDで継続
cavendish ask --continue --chat <chat-id> "続きの質問"

# ドライラン（実行せず引数検証のみ）
cavendish ask --dry-run "質問テキスト"
```

### 4.3 Deep Research

```bash
# Deep Researchクエリ
cavendish deep-research "調査テーマ"

# フォローアップチャット
cavendish deep-research --chat <chat-id> "追加の質問"

# Google Driveファイル添付
cavendish deep-research --gdrive "document.pdf" "このファイルを分析して"

# GitHubリポジトリ連携
cavendish deep-research --github "owner/repo" "このリポジトリをレビューして"
```

### 4.4 チャット管理系

```bash
# チャット一覧
cavendish list

# チャット読み取り
cavendish read <chat-id>

# チャット削除
cavendish delete <chat-id>

# プロジェクトチャット削除
cavendish delete <chat-id> --project "Project Name"

# チャットのアーカイブ
cavendish archive <chat-id>

# チャットをプロジェクトに移動
cavendish move <chat-id> --project "Project Name"
```

### 4.5 プロジェクト系

```bash
# プロジェクト一覧
cavendish projects

# プロジェクト内のチャット一覧
cavendish projects --name "For-Agents" --chats
```

### 4.6 出力オプション（全コマンド共通）

```bash
--format text     # プレーンテキスト
--format json     # 構造化出力（デフォルト、メタデータ含む）
--stream          # NDJSONストリーミング出力
--timeout 120     # 秒数指定（デフォルト: 120秒）
--quiet           # 進捗表示なし
--dry-run         # 実行せず引数検証のみ
```

---

## 5. モジュール設計

### 5.1 BrowserManager

責務：Chromeの起動・接続・プロファイル管理

- `spawn()`: 専用プロファイルでChromeをheadedモードで起動（detached spawn + CDP connect）
- `connect()`: CDP経由で起動済みChromeに接続（最大3回リトライ）
- `getPage()`: ChatGPTのタブを取得、なければ新規作成
- `close()`: ブラウザを終了

設計方針：CLIの呼び出しごとにChromeを起動・終了するとオーバーヘッドが大きいため、Chromeプロセスを常駐させ（detached spawn）、以降は `connect()` でCDP経由で接続する。

- Chromeプロファイル: `~/.cavendish/chrome-profile/`
- CDPエンドポイント: `~/.cavendish/cdp-endpoint.json`

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
- `attachGoogleDriveFile(name)`: Google DriveファイルをPicker経由で添付
- `attachGitHubRepo(repo)`: GitHubリポジトリを連携
- `enableAgentMode()`: エージェントモードを有効化
- `setThinkingEffort(level)`: Thinking effort levelを設定
- `getMostRecentChatId()`: 最新のチャットIDを取得
- `clickDeepResearchStart()`: Deep Research開始ボタンをクリック
- `waitForDeepResearchReport()`: Deep Researchレポート完了を待機
- `exportDeepResearch(method)`: Deep Researchレポートをエクスポート

すべての操作はセレクタベースで行い、スクリーンショットは使用しない。

### 5.3 OutputHandler

責務：結果の整形と出力

- `text(response)`: プレーンテキスト出力
- `json(response, metadata)`: 構造化出力（model, chatId, url, project, timeoutSec, partial, timestamp）
- `emitChunk(content)`: NDJSONチャンクイベント
- `emitState(state)`: NDJSONステートイベント
- `emitFinal(content, metadata)`: NDJSON最終イベント
- `failStructured(error)`: 構造化エラー出力（stderr）

### 5.4 データ保存先

- Chromeプロファイル: `~/.cavendish/chrome-profile/`
- CDPエンドポイント: `~/.cavendish/cdp-endpoint.json`

### 5.5 ErrorHandler (errors.ts)

責務：構造化エラーハンドリング

- エラーカテゴリ: `cdp_unavailable`(2), `chrome_not_found`(3), `auth_expired`(4), `cloudflare_blocked`(5), `selector_miss`(6), `timeout`(7), `unknown`(1)
- `CavendishError`: カテゴリ・終了コード・推奨アクション付きエラー
- `classifyError()`: 汎用Errorをカテゴリに自動分類
- `--format json`時: stderrに構造化JSONエラーを出力

### 5.6 DoctorChecks (doctor.ts)

責務：統合診断

- 9つの診断項目: `chrome_cdp`, `profile_dir`, `config_file`, `browser_connect`, `cloudflare`, `auth_status`, `prompt_textarea`, `model_picker`, `gdrive_picker`
- pass/fail/skip ステータス
- `--json`で機械可読な診断結果出力

---

## 6. セレクタ定義

すべてのセレクタは `src/constants/selectors.ts` に集約管理されている。ChatGPTのUI更新で変更される可能性があるため、インラインでのセレクタ記述は禁止。

現在70以上のセレクタが14カテゴリに分類されている：

- **Input**: プロンプト入力欄、送信ボタン
- **Model Selection**: モデルセレクター、メニュー項目
- **File Attachment**: ファイルinput、添付ボタン、添付タイル
- **Messages**: アシスタント/ユーザーメッセージ
- **Response Completion**: コピーボタン、停止ボタン、フィードバック
- **Thinking Effort**: 思考レベル設定
- **Chat Management**: チャットリンク、新規チャット
- **Projects**: プロジェクトリンク、プロジェクトチャット
- **Composer + Menu**: コンポーザーメニュー、メニュー項目
- **Google Drive**: Driveピッカー、検索、ファイル選択
- **Deep Research**: DRアプリ、iframe、エクスポート
- **GitHub Integration**: GitHubメニュー、リポジトリ選択
- **Agent Mode**: エージェントモード切り替え
- **Auth/Cloudflare Detection**: ログイン検知、Cloudflareチャレンジ

※ すべてのセレクタは日本語/英語のバイリンガル対応（i18nサポート）。

---

## 7. エラーハンドリング方針

| カテゴリ | 終了コード | 対処 |
|---|---|---|
| `cdp_unavailable` | 2 | `cavendish init` を案内 |
| `chrome_not_found` | 3 | Chrome のインストールを案内 |
| `auth_expired` | 4 | ChatGPTへの再ログインを案内 |
| `cloudflare_blocked` | 5 | 手動でCloudflareチャレンジ解決を案内 |
| `selector_miss` | 6 | UI変更の可能性。`cavendish doctor` を案内 |
| `timeout` | 7 | `--timeout` の増加またはChatGPTの応答確認を案内 |
| `unknown` | 1 | エラーメッセージの詳細を確認 |

`--format json` 時はstderrに `{ error: true, category, message, exitCode, action }` を出力。

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

- `list`, `delete` コマンド
- `projects` コマンド
- `--project`, `--continue` オプション

### Phase 4: 安定化・拡張

- Deep Researchコマンド（`deep-research`）
- Google Drive / GitHub連携
- エージェントモード（`--agent`）
- `--chat` フラグ（Deep Researchフォローアップ）
- `--dry-run` フラグ、`status` コマンド拡張
- Chromeプロセス常駐化（CDP接続、起動ごとのlaunch不要）

### Phase 5: エージェント統合強化

- `init` コマンド（Chrome セットアップ/再認証）
- `doctor` コマンド（統合診断 + `--json`）
- `status` コマンドの doctor 化
- ストリーミング出力（`--stream` / NDJSON）
- 構造化エラー出力（エラーカテゴリ・終了コード）
- `ask` の JSON 出力に chatId、url、project メタデータ追加
- `--continue` の決定性改善（chatId ベース）

---

## 9. ディレクトリ構成

```text
cavendish/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # エントリポイント (citty)
│   ├── commands/
│   │   ├── ask.ts            # ask コマンド
│   │   ├── deep-research.ts  # deep-research コマンド
│   │   ├── init.ts           # init コマンド
│   │   ├── doctor.ts         # doctor コマンド
│   │   ├── status.ts         # status コマンド
│   │   ├── list.ts           # list コマンド
│   │   ├── read.ts           # read コマンド
│   │   ├── delete.ts         # delete コマンド
│   │   ├── archive.ts        # archive コマンド
│   │   ├── move.ts           # move コマンド
│   │   └── projects.ts       # projects コマンド
│   ├── core/
│   │   ├── browser-manager.ts  # Chrome起動/CDP接続管理
│   │   ├── chatgpt-driver.ts   # DOM操作
│   │   ├── output-handler.ts   # 出力フォーマット
│   │   ├── cli-args.ts         # 共有CLI引数定義
│   │   ├── doctor.ts           # 診断ロジック
│   │   ├── errors.ts           # 構造化エラー型
│   │   └── with-driver.ts      # ドライバーライフサイクル
│   └── constants/
│       └── selectors.ts        # セレクタ定義（70+）
├── tests/
│   ├── errors.test.ts
│   ├── output-handler.test.ts
│   ├── ask-file.test.ts
│   ├── ask-stdin.test.ts
│   └── ask-chat-options.test.ts
└── docs/
    └── plan.md
```

---

## 10. 制約事項・リスク

- ChatGPTのUI更新によるセレクタ破壊は避けられないため、セレクタの集約管理と迅速な修正体制が重要
- Proモデルの応答時間は数十秒〜数分と長い。呼び出し元エージェントのタイムアウト設定と整合させる必要がある
- ChatGPTの利用規約上、自動操作がグレーゾーンである可能性を認識しておく必要がある
- Chromeプロセスの常駐はメモリを消費するため、自動終了タイマーの適切な設定が必要

---

## 付録: 検証で確認済みの技術的事実

以下は2026年2月28日時点でのChatGPT Web UIに対する実機検証の結果に基づく。セレクタは `src/constants/selectors.ts` に70以上のエントリとして管理されており、継続的に検証・更新されている。

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
- `chromium.launchPersistentContext` + `channel: 'chrome'` はCloudflare検知を誘発するため、`ignoreDefaultArgs: ['--enable-automation']` + `--disable-blink-features=AutomationControlled` で回避
- headed + 専用プロファイル構成であればbot検知リスクは最小

### API エンドポイント（参考）

- 会話: `/backend-api/conversations`, `/backend-api/f/conversation`
- ファイル: `/backend-api/files`, `/backend-api/files/process_upload_stream`
- モデル: `/backend-api/models`
- 認証: `/backend-api/accounts/check/v4-2023-04-27`
- Sentinel: `/backend-api/sentinel/chat-requirements/prepare`, `finalize`, `ping`
