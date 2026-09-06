---
name: triage
description: "GitHub Issue・PRを低トークンでトリアージする。Issue/PR番号、優先度、対応判断、外部PRの受入基準を扱う。PRはReadiness、CI、CodeRabbitを先に確認し、未通過ならdiffを読まず終了。通過後は製品判断に絞り、取り込み依頼時はCodex側で修正・検証してマージする。"
---

# Issue / PR Triage

番号からIssueまたはPRを判定し、対応判断に必要な最小限の調査を行う。

```text
/triage 42
/triage #8
/triage #8 --force  # CodeRabbit障害や緊急時のメンテナ例外
```

## 原則

- PRでは必ずReadiness判定を最初に行う。
- ReadyでないPRのdiff、全コメント、コードベースを読まない。
- CodeRabbitの指摘を再レビューせず、製品判断・設計・高リスク箇所に集中する。
- 品質基準は `CONTRIBUTING.md` と `.coderabbit.yaml`。AI利用や文章の雰囲気ではなく、スコープ、実装の必要性、検証証拠で判断する。
- Codexフェーズでは投稿者へRequest Changesや修正ラリーを返さない。取り込めるならこちらで直し、費用対効果が悪ければ見送る。
- サブエージェントはMedium/High以上で独立した調査面がある場合だけ使う。
- `--force`時は、バイパスした条件と理由をレポートする。
- `/triage <number>`単独は判断を返す。取り込み・マージまで依頼済みなら修正、検証、マージまで進め、同じ許可を再確認しない。コメント投稿は明示依頼がある場合だけ行う。

## Phase 0: 種別判定

共通のIssue APIで種別を判定する。APIエラーをPR扱いしない。PR判定前にコメントを取得しない。

```bash
gh api "repos/{owner}/{repo}/issues/<number>" \
  --jq '{number,title,body,labels:[.labels[].name],state,author:.user.login,isPR:(.pull_request != null)}'
# PRの場合だけ追加取得。bodyは再取得しない。
gh pr view <number> --json number,isDraft,changedFiles,additions,deletions,headRefOid,reviewDecision,statusCheckRollup
```

Issueなら「Issueフロー」、PRなら「PRフロー」へ進む。

## PRフロー

### Phase 1: Intake / Ready判定

このPhaseではPR本文、件数、ラベル、チェック状態だけを見る。ファイル内容や全diffは取得しない。

次を順番に確認する。

1. **ファイル数**
   - 1〜50: 通常
   - 51〜150: 関連Issue / Prompt Requestと分割不能理由を必須とする
   - 150超: `NOT READY`。Size以外のgateは判定せず、分割依頼とクローズだけを推奨して、ここで終了する
2. **Draft**: Draftなら`NOT READY`
3. **品質保留**: `status:quality-hold`があれば`NOT READY`として終了。CodeRabbitのSlop検出ラベルをReadinessが停止条件にする。訂正後・誤検出時の解除はメンテナが行う。自動クローズやAI利用だけを理由とした拒否はしない。
4. **レビュー基盤**: 外部PRが`.coderabbit.yaml`、`.github/workflows/**`、PRテンプレート、PR Readiness checker、エージェント指示・設定を変更する場合、メンテナの`review:override`がなければ`NOT READY`
5. **PR本文**: テンプレートの必須欄とAuthor Checklistを確認する。10ファイル以下かつ低リスクでは、補足理由、対象外、分割計画、手動検証、platformはReadiness上の助言項目。OS依存の変更では対象環境の検証証拠を必須とする。
6. **UI証拠**
   - レイアウト・外観・操作変更: Before / Afterとdevice/platformを必須とする
   - 新規UI: Beforeは`N/A — 理由`を許可する
   - 文言のみ: 成功した `flutter test ...` のコマンド・結果と画像不要理由で代替可能
   - mobile UI領域の非表示変更: スクリーンショット不要理由を必須とする
7. **PR Readiness status**: 最新head commitで成功していることを確認する
8. **CI**: `Test` workflowが成功していることを確認する
9. **CodeRabbit**: 最新headのレビュー完了と明示的なApprove、未解決Request Changesなしを必須とする。`Review completed`や緑のstatusだけでは不足。
10. **Ready label**: `ready-for-maintainer-review`が付いていることを確認する

必要ならレビュー状態だけを小さく取得する。本文は取得しない。

```bash
gh pr view <number> --json files --jq '[.files[].path]'
gh pr view <number> --json statusCheckRollup --jq '.statusCheckRollup'
gh api "repos/{owner}/{repo}/pulls/<number>/reviews?per_page=100" --paginate \
  --jq '[.[] | {author: .user.login, state, commitId: .commit_id, submittedAt: .submitted_at}]'
```

自動Readinessが成功していても、CodeRabbit walkthroughの設定済み必須チェックが未実行、Inconclusive、無断でignoredなら通常のReadyとして扱わない。詳細な指摘の再レビューは不要。利用プラン・障害でチェックできない場合は基盤の問題として報告し、投稿者に同じ修正を繰り返させない。

いずれかが未通過なら、次の短い形式で終了する。diff取得、既存コード調査、サブエージェント起動を禁止する。

