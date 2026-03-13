### 0. 前提確認
- 参照した一次情報: `src/index.ts:21-40`, `src/commands/ask.ts:380-480`, `src/commands/deep-research.ts:333-410`, `src/core/with-driver.ts:21-69`, `src/core/process-lock.ts:121-188`, `src/core/output-handler.ts:22-147`, `src/commands/read.ts:66-81`, `README.md:175-181`, `README.md:163-171`, `issue #161`
- 不足/矛盾:
  - `BrowserManager` には「parallel commands don't conflict」というコメントがある一方で、`ProcessLock` は並列実行を禁止している。`src/core/browser-manager.ts:152-154`, `src/core/process-lock.ts:141-161`
  - issue #161 は通知チャネルを要求しているが、現状の `OutputHandler` は stdout/stderr のみで、持続的な通知 sink は存在しない。`src/core/output-handler.ts:22-147`

### 1. 依頼内容の解釈（引用）
- 「worktreeをissue-160, 161に対応したものを作成し、それぞれ対応してください。開発サイクルは遵守するように。」
- issue #161 のスコープは、長時間の `ask` / `deep-research` を `--detach` で非同期ジョブ化し、完了通知と永続化された job 状態を追加すること。

### 2. 変更対象（ファイル:行）
- `src/commands/ask.ts:1` 付近
- `src/commands/deep-research.ts:1` 付近
- `src/index.ts:1` 付近
- `src/core/cli-args.ts:1` 付近
- `src/core/output-handler.ts:1` 付近
- `README.md:1` 付近
- `src/commands/jobs.ts:1 (新規)`
- `src/core/jobs/types.ts:1 (新規)`
- `src/core/jobs/store.ts:1 (新規)`
- `src/core/jobs/request-builders.ts:1 (新規)`
- `src/core/jobs/submit.ts:1 (新規)`
- `src/core/jobs/worker.ts:1 (新規)`
- `src/core/jobs/notifier.ts:1 (新規)`
- `tests/jobs-*.test.ts:1 (新規)`
- `tests/ask-*.test.ts:1` 付近
- `tests/deep-research-*.test.ts:1` 付近

### 3. 作業項目と工数（コーディングエージェント作業のみ）
- detached job の最小アーキテクチャ設計と estimation 整備: 30分
- `JobStore` / request builder / submit / worker / notifier 実装: 120分
- `ask` / `deep-research` / `jobs` CLI 統合: 90分
- README 更新: 20分
- 単体テスト / 統合寄りテスト追加: 120分
- review 用の差分整理とセルフチェック: 30分

### 4. DB 影響
- N/A（DBなし）

### 5. ログ出力
- `jobs` worker の submit / start / complete / fail を job artifact と stderr に記録する可能性あり。具体箇所は新規 `src/core/jobs/worker.ts:1 (新規)` と `src/core/jobs/notifier.ts:1 (新規)`

### 6. I/O 一覧
- ファイル読み込み/書き込み:
  - `~/.cavendish/jobs/<job-id>/job.json`
  - `~/.cavendish/jobs/<job-id>/events.ndjson`
  - `~/.cavendish/jobs/<job-id>/result.json`
  - 任意の `--notify-file <path>`
- ネットワーク通信:
  - 既存の ChatGPT Web UI / Chrome CDP 接続
- DB I/O:
  - N/A
- 外部プロセス/CLI:
  - detached worker 起動のために同一 CLI を child process として spawn
- ユーザー入力:
  - 既存の CLI 引数と stdin
- クリップボード/OS連携:
  - Deep Research の既存 `--export` 経路のみ。今回の MVP では追加しない

### 7. リファクタ候補（必須）
- `ask.ts` と `deep-research.ts` の detached submit 分岐は request builder に切り出すべき
- `withDriver()` は同期コマンド用のまま残し、job worker 用ライフサイクルは別モジュールに分離するべき
- `OutputHandler` の NDJSON 形式は再利用し、job event 永続化は別モジュールへ逃がすべき

### 8. フェイズ分割
- 分割あり。理由: issue #161 は機能範囲が広く、同期 CLI の挙動維持と detached job 追加を同時に崩さないため
- Phase 1:
  - `JobStore` / worker / `--detach` / `jobs status|wait|list` / `--notify-file`
  - `ask` / `deep-research` の既存 foreground 挙動は維持
  - 新規/変更 lines は対応テストでカバー
- Phase 2:
  - 通知チャネルの拡張（webhook / command 等）
  - さらなる event-driven 化

### 9. テスト計画
- 実行予定:
  - `npm test -- jobs 関連の新規テスト`
  - `npm test -- ask/deep-research の detach 追加テスト`
  - `npm test -- 既存 cleanup/lock/read 周辺テスト`
- 実行コマンドは最終的に `npx vitest run ...` で対象を列挙する
- 実行できない場合は理由を明示する

### 10. 矛盾点/不明点/確認事項
- docs/code 矛盾:
  - `parallel commands` コメントと `ProcessLock` の排他が不整合。実装では `ProcessLock` を正として worker-only lock に寄せる
- 未確定事項:
  - 通知チャネルの MVP を `--notify-file` にするか `--notify-webhook` にするか。最小変更のため前者で進める

### 11. 変更しないこと
- 既存の foreground `ask` / `deep-research` の基本 UX は変えない
- Chrome/CDP 接続方式そのものは変えない
- ProcessLock を外して並列 UI 実行はしない
- Deep Research の待機ロジック自体は全面リライトしない
