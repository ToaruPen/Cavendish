### 0. 前提確認
- 参照した一次情報: `README.md:163-171`, `src/commands/delete.ts:12-32`, `src/commands/deep-research.ts:11-30`, `docs/plan.md:209-215`, issue `#160`
- 不足/矛盾:
  - issue 本文には「README lists `--format` as a common option for all commands」とあるが、現時点の README は `ask, deep-research, list, read, projects` に限定されており、`delete` は含まれていない。`README.md:167`, `src/commands/delete.ts:12-23`
  - したがって、issue #160 のうち `delete --format` は現時点では docs/code 矛盾として再現しない。残る実作業は Deep Research timeout のドキュメント整備と解釈する。

### 1. 依頼内容の解釈（引用）
- 「issue #160『Test findings: delete --format unsupported, DR timeout』に対応」「最小修正を優先」
- 現在のリポジトリ事実に合わせると、`delete --format` はすでに README 側で解消済みのため、Deep Research timeout の注意書きを追加する最小修正で進める。

### 2. 変更対象（ファイル:行）
- `README.md:110` 付近

### 3. 作業項目と工数（コーディングエージェント作業のみ）
- issue 現況確認と docs/code 矛盾整理: 15分
- README の Deep Research timeout 注意書き追加: 10分
- 最低限の確認と差分レビュー: 10分

### 4. DB 影響
- N/A（DBなし）

### 5. ログ出力
- N/A（ログ変更なし）

### 6. I/O 一覧
- ファイル読み込み:
  - `README.md`
  - `src/commands/delete.ts`
  - `src/commands/deep-research.ts`
  - `docs/plan.md`
- ファイル書き込み:
  - `README.md`
- ネットワーク通信:
  - N/A
- DB I/O:
  - N/A
- 外部プロセス/CLI:
  - 必要なら `npm test` 等
- ユーザー入力:
  - N/A
- クリップボード/OS連携:
  - N/A

### 7. リファクタ候補（必須）
- 不要。issue 現況では docs 追加が最小変更であり、コード変更や構造変更を要しないため。

### 8. フェイズ分割
- 分割なし。README の単一修正で完了させる。
- このフェイズでテスト全緑を維持する。docs-only のため、必要最小限の確認で済ませる。

### 9. テスト計画
- docs-only 修正のため、必須の実行テストはなし
- 必要なら `npm test` を実行可能だが、コード未変更のため今回は差分確認を優先

### 10. 矛盾点/不明点/確認事項
- issue #160 の `delete --format` 指摘は、現時点の `README.md:167` と `src/commands/delete.ts:12-23` では矛盾として成立しない
- したがって本対応では Deep Research timeout のドキュメント追加のみ行う

### 11. 変更しないこと
- `delete` コマンドに `--format` を追加しない
- Deep Research の timeout ロジックそのものは変更しない
- `docs/plan.md` の既存仕様記述は変えない