150ファイル超では次の最小形式を使う。投稿者へCI、CodeRabbit、テンプレート、Ready labelの対応を同時に求めない。Ready labelは自動化が付けるため、投稿者に手動付与を求めない。

```markdown
## PR Readiness: NOT READY — #<number> <title>

- Size: ❌ <count> files（上限150超）
- 対応: 現PRをクローズし、150ファイル以下に分割して再提出する

Size gateで終了し、他のgateとdiffは確認していません。
```

```markdown
## PR Readiness: NOT READY — #<number> <title>

| Gate | Status |
| --- | --- |
| Size | [status] |
| Quality hold | [status] |
| Template | [status] |
| UI evidence | [status] |
| CI | [status] |
| CodeRabbit | [status] |

### 投稿者に必要な対応
- [不足項目だけを列挙]

深掘りレビューはまだ実施していません。
```

`--force`、またはメンテナの理由付き`review:override`がある場合だけ未通過でもPhase 2へ進み、未通過条件を冒頭に残す。通常の取り込み修正のためにoverrideを使わない。

### Phase 2: Risk map

ReadyなPRだけ、変更ファイル名とCodeRabbitの最新walkthrough・指摘要約を確認する。Phase 1で取得済みの情報は再利用する。

```bash
gh pr view <number> --json files --jq '.files[] | {path, additions, deletions}'
# Phase 1の必須チェック確認でもこれを使い、最新のbotコメントだけ出力する。
gh api "repos/{owner}/{repo}/issues/<number>/comments?per_page=100" --paginate --slurp \
  --jq '[.[][] | select(.user.login == "coderabbitai[bot]" or .user.login == "coderabbitai") | select(.body | contains("<!-- walkthrough_start -->"))] | max_by(.updated_at) | {body,html_url}'
```

walkthroughの形式が変わった場合も最新のbot要約だけを取得し、全コメント・全レビュー本文を出力しない。製品価値が低い、合意した目的と違う、保守できないことがここで明白なら`見送り`で終了する。

変更を次のリスクに分類する。

| リスク | 例 | 深掘り方針 |
| --- | --- | --- |
| Low | docs、単純UI、既存パターン | CodeRabbitとの差分だけ確認 |
| Medium | 複数モジュール、状態管理、API拡張 | 関連patchとテストを確認 |
| High | 認証、filesystem、process、protocol、Functions | 境界と失敗経路を詳細確認 |
| Very High | release/signing、権限モデル、アーキテクチャ | メンテナ判断を優先し広く確認 |

常に高リスクとして扱うパス:

- Phase 1の「レビュー基盤」に該当する全パス（`.coderabbit.yaml`、PRテンプレート、PR Readiness checker、エージェント指示・設定）
- `.github/workflows/**`
- `packages/bridge/src/websocket.ts`
- `packages/bridge/src/*process.ts`
- `functions/**`
- `firestore.rules`, `firebase.json`
- release / patch / submit / signing関連スクリプト

### Phase 3: Targeted review

Risk mapで選んだファイルとテストから読む。REST APIのfile patchを優先し、必要な場合だけ全diffを取得する。

```bash
gh api "repos/{owner}/{repo}/pulls/<number>/files?per_page=100" --paginate --slurp \
  --jq '.[][] | select(.filename == "<selected-path>") | {filename, status, additions, deletions, patch}'

# patchが欠落・切り詰められ、判断できない場合のみ
gh pr diff <number>
```

確認観点:

- 変更の目的と実装が一致しているか
- 既存機能との重複がないか
- CodeRabbitが扱いにくい製品判断・UX・保守負荷
- テストが意図と失敗経路を担保しているか
- Bridge + Flutter間のプロトコル互換性
- 認証、許可ディレクトリ、path traversal、process cleanup、secret
- 正式サポート環境への回帰リスク

読む範囲を広げるのは未解決の具体的な疑問がある場合だけ。Lowでは目的と関連patchが一致し、既存パターン・検証証拠に問題がなければ終了する。CodeRabbitの全指摘の追認や全リポジトリ再レビューをしない。

Medium/High以上でBridgeとFlutterなど独立した調査面がある場合だけ、Exploreサブエージェントへ対象を限定して依頼する。Lowまたは単一ファイルでは使わない。

### Phase 4: PRレポート

```markdown
## Triage Report: #<number> <title>

### Review Readiness: READY / FORCED
[CI、CodeRabbit、UI証拠、override理由]

### 概要・種別・プラットフォーム
[1〜3文]

### 変更規模・リスク
- Files: [count]
- Risk: [Low / Medium / High / Very High]
- High-risk areas: [paths or none]

### 既存機能・重複
[結果]

### 主な確認結果
- [CodeRabbitと重複しない重要事項]

### 対応判断
| 観点 | 評価 |
| --- | --- |
| ユーザー価値 | [高/中/低 — 理由] |
| 取り込みコスト | [高/中/低 — 理由] |
| 回帰・保守リスク | [高/中/低 — 理由] |
| 推奨 | [直接マージ / こちらで修正してマージ / 部分取り込み / 見送り] |

### 推奨アクション
- [具体的な次の手順]
```

Lowでは「Ready根拠・目的・リスク・判断・こちらで直す点」を数行で返せばよい。形式を埋めるための追加調査をしない。

## Issueフロー

### 情報収集

- タイトル、本文、ラベル、コメントからBug / Feature / Prompt Requestを判定する。
- 再現手順、期待結果、実際の結果、環境、ログを確認する。
- 関連コードはキーワードと機能単位で絞って調査する。
- 既存機能、重複Issue、上流のClaude Code / Codex起因を確認する。

### プラットフォーム判定

- 正式サポート: メンテナが日常的に検証できる
- experimental / best-effort: Windows Bridge、macOS mobileなど
- 未サポート: 再現・修正・保守を約束しない

experimental / 未サポート環境では次を追加で見る。

- 投稿者が対象環境で検証したか
- 純粋関数や自動テストで担保できるか
- spawn、shell、filesystem、GUI、OS APIに依存するか
- 正式サポート環境へ影響するか

### 難易度

| 難易度 | 基準 | 目安 |
| --- | --- | --- |
| Low | 単一ファイル、既存パターン | 〜1時間 |
| Medium | 複数ファイル、Widget/API拡張 | 数時間 |
| High | Bridge + Flutter、protocol変更 | 1日以上 |
| Very High | アーキテクチャ、外部依存、権限モデル | 数日以上 |

### Issueレポート

```markdown
## Triage Report: #<number> <title>

### 概要・種別・プラットフォーム
[要約]

### 推奨ラベル
- [labels]

### 既存機能・重複
[結果]

### 実現難易度: [Low / Medium / High / Very High]
[根拠となるファイル、protocol変更、影響範囲]

### 対応判断
| 観点 | 評価 |
| --- | --- |
| ユーザー価値 | [高/中/低 — 理由] |
| 実装コスト | [高/中/低 — 理由] |
| リスク | [高/中/低 — 理由] |
| 推奨 | [対応 / 外部PR待ち / 保留 / 見送り] |

### 推奨アクション
- [具体的な次の手順]
```

## 種別ごとの補足

### Bug

- 再現性、影響範囲、回避策、上流起因を確認する。
- 未サポート環境で再現不能なら`needs-repro`、`needs-test`、`help wanted`を検討する。
- 実環境依存の修正は投稿者側の検証結果を必須にする。

### Feature / Prompt Request

- 方向性、ユーザー価値、代替手段、プロンプトの再現性を確認する。
- 大規模なコードPRより、Issue / Prompt Requestでの合意を優先する。

### Dependabot

- breaking changes、upstream changelog、CIを確認する。
- major updateまたは高リスク依存だけ深掘りする。

### 外部PRの取り込み

Ready通過後の担当はメンテナ / Codex。投稿者へのRequest Changes、修正依頼コメント、細かな再提出要求を選択肢にしない。事前ゲートへの対応は投稿者とCodeRabbitに任せる。

- 小規模、Ready、規約準拠: 直接マージ候補
- 目的に合い、残作業と検証方法が具体的: こちらで修正してマージ。命名・小さな設計調整・不足テスト・競合解消はまとめて処理する
- 一部だけ有用: 小さなメンテナブランチに部分取り込みして検証する
- 価値より修正・検証・継続保守の負担が大きい、目的不一致、対象環境で検証不能: 見送り。救済のための全面再実装や無期限の修正を始めない

取り込みまで依頼されている場合:

1. 対象head SHAを記録し、隔離したブランチ / worktreeで修正する。forkの更新権限がなければメンテナブランチへ取り込み、投稿者への依頼待ちにしない。
2. 必要な修正を一度にまとめ、変更領域に応じた検証とセルフレビューを行う。修正でReadyが外れても対応担当はCodexのまま。
3. 実際にマージするブランチの最新headでCI、CodeRabbit、必要なUI証拠を再確認する。古いApproveを流用せず、リモートheadが変わったら差分を確認する。
4. マージ依頼があれば検証済みheadに限定してマージする。別PRで取り込んだ場合の元PRのクローズは取り込みの完了処理として行い、コメントは明示依頼時だけ投稿する。

CodeRabbitの `approve` / トップレベルの `resolve` コマンドはレビュー完了や必須チェックを迂回し得るため、通常の通過手段に使わない。

投稿者のコードを部分取り込みまたは再実装した場合は`Co-authored-by`でクレジットし、取り込んだ点と調整点をコミット / PR説明に残す。

```bash
gh api users/<username> --jq '.name, .email, .id'
```

公開メールがなければ`<id>+<username>@users.noreply.github.com`を使う。

## コメント言語と投稿

- 英語の投稿には英語だけで返信する。
- 英語以外には元の言語を先に書き、`---`の後に英語を付ける。
- 複数段落は一時ファイルを`--body-file`で渡す。
- 投稿後に取得し直し、Markdownを確認する。

```bash
gh pr comment <number> --body-file /tmp/ccpocket-pr-comment.md
gh issue comment <number> --body-file /tmp/ccpocket-issue-comment.md
```
